'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://hgqtanlzajogxrfbchrl.supabase.co';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createBusinessIntelligenceRouter, parseFilters } = require('../src/routes/business-intelligence');

function queryMock() {
  const calls = [];
  const query = {
    calls,
    select(fields, options) { calls.push(['select', fields, options]); return this; },
    or(value) { calls.push(['or', value]); return this; },
    eq(field, value) { calls.push(['eq', field, value]); return this; },
    gte(field, value) { calls.push(['gte', field, value]); return this; },
    lte(field, value) { calls.push(['lte', field, value]); return this; },
    order(field, options) { calls.push(['order', field, options]); return this; },
    range(from, to) { calls.push(['range', from, to]); return this; },
    then(resolve, reject) {
      return Promise.resolve({
        data: [{ cnpj: '00000000000001', legal_name: 'Empresa Teste', has_phone: true, has_email: true }],
        count: 51,
        error: null
      }).then(resolve, reject);
    }
  };
  return query;
}

async function fixture() {
  const queries = [];
  const client = { from(table) { assert.equal(table, 'companies'); const query = queryMock(); queries.push(query); return query; } };
  const auth = (req, res, next) => req.headers.authorization === 'Bearer valid'
    ? next()
    : res.status(401).json({ ok: false, error: 'Token de acesso obrigatório.' });
  const app = express();
  app.use(createBusinessIntelligenceRouter({ getClient: () => client, auth }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { queries, baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function get(baseUrl, query, authenticated = true) {
  const response = await fetch(`${baseUrl}/api/business-intelligence/companies?${query}`, {
    headers: authenticated ? { authorization: 'Bearer valid' } : {}
  });
  return { status: response.status, body: await response.json() };
}

test('supports the initial search filters and database pagination', async (t) => {
  const ctx = await fixture();
  t.after(ctx.close);
  const cases = [
    'city_name=São%20Paulo&state=SP',
    'city_name=Rio%20de%20Janeiro&state=RJ',
    'mei_opt_in=true',
    'simples_opt_in=true',
    'share_capital_min=10000&share_capital_max=50000',
    'q=Empresa%20Teste',
    'segment=technology',
    'company_type=headquarters',
    'opened_year=2024',
    'page=1&limit=25',
    'page=2&limit=25'
  ];
  for (const query of cases) {
    const result = await get(ctx.baseUrl, query);
    assert.equal(result.status, 200, query);
    assert.equal(result.body.ok, true, query);
    assert.equal(result.body.pagination.total, 51, query);
  }
  assert.deepEqual(ctx.queries.at(-1).calls.find((call) => call[0] === 'range'), ['range', 25, 49]);
  assert.ok(ctx.queries.some((query) => query.calls.some((call) => call[0] === 'or' && call[1] === 'primary_cnae_code.like.62%,primary_cnae_code.like.63%')));
  assert.ok(ctx.queries.some((query) => query.calls.some((call) => call[0] === 'or' && call[1].includes('headquarters_or_branch.ilike.%matriz%'))));
  assert.ok(ctx.queries.some((query) => query.calls.some((call) => call[0] === 'gte' && call[1] === 'opened_at' && call[2] === '2024-01-01')));
  assert.deepEqual(ctx.queries.at(-1).calls.filter((call) => call[0] === 'order')[0], ['order', 'opened_at', { ascending: false, nullsFirst: false }]);
});

test('never selects or returns contact fields', async (t) => {
  const ctx = await fixture();
  t.after(ctx.close);
  const result = await get(ctx.baseUrl, 'page=1');
  const selected = ctx.queries[0].calls.find((call) => call[0] === 'select')[1].split(',');
  assert.equal(selected.includes('phone_1'), false);
  assert.equal(selected.includes('phone_2'), false);
  assert.equal(selected.includes('email'), false);
  assert.equal(Object.hasOwn(result.body.companies[0], 'phone_1'), false);
  assert.equal(Object.hasOwn(result.body.companies[0], 'phone_2'), false);
  assert.equal(Object.hasOwn(result.body.companies[0], 'email'), false);
});

test('rejects unauthenticated requests before querying business data', async (t) => {
  const ctx = await fixture();
  t.after(ctx.close);
  const result = await get(ctx.baseUrl, 'page=1', false);
  assert.equal(result.status, 401);
  assert.equal(ctx.queries.length, 0);
});

test('validates limits, booleans, ranges and search syntax', () => {
  assert.equal(parseFilters({ limit: '100' }).limit, 100);
  assert.throws(() => parseFilters({ limit: '101' }), /limit inválido/);
  assert.throws(() => parseFilters({ page: '1000001' }), /page inválido/);
  assert.throws(() => parseFilters({ mei_opt_in: 'maybe' }), /mei_opt_in inválido/);
  assert.throws(() => parseFilters({ opened_at_start: '2026-02-01', opened_at_end: '2026-01-01' }), /Intervalo de abertura/);
  assert.throws(() => parseFilters({ share_capital_min: '20', share_capital_max: '10' }), /Intervalo de capital/);
  assert.throws(() => parseFilters({ q: 'Empresa),state.eq.SP' }), /Busca inválido/);
  assert.throws(() => parseFilters({ segment: 'unknown' }), /segment inválido/);
  assert.throws(() => parseFilters({ company_type: 'unknown' }), /company_type inválido/);
  assert.throws(() => parseFilters({ opened_year: '1899' }), /opened_year inválido/);
});
