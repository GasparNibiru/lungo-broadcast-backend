const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const { getAdminSupervisors } = require('../services/admin-supervisors');

const router = express.Router();

router.get('/api/admin/supervisors', requireAdmin, async (req, res) => {
  try {
    const supervisors = await getAdminSupervisors();
    return res.status(200).json({ ok: true, ...supervisors });
  } catch (error) {
    console.error('[ADMIN SUPERVISORS ERROR]', error.message || error);
    return res.status(500).json({ ok: false, error: 'Erro ao carregar supervisores.' });
  }
});

module.exports = router;
