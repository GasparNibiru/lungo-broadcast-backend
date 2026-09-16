'use strict';
process.env.SUPABASE_URL = 'https://hgqtanlzajogxrfbchrl.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'local-test-only';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { createService, parseFilters } = require('../src/modules/prospecting/service');
const { createOpaqueIds } = require('../src/modules/prospecting/privacy');
const { createProspectingRouter } = require('../src/routes/prospecting');
const { createBusinessIntelligenceRouter } = require('../src/routes/business-intelligence');
const { createBusinessIntelligenceV2Router } = require('../src/routes/business-intelligence-v2');
let db, server, base, user, supervisor, other;
let outage = false, rpcCalls = [];
const opaque = createOpaqueIds(crypto.randomBytes(32));
const catalog = Array.from({ length: 120 }, (_, i) => ({ cnpj: String(i + 1).padStart(14, '0'), trade_name: `Empresa ${i}`, legal_name: 'Empresa sintética', mobile_1: '11999999999', mobile_2: '11988888888', email: 'fixture@example.invalid', category: i % 2 ? 'Saúde' : 'Tecnologia, Software e Comunicação', cnae: i % 2 ? '8600001' : '6201501', opened_year: 2026, company_size: 'MICROEMPRESA', city: 'São Paulo', state: i < 60 ? 'SP' : 'RJ', nested: { phone: '11999999999' } }));
function catalogClient(legacy = false) {
  return { from() {
    let data = catalog.map(r => legacy ? { ...r, phone_1: r.mobile_1, phone_2: r.mobile_2, city_name: r.city, primary_cnae_code: r.cnae } : r), offset = 0, end = data.length - 1;
    return { select() { return this; }, eq(k, v) { data = data.filter(r => r[k] === v); return this; }, gte(k, v) { data = data.filter(r => r[k] >= v); return this; }, lte(k, v) { data = data.filter(r => r[k] <= v); return this; }, in(k, vs) { data = data.filter(r => vs.includes(r[k])); return this; }, order() { return this; }, range(a, b) { offset = a; end = b; return this; }, then(resolve, reject) { return Promise.resolve({ data: data.slice(offset, end + 1), count: data.length }).then(resolve, reject); } };
  } };
}
const operational = {
  async rpc(name, args) {
    rpcCalls.push({ name, args });
    if (outage) return { error: { message: 'offline' } };
    try {
      const values = Object.values(args).map(v => Array.isArray(v) ? JSON.stringify(v) : v);
      return { data: (await db.query(`SELECT public.${name}(${values.map((_, i) => '$' + (i + 1)).join(',')}) AS result`, values)).rows[0].result };
    } catch (e) { return { error: { message: e.message } }; }
  },
  from(table) {
    assert.equal(table, 'prospecting_user_companies');
    let owner, cnpjs, offset = 0, end = 10000;
    return { select() { return this; }, eq(k, v) { assert.equal(k, 'user_id'); owner = v; return this; }, in(k, v) { assert.equal(k, 'cnpj'); cnpjs = v; return this; }, order() { return this; }, range(a, b) { offset = a; end = b; return this; }, async then(resolve, reject) {
      try {
        if (outage) return resolve({ error: { message: 'offline' } });
        let rows = (await db.query('SELECT c.id,c.user_id,c.cnpj,c.acquired_at,to_jsonb(s) AS snapshot FROM prospecting_user_companies c JOIN prospecting_company_snapshots s ON s.id=c.snapshot_id WHERE c.user_id=$1 ORDER BY c.acquired_at DESC,c.id', [owner])).rows;
        if (cnpjs) rows = rows.filter(r => cnpjs.includes(r.cnpj));
        return resolve({ data: rows.slice(offset, end + 1), count: rows.length });
      } catch (e) { return reject(e); }
    } };
  }
};
const service = createService({ getOperational: () => operational, getCatalog: () => catalogClient(), getOpaque: () => opaque });
async function makeUser(role = 'broker') {
  const id = crypto.randomUUID(), org = crypto.randomUUID();
  await db.query('INSERT INTO organizations(id) VALUES($1)', [org]);
  await db.query('INSERT INTO users(id,organization_id,role) VALUES($1,$2,$3)', [id, org, role]);
  return { id, role };
}
function auth(req, res, next) {
  req.accessUser = { broker: user, supervisor, other, admin: { id: user.id, role: 'admin_master' } }[req.headers['x-access-token']];
  if (!req.accessUser) return res.status(401).json({ ok: false });
  next();
}
async function request(route, body, token = 'broker') {
  const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'x-access-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') };
}
function acquisition(indices, key = crypto.randomUUID(), actor = user) { return { company_ids: indices.map(i => opaque.issue(catalog[i].cnpj, actor.id, '2026-08')), idempotency_key: key }; }
before(async () => {
  db = new PGlite(); await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/prospecting.sql'), 'utf8'));
  user = await makeUser(); supervisor = await makeUser('supervisor'); other = await makeUser();
  const app = express(); app.use(express.json());
  app.use(createProspectingRouter({ service, auth }));
  app.use(createBusinessIntelligenceRouter({ auth, getClient: () => catalogClient(true), prospecting: service }));
  app.use(createBusinessIntelligenceV2Router({ auth, getClient: () => catalogClient(), prospecting: service }));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { if (server) await new Promise(r => server.close(r)); if (db) await db.close(); });
test('wallet roles, lazy renewal, no extra expiry and repeated access', async () => {
  for (const [role, allowance] of [['broker', 20], ['supervisor', 100]]) {
    const r = await request('/api/prospecting/wallet', null, role);
    assert.equal(r.status, 200); assert.equal(r.body.wallet.free_balance, allowance); assert.equal(r.body.wallet.cycle_allowance, allowance);
    assert.match(r.body.wallet.next_renewal, /-05$/); assert.equal(r.cache, 'private, no-store');
    assert.deepEqual((await request('/api/prospecting/wallet', null, role)).body, r.body);
  }
  const fresh = await makeUser(); await operational.rpc('prospecting_credit_extra', { p_user: fresh.id, p_key: 'renew-test', p_amount: 7, p_admin_reference: 'test', p_reason: 'test' });
  await db.query("UPDATE prospecting_wallets SET cycle_start=(prospecting_cycle(now())-interval '1 month')::date,free_balance=9 WHERE user_id=$1", [fresh.id]);
  const w = await service.wallet(fresh); assert.equal(w.free_balance, 20); assert.equal(w.extra_balance, 7); assert.deepEqual(await service.wallet(fresh), w);
});
test('catalog is allowlisted, masked, opaque, filtered with OR within and AND between groups', async () => {
  const q = new URLSearchParams({ state: 'SP', opened_year: '2026', company_size: 'MICROEMPRESA', page: '2', limit: '5' });
  q.append('category', 'Tecnologia, Software e Comunicação'); q.append('category', 'Saúde'); q.append('cnae', '6201501');
  const r = await request('/api/prospecting/companies?' + q);
  assert.equal(r.status, 200); assert.equal(r.body.pagination.total, 30); assert.equal(r.body.companies.length, 5);
  for (const c of r.body.companies) { assert.equal(c.is_acquired, false); assert.equal(c.selectable, true); assert.equal(c.category, 'Tecnologia, Software e Comunicação'); assert.equal(c.state, 'SP'); assert.equal(opaque.resolve(c.company_id, user.id).version, '2026-08'); }
  const serialized = JSON.stringify(r.body); for (const full of [catalog[0].email, catalog[0].mobile_1, catalog[0].mobile_2, 'nested']) assert.ok(!serialized.includes(full));
  assert.ok(!Buffer.from(r.body.companies[0].company_id, 'base64url').toString().includes('cnpj'));
});
test('individual purchase, repeat, idempotency, user identity and acquired snapshot', async () => {
  const body = acquisition([0]); body.userId = other.id; body.p_user = other.id; body.companies = [{ cnpj: 'forged' }];
  const a = await request('/api/prospecting/acquisitions', body); assert.equal(a.status, 200); assert.equal(a.body.charged, 1); assert.equal(a.body.free_balance, 19);
  assert.deepEqual((await request('/api/prospecting/acquisitions', body)).body, a.body);
  assert.equal((await request('/api/prospecting/acquisitions', acquisition([0]))).body.charged, 0);
  const clash = acquisition([1], body.idempotency_key); assert.equal((await request('/api/prospecting/acquisitions', clash)).status, 409);
  assert.equal(rpcCalls.filter(c => c.name === 'prospecting_acquire').every(c => c.args.p_user === user.id), true);
  const rows = (await request('/api/prospecting/companies?limit=2')).body.companies;
  assert.equal(rows[0].is_acquired, true); assert.equal(rows[0].email, catalog[0].email); assert.equal(rows[1].is_acquired, false);
  const mine = await request('/api/prospecting/my-companies?limit=1'); assert.equal(mine.body.companies[0].cnpj, catalog[0].cnpj); assert.ok(mine.body.companies[0].acquired_at);
  assert.equal((await request('/api/prospecting/my-companies', null, 'other')).body.pagination.total, 0);
});
test('batch atomicity, insufficient balance, free before extras and no hidden partial acquisition', async () => {
  const before = (await service.wallet(user)).total_balance;
  const r = await request('/api/prospecting/acquisitions', acquisition(Array.from({ length: 21 }, (_, i) => i + 1)));
  assert.equal(r.status, 409); assert.equal(r.body.code, 'insufficient_tokens'); assert.equal((await service.wallet(user)).total_balance, before);
  await operational.rpc('prospecting_credit_extra', { p_user: user.id, p_key: 'test-credit', p_amount: 5, p_admin_reference: 'test', p_reason: 'test' });
  const mixed = await request('/api/prospecting/acquisitions', acquisition(Array.from({ length: 21 }, (_, i) => i + 1)));
  assert.equal(mixed.status, 200); assert.equal(mixed.body.charged, 21); assert.equal(mixed.body.free_balance, 0); assert.equal(mixed.body.extra_balance, 3);
  const extra = await request('/api/prospecting/acquisitions', acquisition([22])); assert.equal(extra.body.extra_balance, 2);
  const mine = await request('/api/prospecting/my-companies?page=2&limit=10'); assert.equal(mine.body.companies.length, 10); assert.equal(mine.body.pagination.total, 23);
});
test('operational outage always masks catalog and both legacy routes; known rights unlock only owner snapshots', async () => {
  for (const route of ['/api/business-intelligence/companies', '/api/business-intelligence/companies-v2']) {
    const acquired = await request(route + '?limit=1'); assert.equal(acquired.body.companies[0].email, catalog[0].email);
    const foreign = await request(route + '?limit=1', null, 'other'); assert.notEqual(foreign.body.companies[0].email, catalog[0].email);
  }
  outage = true;
  try { for (const route of ['/api/prospecting/companies', '/api/business-intelligence/companies', '/api/business-intelligence/companies-v2']) {
    const r = await request(route + '?limit=1'); assert.equal(r.status, 200); assert.equal(r.body.ownershipUnavailable, true);
    assert.equal(r.body.companies[0].selectable, false); assert.equal(r.body.companies[0].is_acquired, false);
    for (const full of [catalog[0].cnpj, catalog[0].email, catalog[0].mobile_1]) assert.ok(!JSON.stringify(r.body).includes(full));
  } } finally { outage = false; }
});
test('rejects missing or forbidden access, invalid filters, large batches, foreign and expired opaque IDs', async () => {
  assert.equal((await request('/api/prospecting/wallet', null, 'missing')).status, 401);
  assert.equal((await request('/api/prospecting/wallet', null, 'admin')).status, 403);
  for (const q of [{ city: 'Santos' }, { city: 'São Paulo', state: 'RJ' }, { cnae: '62.or' }, { limit: '101' }, { state: ['SP','RJ'] }, { category: { bad: true } }]) assert.throws(() => parseFilters(q));
  assert.equal((await request('/api/prospecting/acquisitions', acquisition([0], undefined, other))).status, 400);
  assert.equal((await request('/api/prospecting/acquisitions', acquisition(Array(101).fill(0)))).status, 400);
  const key = crypto.randomBytes(32), old = createOpaqueIds(key, () => 1).issue(catalog[0].cnpj, user.id, '2026-08');
  assert.throws(() => createOpaqueIds(key).resolve(old, user.id));
  assert.throws(() => opaque.resolve('tampered', user.id));
});
