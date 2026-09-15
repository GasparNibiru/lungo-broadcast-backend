'use strict';
const { FIELDS, pick, masked, serverOpaque } = require('./privacy');
const { getBusinessIntelligenceSupabase } = require('../../database/business-intelligence-supabase');
const SOURCE_VERSION = '2026-08'; // companies_v2_2026_08 import; bump only when the catalog is replaced.
function assertOperationalTarget(env) {
  const environment = env.APP_ENV || env.NODE_ENV;
  const expected = environment === 'production' ? 'bnceclhjhgjfirubudwi' : environment === 'staging' ? 'hgqtanlzajogxrfbchrl' : null;
  if (!expected || env.SUPABASE_URL?.replace(/\/$/, '') !== `https://${expected}.supabase.co`) throw new Error('prospecting_operational_project_not_authorized');
}
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
  const allowed = new Set(['state','category','cnae','opened_year','company_size','page','limit']);
  if (Object.keys(q).some(k => !allowed.has(k))) throw fail('Filtro não suportado.');
  const state = multi(q.state, /^[A-Za-z]{2}$/, 2)[0]?.toUpperCase();
  if (Array.isArray(q.state) || (state && !'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ').includes(state))) throw fail('UF inválida.');
  const year = integer(q.opened_year, null, new Date().getFullYear());
  if (year && year < 1900) throw fail('Ano inválido.');
  const size = multi(q.company_size, /^[\p{L}\p{N} ._-]+$/u, 64);
  if (size.length > 1) throw fail('Porte inválido.');
  return { page: integer(q.page, 1, 1000000), limit: integer(q.limit, 25, 100), state, categories: multi(q.category, /^[\p{L}\p{N}\s,.&'()/-]+$/u, 128), cnaes: multi(q.cnae, /^\d{7}$/, 7), year, size: size[0] };
}
function applyFilters(query, f) {
  if (f.state) query = query.eq('state', f.state);
  if (f.categories.length) query = query.in('category', f.categories);
  if (f.cnaes.length) query = query.in('cnae', f.cnaes);
  if (f.year) query = query.eq('opened_year', f.year);
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
      const { data, count, error } = await getOperational().from('prospecting_user_companies').select(`id,user_id,acquired_at,snapshot:prospecting_company_snapshots(${FIELDS.join(',')})`, { count: 'exact' })
        .eq('user_id', user.id).order('acquired_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + f.limit - 1);
      if (error || !Array.isArray(data) || data.some(r => r.user_id !== user.id || !r.snapshot)) throw fail('Não foi possível consultar suas empresas.', 'operational_unavailable', 503);
      return { companies: data.map(r => ({ ...pick(r.snapshot), id: r.id, acquired_at: r.acquired_at, is_acquired: true, selectable: false })), pagination: pagination(f, count), role: user.role };
    }
  };
}
module.exports = { createService, parseFilters, applyFilters, SOURCE_VERSION, assertOperationalTarget };
