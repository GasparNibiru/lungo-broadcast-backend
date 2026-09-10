'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://hgqtanlzajogxrfbchrl.supabase.co';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const {
  PUBLIC_FIELDS,
  createBusinessIntelligenceV2Router,
  parseFilters
} = require('../src/routes/business-intelligence-v2');

function queryMock() {
  const calls = [];
  const query = {
    calls,
    select(fields, options) { calls.push(['select', fields, options]); return this; },
    eq(field, value) { calls.push(['eq', field, value]); return this; },
    order(field, options) { calls.push(['order', field, options]); return this; },
    range(from, to) { calls.push(['range', from, to]); return this; },
    then(resolve, reject) {
      return Promise.resolve({
        data: [{
          cnpj: '00000000000001', trade_name: null, legal_name: 'Empresa Teste',
          mobile_1: '5511999999999', mobile_2: null, email: null,
          category: 'Tecnologia, Software e Comunicação', cnae: '6201501',
          opened_year: 2026, company_size: 'MICROEMPRESA', city: 'São Paulo', state: 'SP'
        }],
        count: 1,
        error: null
      }).then(resolve, reject);
    }
  };
  return query;
}

async function fixture() {
  const queries = [];
  const client = {
    from(table) {
      assert.equal(table, 'companies_v2');
      const query = queryMock();
      queries.push(query);
      return query;
    }
  };
  const auth = (req, res, next) => req.headers.authorization === 'Bearer valid'
    ? next()
    : res.status(401).json({ ok: false, error: 'Token de acesso obrigatório.' });
  const app = express();
  app.use(createBusinessIntelligenceV2Router({ getClient: () => client, auth }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    queries,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function get(baseUrl, query, authenticated = true) {
  const response = await fetch(`${baseUrl}/api/business-intelligence/companies-v2?${query}`, {
    headers: authenticated ? { authorization: 'Bearer valid' } : {}
  });
  return { status: response.status, body: await response.json() };
}

test('queries only companies_v2 with the exact public fields and deterministic order', async (t) => {
  const ctx = await fixture();
  t.after(ctx.close);
  const result = await get(ctx.baseUrl, 'page=2&limit=25');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const calls = ctx.queries[0].calls;
  assert.deepEqual(calls.find((call) => call[0] === 'select'), ['select', PUBLIC_FIELDS, { count: 'exact' }]);
  assert.deepEqual(calls.filter((call) => call[0] === 'order'), [
    ['order', 'opened_year', { ascending: false }],
    ['order', 'cnpj', { ascending: true }]
  ]);
  assert.deepEqual(calls.find((call) => call[0] === 'range'), ['range', 25, 49]);
  assert.deepEqual(Object.keys(result.body.companies[0]), PUBLIC_FIELDS.split(','));
});

test('applies all approved V2 filters', async (t) => {
  const ctx = await fixture();
  t.after(ctx.close);
  const query = new URLSearchParams({
    state: 'sp', city: 'São Paulo', category: 'Tecnologia, Software e Comunicação',
    cnae: '6201501', opened_year: '2026', company_size: 'MICROEMPRESA'
  });
  const result = await get(ctx.baseUrl, query.toString());
  assert.equal(result.status, 200);
  assert.deepEqual(ctx.queries[0].calls.filter((call) => call[0] === 'eq'), [
    ['eq', 'state', 'SP'], ['eq', 'city', 'São Paulo'],
    ['eq', 'category', 'Tecnologia, Software e Comunicação'], ['eq', 'cnae', '6201501'],
    ['eq', 'opened_year', 2026], ['eq', 'company_size', 'MICROEMPRESA']
  ]);
});

test('returns 401 before querying companies_v2 when unauthenticated', async (t) => {
  const ctx = await fixture();
  t.after(ctx.close);
  const result = await get(ctx.baseUrl, 'page=1', false);
  assert.equal(result.status, 401);
  assert.equal(ctx.queries.length, 0);
});

test('validates V2 filters and pagination limits', () => {
  assert.equal(parseFilters({ limit: '100' }).limit, 100);
  assert.throws(() => parseFilters({ limit: '101' }), /limit inválido/);
  assert.throws(() => parseFilters({ state: 'XX' }), /state inválido/);
  assert.throws(() => parseFilters({ cnae: '62.or' }), /cnae inválido/);
  assert.throws(() => parseFilters({ opened_year: '1899' }), /opened_year inválido/);
  assert.throws(() => parseFilters({ category: 'x;drop table' }), /category inválido/);
});
