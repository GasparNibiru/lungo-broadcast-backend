'use strict';
const { FIELDS, pick, masked, serverOpaque } = require('./privacy');
const { getBusinessIntelligenceSupabase } = require('../../database/business-intelligence-supabase');
const SOURCE_VERSION = '2026-08'; // companies_v2_2026_08 import; bump only when the catalog is replaced.
function assertOperationalTarget(env) {
  const environment = env.APP_ENV || env.NODE_ENV;
  const expected = environment === 'production' ? 'bnceclhjhgjfirubudwi' : environment === 'staging' ? 'hgqtanlzajogxrfbchrl' : null;
  if (!expected || env.SUPABASE_URL?.replace(/\/$/, '') !== `https://${expected}.supabase.co`) throw new Error('prospecting_operational_project_not_authorized');
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPITALS = Object.freeze({
  'Rio Branco': 'AC', 'Maceió': 'AL', 'Macapá': 'AP', Manaus: 'AM', Salvador: 'BA', Fortaleza: 'CE',
  Brasília: 'DF', Vitória: 'ES', Goiânia: 'GO', 'São Luís': 'MA', Cuiabá: 'MT', 'Campo Grande': 'MS',
  'Belo Horizonte': 'MG', Belém: 'PA', 'João Pessoa': 'PB', Curitiba: 'PR', Recife: 'PE', Teresina: 'PI',
  'Rio de Janeiro': 'RJ', Natal: 'RN', 'Porto Alegre': 'RS', 'Porto Velho': 'RO', 'Boa Vista': 'RR',
  Florianópolis: 'SC', 'São Paulo': 'SP', Aracaju: 'SE', Palmas: 'TO'
});
function operationalClient() {
  assertOperationalTarget(process.env);
  return require('../../database/supabase');
}
const fail = (message, code = 'invalid_request', statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
function integer(value, fallback, max) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || +value < 1 || +value > max) throw fail('Paginação ou ano inválido.');
  return +value;
}
function multi(value, pattern, maxLength) {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (list.length > 100 || list.some(v => typeof v !== 'string' || !v.trim() || v.length > maxLength || !pattern.test(v))) throw fail('Filtro inválido.');
  return [...new Set(list.map(v => v.trim()))];
}
function parseFilters(q = {}) {
  const allowed = new Set(['state','city','category','cnae','opened_year','company_size','page','limit']);
  if (Object.keys(q).some(k => !allowed.has(k))) throw fail('Filtro não suportado.');
  const state = multi(q.state, /^[A-Za-z]{2}$/, 2)[0]?.toUpperCase();
  if (Array.isArray(q.state) || (state && !'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ').includes(state))) throw fail('UF inválida.');
  const city = q.city === undefined || q.city === '' ? null : q.city;
  if (city !== null && (typeof city !== 'string' || !Object.hasOwn(CAPITALS, city) || (state && state !== CAPITALS[city]))) throw fail('Capital ou UF inválida.', 'city_out_of_scope');
  const currentYear = new Date().getFullYear();
  const year = integer(q.opened_year, null, currentYear);
  if (year && year < currentYear - 2) throw fail('Selecione um dos últimos três anos.', 'year_out_of_scope');
  const size = multi(q.company_size, /^[\p{L}\p{N} ._-]+$/u, 64);
  if (size.length > 1) throw fail('Porte inválido.');
  return { page: integer(q.page, 1, 1000000), limit: integer(q.limit, 25, 100), state, city, categories: multi(q.category, /^[\p{L}\p{N}\s,.&'()/-]+$/u, 128), cnaes: multi(q.cnae, /^\d{7}$/, 7), year, minYear: currentYear - 2, maxYear: currentYear, size: size[0] };
}
function applyFilters(query, f) {
  if (f.state) query = query.eq('state', f.state);
  if (f.city) query = query.eq('city', f.city);
  else query = query.in('city', Object.keys(CAPITALS));
  if (f.categories.length) query = query.in('category', f.categories);
  if (f.cnaes.length) query = query.in('cnae', f.cnaes);
  if (f.year) query = query.eq('opened_year', f.year);
  else query = query.gte('opened_year', f.minYear).lte('opened_year', f.maxYear);
  if (f.size) query = query.eq('company_size', f.size);
  return query;
}
function pagination(f, count) { return { page: f.page, limit: f.limit, total: Number(count || 0), totalPages: Math.ceil(Number(count || 0) / f.limit) }; }
function createService({ getOperational = operationalClient, getCatalog = getBusinessIntelligenceSupabase, getOpaque = serverOpaque, ensureLegacy = (user, token) => require('../../services/legacy-broker-access').ensure(user, token), version = SOURCE_VERSION } = {}) {
  async function rpc(name, args) {
    const result = await getOperational().rpc(name, args);
    if (result.error) {
      const known = { insufficient_tokens: ['Saldo insuficiente para adquirir o lote completo.', 409], idempotency_key_reused: ['Esta chave já foi usada para outra aquisição.', 409], prospecting_access_denied: ['Acesso à Prospecção não permitido.', 403] };
      const match = known[result.error.message];
      if (match) throw fail(match[0], result.error.message, match[1]);
      const additional = { assignment_access_denied: ['Corretor não pertence à sua equipe.', 403], version_conflict: ['Este atendimento foi atualizado. Recarregue a empresa.', 409], company_not_owned: ['Empresa não pertence a este usuário.', 404] }[result.error.message];
      if (additional) throw fail(additional[0], result.error.message, additional[1]);
      throw fail('Não foi possível concluir a operação. Tente novamente.', 'operational_unavailable', 503);
    }
    return result.data;
  }
  async function lookupOwned(userId, cnpjs) {
    if (!userId) throw new Error('authenticated_user_required');
    if (!cnpjs.length) return new Map();
    const { data, error } = await getOperational().from('prospecting_user_companies')
      .select(`id,user_id,cnpj,acquired_at,snapshot:prospecting_company_snapshots(${FIELDS.join(',')})`).eq('user_id', userId).in('cnpj', cnpjs);
    if (error || !Array.isArray(data) || data.some(r => r.user_id !== userId || !r.snapshot || r.snapshot.cnpj !== r.cnpj)) throw new Error('ownership_unavailable');
    return new Map(data.map(r => [r.cnpj, r]));
  }
  async function project(rows, userId, legacy = false) {
    let rights = new Map(), unavailable = false, opaque;
    try { rights = await lookupOwned(userId, rows.map(r => r.cnpj)); } catch { unavailable = true; }
    try { opaque = getOpaque(); } catch { unavailable = true; }
    const companies = rows.map(row => {
      const right = rights.get(row.cnpj);
      const normalized = legacy ? { ...row, mobile_1: row.phone_1, mobile_2: row.phone_2, city: row.city_name, cnae: row.primary_cnae_code, opened_year: row.opened_at?.slice(0, 4) } : row;
      const out = right ? pick(right.snapshot) : masked(normalized);
      // V1-only companies have no acquisition identifier; only the V2 source can be bought.
      let companyId = null;
      if (!legacy && opaque) { try { companyId = opaque.issue(row.cnpj, userId, version); } catch {} }
      Object.assign(out, { company_id: companyId, is_acquired: Boolean(right), selectable: !right && !unavailable && Boolean(companyId) });
      if (legacy) Object.assign(out, { phone_1: out.mobile_1, phone_2: out.mobile_2, city_name: out.city, primary_cnae_code: out.cnae, opened_at: row.opened_at ?? null, share_capital: row.share_capital ?? null, simples_opt_in: row.simples_opt_in ?? null, mei_opt_in: row.mei_opt_in ?? null, headquarters_or_branch: row.headquarters_or_branch ?? null, has_phone: Boolean(row.has_phone), has_email: Boolean(row.has_email) });
      return out;
    });
    return { companies, ownershipUnavailable: unavailable };
  }
  return {
    project,
    async team(user) {
      if (user.role !== 'supervisor') throw fail('Somente supervisores podem distribuir empresas.', 'supervisor_required', 403);
      const { data: supervisor, error: supervisorError } = await getOperational().from('users').select('id,organization_id,role,status').eq('id', user.id).maybeSingle();
      if (supervisorError || !supervisor || supervisor.role !== 'supervisor' || supervisor.status !== 'active') throw fail('Equipe indisponível.', 'team_unavailable', 503);
      const { data, error } = await getOperational().from('users').select('id,name,organization_id,role,status').eq('organization_id', supervisor.organization_id).eq('role', 'broker').eq('status', 'active').order('name');
      if (error || !Array.isArray(data)) throw fail('Equipe indisponível.', 'team_unavailable', 503);
      return { brokers: data.filter(b => b.organization_id === supervisor.organization_id && b.role === 'broker' && b.status === 'active').map(b => ({ id: b.id, name: b.name || 'Corretor' })) };
    },
    async assign(user, body = {}) {
      if (user.role !== 'supervisor') throw fail('Somente supervisores podem distribuir empresas.', 'supervisor_required', 403);
      if (!UUID.test(body.company_id || '') || !UUID.test(body.broker_id || '') || typeof body.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(body.idempotency_key)) throw fail('Empresa, corretor ou solicitação inválida.');
      const result = await rpc('prospecting_assign', { p_supervisor: user.id, p_broker: body.broker_id, p_key: body.idempotency_key, p_company_ids: [body.company_id] });
      return { assignment: result };
    },
    async recordInteraction(user, body = {}) {
      if (!UUID.test(body.company_id || '') || typeof body.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(body.idempotency_key) || !['new','contacted','follow_up','interested','not_interested','converted'].includes(body.status) || typeof body.notes !== 'string' || body.notes.length > 10000 || !Number.isSafeInteger(body.expected_version) || body.expected_version < 0) throw fail('Dados do atendimento inválidos.');
      for (const value of [body.contact_at, body.follow_up_at]) if (value != null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw fail('Data do atendimento inválida.');
      const result = await rpc('prospecting_record_interaction', { p_user: user.id, p_company: body.company_id, p_key: body.idempotency_key, p_status: body.status, p_notes: body.notes, p_contact: body.contact_at || null, p_follow_up: body.follow_up_at || null, p_expected_version: body.expected_version });
      return { interaction: result };
    },
    async requestExport(user, token, body = {}) {
      if (!body || Object.keys(body).some(k => k !== 'company_id') || typeof body.company_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.company_id)) throw fail('Empresa adquirida inválida.');
      const { data: owned, error: ownedError } = await getOperational().from('prospecting_user_companies')
        .select('id,user_id').eq('id', body.company_id).eq('user_id', user.id).maybeSingle();
      if (ownedError) throw fail('Não foi possível verificar a empresa.', 'operational_unavailable', 503);
      if (!owned || owned.user_id !== user.id) throw fail('Empresa não encontrada em Minhas empresas.', 'company_not_owned', 404);
      await ensureLegacy(user, token);
      const result = await rpc('prospecting_request_export', { p_user: user.id, p_company: owned.id });
      if (!result?.exportId) throw fail('Não foi possível solicitar a exportação.', 'operational_unavailable', 503);
      return { export_id: result.exportId, ...await this.exportStatus(user, result.exportId) };
    },
    async exportStatus(user, exportId) {
      if (typeof exportId !== 'string' || !/^[0-9a-f-]{36}$/i.test(exportId)) throw fail('Exportação inválida.');
      const { data, error } = await getOperational().from('prospecting_lead_exports')
        .select('id,owner_user_id,user_company_id,status,target_lead_id,last_error_code').eq('id', exportId).eq('owner_user_id', user.id).maybeSingle();
      if (error) throw fail('Não foi possível consultar a exportação.', 'operational_unavailable', 503);
      if (!data || data.owner_user_id !== user.id) throw fail('Exportação não encontrada.', 'export_not_owned', 404);
      return { status: data.status, lead_id: data.status === 'exported' ? data.target_lead_id : null, error_code: data.status === 'failed' || data.status === 'unknown' ? data.last_error_code : null };
    },
    async wallet(user) {
      const w = await rpc('prospecting_get_wallet', { p_user: user.id });
      if (!w || !Number.isSafeInteger(Number(w.total))) throw fail('Saldo indisponível.', 'operational_unavailable', 503);
      const next = /^\d{4}-\d{2}-05$/.test(w.nextRenewal) ? w.nextRenewal : null;
      if (!next) throw fail('Saldo indisponível.', 'operational_unavailable', 503);
      const start = new Date(`${next}T12:00:00Z`); start.setUTCMonth(start.getUTCMonth() - 1);
      return { free_balance: Number(w.free), extra_balance: Number(w.extra), total_balance: Number(w.total), cycle_start: start.toISOString().slice(0, 10), next_renewal: next, cycle_allowance: user.role === 'supervisor' ? 100 : 20, timezone: 'America/Sao_Paulo' };
    },
    async companies(user, query) {
      const f = parseFilters(query), offset = (f.page - 1) * f.limit;
      const { data, count, error } = await applyFilters(getCatalog().from('companies_v2').select(FIELDS.join(','), { count: 'exact' }), f)
        .order('opened_year', { ascending: false }).order('cnpj', { ascending: true }).range(offset, offset + f.limit - 1);
      if (error || !Array.isArray(data)) throw fail('Catálogo indisponível. Tente novamente.', 'catalog_unavailable', 503);
      return { ...await project(data, user.id), pagination: pagination(f, count) };
    },
    async acquire(user, body = {}) {
      const ids = body.company_ids, key = body.idempotency_key;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(key)) throw fail('Selecione de 1 a 100 empresas e informe uma chave idempotente válida.');
      const resolved = ids.map(id => getOpaque().resolve(id, user.id));
      if (resolved.some(r => r.version !== version)) throw fail('O catálogo foi atualizado. Faça uma nova busca.', 'catalog_changed', 409);
      const cnpjs = [...new Set(resolved.map(r => r.cnpj))];
      const { data, error } = await getCatalog().from('companies_v2').select(FIELDS.join(',')).in('cnpj', cnpjs);
      if (error || !Array.isArray(data)) throw fail('Catálogo indisponível.', 'catalog_unavailable', 503);
      if (data.length !== cnpjs.length || new Set(data.map(r => r.cnpj)).size !== cnpjs.length || data.some(r => !cnpjs.includes(r.cnpj))) throw fail('Uma empresa não está mais disponível. Atualize a busca.', 'catalog_changed', 409);
      const result = await rpc('prospecting_acquire', { p_user: user.id, p_key: key, p_companies: data.map(pick), p_source_version: version });
      // No fallible second query after a successful debit. Client refreshes wallet and lists separately.
      return { operation_id: result.operationId, acquired_ids: result.acquiredIds, charged: result.charged, already_owned: result.alreadyOwned, free_balance: result.free, extra_balance: result.extra };
    },
    async myCompanies(user, query) {
      if (Object.keys(query).some(k => !['page','limit'].includes(k))) throw fail('Filtro não suportado.');
      const f = parseFilters(query), offset = (f.page - 1) * f.limit;
      const { data, count, error } = await getOperational().from('prospecting_user_companies').select(`id,user_id,acquired_at,service_status,notes,last_contact_at,next_follow_up_at,version,snapshot:prospecting_company_snapshots(${FIELDS.join(',')})`, { count: 'exact' })
        .eq('user_id', user.id).order('acquired_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + f.limit - 1);
      if (error || !Array.isArray(data) || data.some(r => r.user_id !== user.id || !r.snapshot)) throw fail('Não foi possível consultar suas empresas.', 'operational_unavailable', 503);
      return { companies: data.map(r => ({ ...pick(r.snapshot), id: r.id, acquired_at: r.acquired_at, service_status: r.service_status, notes: r.notes, last_contact_at: r.last_contact_at, next_follow_up_at: r.next_follow_up_at, version: r.version, is_acquired: true, selectable: false })), pagination: pagination(f, count), role: user.role };
    }
  };
}
module.exports = { createService, parseFilters, applyFilters, SOURCE_VERSION, assertOperationalTarget };
