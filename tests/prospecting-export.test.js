'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeExportLead, processJob, runOnce } = require('../src/modules/prospecting/export-worker');
const { createService } = require('../src/modules/prospecting/service');

const rightId = crypto.randomUUID(), exportId = crypto.randomUUID(), ownerId = crypto.randomUUID(), orgId = crypto.randomUUID();
const job = { id: exportId, operation_key: crypto.randomUUID(), user_company_id: rightId, owner_user_id: ownerId, organization_id: orgId };
const right = { id: rightId, user_id: ownerId, snapshot: { cnpj: '12345678000195', legal_name: 'Empresa de Teste', mobile_1: '11987654321', email: 'teste@example.com', city: 'São Paulo', state: 'SP' } };

test('exportação repetida reutiliza o mesmo lead e preserva leads existentes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospecting-export-'));
  try {
    const file = path.join(dir, 'leads.json');
    fs.writeFileSync(file, JSON.stringify([{ id: 'existing', instanceName: 'other' }]));
    const first = writeExportLead(file, job, right, 'instance_owner');
    const second = writeExportLead(file, job, right, 'instance_owner');
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(first, second);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'existing');
    assert.equal(rows[1].prospectingRightId, rightId);
    assert.equal(rows[1].ownerUserId, ownerId);
    assert.equal(rows[1].cnpjOuPf, right.snapshot.cnpj);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('worker usa apenas direito adquirido do dono e instância do mesmo usuário/organização', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospecting-export-'));
  try {
    const clients = path.join(dir, 'clients.json'), leads = path.join(dir, 'leads.json');
    fs.writeFileSync(clients, JSON.stringify([{ accessUserId: ownerId, organizationId: orgId, instanceName: 'instance_owner', ativo: true }]));
    const db = { from() { return { select() { return this; }, eq() { return this; }, async single() { return { data: right, error: null }; } }; } };
    assert.equal(await processJob(db, job, { clients, leads }), `prospecting_${exportId}`);
    assert.equal(JSON.parse(fs.readFileSync(leads, 'utf8')).length, 1);
    const wrong = { ...right, user_id: crypto.randomUUID() };
    const badDb = { from() { return { select() { return this; }, eq() { return this; }, async single() { return { data: wrong, error: null }; } }; } };
    await assert.rejects(processJob(badDb, job, { clients, leads }), /export_right_unavailable/);
    assert.equal(JSON.parse(fs.readFileSync(leads, 'utf8')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pedido de exportação não permite direito de outro usuário', async () => {
  let rpcCalled = false, ensured = false;
  const db = { from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null, error: null }; } }; }, async rpc() { rpcCalled = true; return { data: {}, error: null }; } };
  const service = createService({ getOperational: () => db, ensureLegacy: async () => { ensured = true; } });
  await assert.rejects(service.requestExport({ id: ownerId, role: 'broker' }, 'token', { company_id: rightId }), error => error.code === 'company_not_owned');
  assert.equal(rpcCalled, false);
  assert.equal(ensured, false);
});

test('pedido repetido devolve a mesma exportação e consulta apenas o próprio dono', async () => {
  const calls = [];
  const db = {
    from(table) { return { select() { return this; }, eq() { return this; }, async maybeSingle() {
      return { data: table === 'prospecting_user_companies' ? { id: rightId, user_id: ownerId }
        : { id: exportId, owner_user_id: ownerId, status: 'exported', target_lead_id: `prospecting_${exportId}` }, error: null }; } }; },
    async rpc(name, args) { calls.push({ name, args }); return { data: { exportId }, error: null }; }
  };
  let ensures = 0;
  const service = createService({ getOperational: () => db, ensureLegacy: async () => { ensures++; } });
  const user = { id: ownerId, role: 'broker' };
  const first = await service.requestExport(user, 'token', { company_id: rightId });
  const second = await service.requestExport(user, 'token', { company_id: rightId });
  assert.deepEqual(first, second);
  assert.equal(first.status, 'exported');
  assert.equal(first.lead_id, `prospecting_${exportId}`);
  assert.equal(ensures, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.name === 'prospecting_request_export' && call.args.p_user === ownerId && call.args.p_company === rightId));
});

test('worker reivindica uma exportação e confirma o ID do lead criado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospecting-export-'));
  try {
    const clients = path.join(dir, 'clients.json'), leads = path.join(dir, 'leads.json');
    fs.writeFileSync(clients, JSON.stringify([{ accessUserId: ownerId, organizationId: orgId, instanceName: 'instance_owner', ativo: true }]));
    const calls = [];
    const db = {
      from() { return { select() { return this; }, eq() { return this; }, async single() { return { data: right, error: null }; } }; },
      async rpc(name, args) { calls.push({ name, args }); return name === 'prospecting_claim_jobs'
        ? { data: [{ ...job, lease_token: crypto.randomUUID() }], error: null }
        : { data: true, error: null }; }
    };
    await runOnce(db, { clients, leads });
    assert.equal(calls[0].name, 'prospecting_claim_jobs');
    assert.equal(calls[1].name, 'prospecting_finish_job');
    assert.equal(calls[1].args.p_outcome, 'success');
    assert.equal(calls[1].args.p_external_id, `prospecting_${exportId}`);
    assert.equal(JSON.parse(fs.readFileSync(leads, 'utf8')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
