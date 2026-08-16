const express = require('express');
const fs = require('fs');
const path = require('path');
const supabase = require('../database/supabase');
const { requireAccess } = require('../middleware/require-access');

const router = express.Router();
const FILE = process.env.TEAM_GOALS_FILE_PATH || (process.env.NODE_ENV === 'staging' ? '/data-staging/team-goals.json' : path.resolve(__dirname, '../../data/team-goals.json'));
function load() { try { const data = JSON.parse(fs.readFileSync(FILE, 'utf8')); return data && typeof data === 'object' ? data : {}; } catch { return {}; } }
function save(data) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }

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
  const realized = monthSales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0);
  const target = req.accessUser.role === 'broker' ? (activeBrokers ? teamGoal / activeBrokers : 0) : teamGoal;
  return res.json({ ok: true, month, teamGoal, target, realized, percent: target > 0 ? Math.min(999, Math.round((realized / target) * 100)) : 0, activeBrokers });
});

router.put('/api/team/goal', requireAccess('supervisor'), (req, res) => {
  const teamGoal = Number(req.body?.teamGoal);
  if (!Number.isFinite(teamGoal) || teamGoal < 0 || teamGoal > 1000000000) return res.status(400).json({ ok: false, error: 'Informe uma meta mensal válida.' });
  const data = load(); data[req.accessUser.organizationId] = { teamGoal, updatedAt: new Date().toISOString(), updatedBy: req.accessUser.id }; save(data);
  return res.json({ ok: true, teamGoal });
});

module.exports = router;
