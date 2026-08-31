'use strict';

const express = require('express');
const { requireAccess } = require('../middleware/require-access');
const { getBusinessIntelligenceSupabase } = require('../database/business-intelligence-supabase');

const PUBLIC_FIELDS = [
  'cnpj', 'legal_name', 'trade_name', 'city_name', 'state', 'opened_at',
  'company_size', 'share_capital', 'primary_cnae_code', 'simples_opt_in',
  'mei_opt_in', 'headquarters_or_branch', 'has_phone', 'has_email',
  'phone_1', 'phone_2', 'email'
].join(',');
const STATES = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);
const SEGMENT_PREFIXES = Object.freeze({
  restaurants: ['561'], commerce: ['45', '46', '47'], technology: ['62', '63'],
  health: ['86'], legal: ['6911'], construction: ['41', '42', '43'],
  transport: ['49', '50', '51', '52', '53'], education: ['85'],
  finance: ['64', '65', '66'], real_estate: ['68'],
  industry: ['10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33']
});
const SAFE_SEARCH = /^[\p{L}\p{N}\s.&'/-]+$/u;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function integer(value, fallback, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw badRequest(`${name} inválido.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw badRequest(`${name} inválido.`);
  return parsed;
}

function text(value, name, maxLength, pattern = null) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = String(value).trim();
  if (!parsed || parsed.length > maxLength || (pattern && !pattern.test(parsed))) throw badRequest(`${name} inválido.`);
  return parsed;
}

function boolean(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1'].includes(normalized)) return true;
  if (['false', '0'].includes(normalized)) return false;
  throw badRequest(`${name} inválido.`);
}

