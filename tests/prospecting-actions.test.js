'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createService, parseFilters, applyFilters } = require('../src/modules/prospecting/service');

const supervisorId = crypto.randomUUID(), brokerId = crypto.randomUUID(), companyId = crypto.randomUUID(), orgId = crypto.randomUUID();
test('busca padrão fica limitada aos três anos e cinco capitais; parâmetros fora do recorte são rejeitados', () => {
  const now = new Date().getFullYear();
  const selected = [];
  const query = { in(k, v) { selected.push([k, 'in', v]); return this; }, gte(k, v) { selected.push([k, '>=', v]); return this; }, lte(k, v) { selected.push([k, '<=', v]); return this; } };
  applyFilters(query, parseFilters({}));
  assert.deepEqual(selected, [['city', 'in', ['São Paulo','Rio de Janeiro','Belo Horizonte','Curitiba','Porto Alegre']], ['opened_year', '>=', now - 2], ['opened_year', '<=', now]]);
  assert.equal(parseFilters({ opened_year: String(now - 2) }).year, now - 2);
  assert.throws(() => parseFilters({ opened_year: String(now - 3) }), e => e.code === 'year_out_of_scope');
  assert.equal(parseFilters({ city: 'Curitiba', state: 'PR' }).city, 'Curitiba');
  assert.throws(() => parseFilters({ city: 'Santos' }), e => e.code === 'city_out_of_scope');
});
test('supervisor vê somente corretores ativos da própria organização e distribui sem enviar ator do navegador', async () => {
  const calls = [];
  const db = {
    from() { return { select() { return this; }, eq() { return this; }, order() { return Promise.resolve({ data: [
      { id: brokerId, name: 'Ana', organization_id: orgId, role: 'broker', status: 'active' },
      { id: crypto.randomUUID(), name: 'Outro', organization_id: crypto.randomUUID(), role: 'broker', status: 'active' }
    ], error: null }); }, maybeSingle() { return Promise.resolve({ data: { id: supervisorId, organization_id: orgId, role: 'supervisor', status: 'active' }, error: null }); } }; },
    async rpc(name, args) { calls.push({ name, args }); return { data: { assigned: 1, charged: 0 }, error: null }; }
  };
  const service = createService({ getOperational: () => db });
  assert.deepEqual((await service.team({ id: supervisorId, role: 'supervisor' })).brokers, [{ id: brokerId, name: 'Ana' }]);
  const result = await service.assign({ id: supervisorId, role: 'supervisor' }, { company_id: companyId, broker_id: brokerId, idempotency_key: crypto.randomUUID(), actor_id: brokerId });
  assert.equal(result.assignment.charged, 0);
  assert.equal(calls[0].name, 'prospecting_assign');
  assert.equal(calls[0].args.p_supervisor, supervisorId);
  await assert.rejects(service.assign({ id: brokerId, role: 'broker' }, { company_id: companyId, broker_id: brokerId, idempotency_key: crypto.randomUUID() }), e => e.statusCode === 403);
});

test('atendimento usa versão e usuário autenticado; conflito pede recarga', async () => {
  const calls = [];
  const db = { async rpc(name, args) { calls.push({ name, args }); return { data: { interactionId: crypto.randomUUID() }, error: null }; } };
  const service = createService({ getOperational: () => db });
  await service.recordInteraction({ id: brokerId, role: 'broker' }, { company_id: companyId, idempotency_key: crypto.randomUUID(), status: 'follow_up', notes: 'Retornar amanhã', contact_at: '2026-09-15T12:00:00Z', follow_up_at: '2026-09-16T12:00:00Z', expected_version: 0, actor_id: supervisorId });
  assert.equal(calls[0].name, 'prospecting_record_interaction');
  assert.equal(calls[0].args.p_user, brokerId);
  assert.equal(calls[0].args.p_expected_version, 0);
  assert.equal(Object.hasOwn(calls[0].args, 'actor_id'), false);
  await assert.rejects(service.recordInteraction({ id: brokerId }, { company_id: companyId, idempotency_key: 'bad', status: 'contacted', notes: '', expected_version: 1 }), e => e.statusCode === 400);
  const conflict = createService({ getOperational: () => ({ async rpc() { return { error: { message: 'version_conflict' } }; } }) });
  await assert.rejects(conflict.recordInteraction({ id: brokerId }, { company_id: companyId, idempotency_key: crypto.randomUUID(), status: 'contacted', notes: '', expected_version: 1 }), e => e.code === 'version_conflict' && e.statusCode === 409);
});
