const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const { getAdminFinancial } = require('../services/admin-financial');

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

module.exports = router;