function date(value, name) {
  const parsed = text(value, name, 10, /^\d{4}-\d{2}-\d{2}$/);
  if (!parsed) return null;
  const timestamp = Date.parse(`${parsed}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== parsed) throw badRequest(`${name} inválido.`);
  return parsed;
}

function money(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw badRequest(`${name} inválido.`);
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw badRequest(`${name} inválido.`);
  return parsed;
}

function parseFilters(query = {}) {
  const page = integer(query.page, 1, 'page', { min: 1, max: 1_000_000 });
  const limit = integer(query.limit, 25, 'limit', { min: 1, max: 100 });
  const search = text(query.q ?? query.search, 'Busca', 120, SAFE_SEARCH);
  const cityName = text(query.city_name, 'city_name', 120, SAFE_SEARCH);
  const state = text(query.state, 'state', 2)?.toUpperCase() || null;
  if (state && !STATES.has(state)) throw badRequest('state inválido.');
  const primaryCnaeCode = text(query.primary_cnae_code, 'primary_cnae_code', 10, /^\d+$/);
  const segment = text(query.segment, 'segment', 40, /^[a-z_]+$/);
  if (segment && !SEGMENT_PREFIXES[segment]) throw badRequest('segment inválido.');
  const companyType = text(query.company_type, 'company_type', 20, /^[a-z_]+$/);
  if (companyType && !['headquarters', 'branch'].includes(companyType)) throw badRequest('company_type inválido.');
  const openedYear = integer(query.opened_year, null, 'opened_year', { min: 1900, max: new Date().getFullYear() });
  const openedAtStart = date(query.opened_at_start, 'opened_at_start');
  const openedAtEnd = date(query.opened_at_end, 'opened_at_end');
  if (openedAtStart && openedAtEnd && openedAtStart > openedAtEnd) throw badRequest('Intervalo de abertura inválido.');
  const shareCapitalMin = money(query.share_capital_min, 'share_capital_min');
  const shareCapitalMax = money(query.share_capital_max, 'share_capital_max');
  if (shareCapitalMin !== null && shareCapitalMax !== null && shareCapitalMin > shareCapitalMax) throw badRequest('Intervalo de capital social inválido.');
  return {
    page, limit, search, cityName, state, primaryCnaeCode, segment, companyType, openedYear, openedAtStart, openedAtEnd,
    shareCapitalMin, shareCapitalMax,
    simplesOptIn: boolean(query.simples_opt_in, 'simples_opt_in'),
    meiOptIn: boolean(query.mei_opt_in, 'mei_opt_in'),
    hasPhone: boolean(query.has_phone, 'has_phone'),
    hasEmail: boolean(query.has_email, 'has_email')
  };
}

function applyFilters(query, filters) {
  let result = query;
  if (filters.search) result = result.or(`legal_name.ilike.%${filters.search}%,trade_name.ilike.%${filters.search}%`);
  if (filters.cityName) result = result.eq('city_name', filters.cityName);
  if (filters.state) result = result.eq('state', filters.state);
  if (filters.primaryCnaeCode) result = result.eq('primary_cnae_code', filters.primaryCnaeCode);
  if (filters.segment) result = result.or(SEGMENT_PREFIXES[filters.segment].map((prefix) => `primary_cnae_code.like.${prefix}%`).join(','));
  if (filters.companyType) {
    const values = filters.companyType === 'headquarters' ? ['matriz', 'headquarters'] : ['filial', 'branch'];
    result = result.or(values.map((value) => `headquarters_or_branch.ilike.%${value}%`).join(','));
  }
  if (filters.openedYear) {
    result = result.gte('opened_at', `${filters.openedYear}-01-01`).lte('opened_at', `${filters.openedYear}-12-31`);
  }
  if (filters.openedAtStart) result = result.gte('opened_at', filters.openedAtStart);
  if (filters.openedAtEnd) result = result.lte('opened_at', filters.openedAtEnd);
  if (filters.shareCapitalMin !== null) result = result.gte('share_capital', filters.shareCapitalMin);
  if (filters.shareCapitalMax !== null) result = result.lte('share_capital', filters.shareCapitalMax);
  if (filters.simplesOptIn !== null) result = result.eq('simples_opt_in', filters.simplesOptIn);
  if (filters.meiOptIn !== null) result = result.eq('mei_opt_in', filters.meiOptIn);
  if (filters.hasPhone !== null) result = result.eq('has_phone', filters.hasPhone);
  if (filters.hasEmail !== null) result = result.eq('has_email', filters.hasEmail);
  return result;
}

function createBusinessIntelligenceRouter({
  getClient = getBusinessIntelligenceSupabase,
  auth = requireAccess(['supervisor', 'broker'])
} = {}) {
  const router = express.Router();
  router.get('/api/business-intelligence/companies', auth, async (req, res) => {
    try {
      const filters = parseFilters(req.query);
      const offset = (filters.page - 1) * filters.limit;
      let query = getClient().from('companies').select(PUBLIC_FIELDS, { count: 'exact' });
      query = applyFilters(query, filters)
        .order('opened_at', { ascending: false, nullsFirst: false })
        .order('quality_score', { ascending: false })
        .order('cnpj', { ascending: true })
        .range(offset, offset + filters.limit - 1);
      const { data, count, error } = await query;
      if (error) throw error;
      const total = Number(count || 0);
      return res.json({
        ok: true,
        companies: data || [],
        pagination: { total, page: filters.page, limit: filters.limit, totalPages: Math.ceil(total / filters.limit) }
      });
    } catch (error) {
      if (error.statusCode === 400) return res.status(400).json({ ok: false, error: error.message });
      console.error('[BUSINESS INTELLIGENCE]', error.message || error);
      return res.status(500).json({ ok: false, error: 'Não foi possível consultar as empresas.' });
    }
  });
  return router;
}

module.exports = createBusinessIntelligenceRouter();
module.exports.PUBLIC_FIELDS = PUBLIC_FIELDS;
module.exports.SEGMENT_PREFIXES = SEGMENT_PREFIXES;
module.exports.applyFilters = applyFilters;
module.exports.createBusinessIntelligenceRouter = createBusinessIntelligenceRouter;
module.exports.parseFilters = parseFilters;
