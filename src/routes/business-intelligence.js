'use strict';

const express = require('express');
const { requireAccess } = require('../middleware/require-access');
const { getBusinessIntelligenceSupabase } = require('../database/business-intelligence-supabase');

const PUBLIC_FIELDS = [
  'cnpj', 'legal_name', 'trade_name', 'city_name', 'state', 'opened_at',
  'company_size', 'share_capital', 'primary_cnae_code', 'simples_opt_in',
  'mei_opt_in', 'headquarters_or_branch', 'has_phone', 'has_email'
].join(',');
const STATES = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);
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
  const openedAtStart = date(query.opened_at_start, 'opened_at_start');
  const openedAtEnd = date(query.opened_at_end, 'opened_at_end');
  if (openedAtStart && openedAtEnd && openedAtStart > openedAtEnd) throw badRequest('Intervalo de abertura inválido.');
  const shareCapitalMin = money(query.share_capital_min, 'share_capital_min');
  const shareCapitalMax = money(query.share_capital_max, 'share_capital_max');
  if (shareCapitalMin !== null && shareCapitalMax !== null && shareCapitalMin > shareCapitalMax) throw badRequest('Intervalo de capital social inválido.');
  return {
    page, limit, search, cityName, state, primaryCnaeCode, openedAtStart, openedAtEnd,
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
  auth = requireAccess()
} = {}) {
  const router = express.Router();
  router.get('/api/business-intelligence/companies', auth, async (req, res) => {
    try {
      const filters = parseFilters(req.query);
      const offset = (filters.page - 1) * filters.limit;
      let query = getClient().from('companies').select(PUBLIC_FIELDS, { count: 'exact' });
      query = applyFilters(query, filters)
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
module.exports.applyFilters = applyFilters;
module.exports.createBusinessIntelligenceRouter = createBusinessIntelligenceRouter;
module.exports.parseFilters = parseFilters;
