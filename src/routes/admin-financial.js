const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const {
  getAdminFinancial,
  getAdminFinancialCalendar,
  getCurrentMonth
} = require('../services/admin-financial');

const router = express.Router();

router.get('/api/admin/financial', requireAdmin, async (req, res) => {
  try {
    const financial = await getAdminFinancial();
    return res.status(200).json({ ok: true, ...financial });
  } catch (error) {
    console.error('[ADMIN FINANCIAL ERROR]', error.message || error);
    return res.status(500).json({ ok: false, error: 'Erro ao carregar financeiro.' });
  }
});

function isValidMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

router.get('/api/admin/financial/calendar', requireAdmin, async (req, res) => {
  const month = req.query.month === undefined ? getCurrentMonth() : req.query.month;

  if (!isValidMonth(month)) {
    return res.status(400).json({
      ok: false,
      error: 'month deve estar no formato YYYY-MM.'
    });
  }

  try {
    const calendar = await getAdminFinancialCalendar(month);
    return res.status(200).json({ ok: true, ...calendar });
  } catch (error) {
    console.error('[ADMIN FINANCIAL CALENDAR ERROR]', error.message || error);
    return res.status(500).json({ ok: false, error: 'Erro ao carregar calendário financeiro.' });
  }
});

module.exports = router;
module.exports.isValidMonth = isValidMonth;
