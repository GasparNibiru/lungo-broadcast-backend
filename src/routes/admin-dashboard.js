const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const { getAdminDashboard } = require('../services/admin-dashboard');

const router = express.Router();

router.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const dashboard = await getAdminDashboard();
    return res.status(200).json({ ok: true, ...dashboard });
  } catch (error) {
    console.error('[ADMIN DASHBOARD ERROR]', error.message || error);
    return res.status(500).json({ ok: false, error: 'Erro ao carregar dashboard.' });
  }
});

module.exports = router;
