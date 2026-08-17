const express = require('express');
const fs = require('fs');
const path = require('path');
const supabase = require('../database/supabase');
const { requireAccess } = require('../middleware/require-access');
const legacyBrokerAccess = require('../services/legacy-broker-access');

const router = express.Router();
const FILE = process.env.TEAM_GOALS_FILE_PATH
  || (process.env.NODE_ENV === 'staging' ? '/data-staging/team-goals.json'
    : process.env.NODE_ENV === 'production' ? '/data/team-goals.json'
      : path.resolve(__dirname, '../../data/team-goals.json'));
function load() { try { const data = JSON.parse(fs.readFileSync(FILE, 'utf8')); return data && typeof data === 'object' ? data : {}; } catch { return {}; } }
function save(data) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }
function monthOf(value) { const raw = String(value || ''); return raw.length >= 7 ? raw.slice(0, 7) : ''; }
function money(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value || '').trim().replace(/[^\d,.-]/g, '');
  if (!raw) return 0;
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
function status(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
const CLOSED = new Set(['fechamento', 'fechado', 'venda', 'vendido', 'cliente', 'ganho']);

async function operationalResults(user, month) {
  const [leads, customers] = await Promise.all([
    legacyBrokerAccess.organizationLeads(user.organizationId),
    legacyBrokerAccess.organizationCustomers(user.organizationId)
  ]);
  const belongsToUser = (item) => user.role === 'supervisor' || item.brokerUserId === user.id;
  const closedLeads = leads.filter((lead) => belongsToUser(lead) && CLOSED.has(status(lead.status)) && monthOf(lead.updatedAt || lead.lastMessageAt || lead.createdAt) === month);
  const proposals = closedLeads.map((lead) => ({ amount: money(lead.valorNegocio || lead.valor || lead.valorFechado) }));

  customers.filter(belongsToUser).forEach((customer) => {
    const sourceLeadId = String(customer.sourceLeadId || '');
    // A sincronizacao de um fechamento cria o cliente correspondente; ele nao pode virar uma segunda proposta.
    if (!sourceLeadId && monthOf(customer.dataContratacao || customer.createdAt) === month) proposals.push({ amount: money(customer.valorFechado || customer.valor) });
    (Array.isArray(customer.vendasBase) ? customer.vendasBase : []).forEach((sale) => {
      if (monthOf(sale.dataVenda || sale.createdAt) === month) proposals.push({ amount: money(sale.valor || sale.valorFechado || sale.valorVenda) });
    });
  });
  return { proposals: proposals.length, realized: proposals.reduce((sum, proposal) => sum + proposal.amount, 0) };
}

router.get('/api/team/goal', requireAccess(['broker', 'supervisor']), async (req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const [brokers, sales] = await Promise.all([
    supabase.from('users').select('id', { count: 'exact', head: true }).eq('organization_id', req.accessUser.organizationId).eq('role', 'broker').eq('status', 'active'),
    supabase.from('sales').select('seller_user_id,amount,sale_date').eq('organization_id', req.accessUser.organizationId)
  ]);
  if (brokers.error || sales.error) return res.status(500).json({ ok: false, error: 'Erro ao carregar a meta mensal.' });
  const teamGoal = Math.max(0, Number(load()[req.accessUser.organizationId]?.teamGoal || 0));
  const activeBrokers = Math.max(0, Number(brokers.count || 0));
  const monthSales = (sales.data || []).filter((sale) => String(sale.sale_date || '').startsWith(month) && (req.accessUser.role === 'supervisor' || sale.seller_user_id === req.accessUser.id));
  const databaseResult = { proposals: monthSales.length, realized: monthSales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0) };
  const operational = await operationalResults(req.accessUser, month);
  const result = operational.proposals ? operational : databaseResult;
  const target = req.accessUser.role === 'broker' ? (activeBrokers ? teamGoal / activeBrokers : 0) : teamGoal;
  return res.json({ ok: true, month, teamGoal, target, realized: result.realized, proposals: result.proposals, percent: target > 0 ? Math.min(999, Math.round((result.realized / target) * 100)) : 0, activeBrokers });
});

router.put('/api/team/goal', requireAccess('supervisor'), (req, res) => {
  const teamGoal = Number(req.body?.teamGoal);
  if (!Number.isFinite(teamGoal) || teamGoal < 0 || teamGoal > 1000000000) return res.status(400).json({ ok: false, error: 'Informe uma meta mensal válida.' });
  const data = load(); data[req.accessUser.organizationId] = { teamGoal, updatedAt: new Date().toISOString(), updatedBy: req.accessUser.id }; save(data);
  return res.json({ ok: true, teamGoal });
});

module.exports = router;
