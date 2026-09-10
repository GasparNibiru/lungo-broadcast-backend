'use strict';

const express = require('express');
const { requireAccess } = require('../middleware/require-access');
const { getBusinessIntelligenceSupabase } = require('../database/business-intelligence-supabase');

const PUBLIC_FIELDS = [
  'cnpj', 'trade_name', 'legal_name', 'mobile_1', 'mobile_2', 'email',
  'category', 'cnae', 'opened_year', 'company_size', 'city', 'state'
].join(',');
const STATES = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);
const SAFE_TEXT = /^[\p{L}\p{N}\s,.&'()/-]+$/u;

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

function text(value, name, maxLength, pattern = SAFE_TEXT) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = String(value).trim();
  if (!parsed || parsed.length > maxLength || (pattern && !pattern.test(parsed))) throw badRequest(`${name} inválido.`);
  return parsed;
}

function parseFilters(query = {}) {
  const page = integer(query.page, 1, 'page', { min: 1, max: 1_000_000 });
  const limit = integer(query.limit, 25, 'limit', { min: 1, max: 100 });
  const state = text(query.state, 'state', 2, /^[A-Za-z]{2}$/)?.toUpperCase() || null;
  if (state && !STATES.has(state)) throw badRequest('state inválido.');
  return {
    page,
    limit,
    state,
    city: text(query.city, 'city', 64),
    category: text(query.category, 'category', 64),
    cnae: text(query.cnae, 'cnae', 7, /^\d{1,7}$/),
    openedYear: integer(query.opened_year, null, 'opened_year', { min: 1900, max: new Date().getFullYear() }),
    companySize: text(query.company_size, 'company_size', 32)
  };
}

function applyFilters(query, filters) {
  let result = query;
  if (filters.state) result = result.eq('state', filters.state);
  if (filters.city) result = result.eq('city', filters.city);
  if (filters.category) result = result.eq('category', filters.category);
  if (filters.cnae) result = result.eq('cnae', filters.cnae);
  if (filters.openedYear) result = result.eq('opened_year', filters.openedYear);
  if (filters.companySize) result = result.eq('company_size', filters.companySize);
  return result;
}

function createBusinessIntelligenceV2Router({
  getClient = getBusinessIntelligenceSupabase,
  auth = requireAccess(['broker', 'supervisor'])
} = {}) {
  const router = express.Router();
  router.get('/api/business-intelligence/companies-v2', auth, async (req, res) => {
    try {
      const filters = parseFilters(req.query);
      const offset = (filters.page - 1) * filters.limit;
      let query = getClient().from('companies_v2').select(PUBLIC_FIELDS, { count: 'exact' });
      query = applyFilters(query, filters)
        .order('opened_year', { ascending: false })
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
      console.error('[BUSINESS INTELLIGENCE V2]', error.message || error);
      return res.status(500).json({ ok: false, error: 'Não foi possível consultar as empresas.' });
    }
  });
  return router;
}

module.exports = createBusinessIntelligenceV2Router();
module.exports.PUBLIC_FIELDS = PUBLIC_FIELDS;
module.exports.applyFilters = applyFilters;
module.exports.createBusinessIntelligenceV2Router = createBusinessIntelligenceV2Router;
module.exports.parseFilters = parseFilters;
