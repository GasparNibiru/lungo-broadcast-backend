const express = require('express');
const { listAdminOrganizations } = require('../services/admin-organizations');

const router = express.Router();

function requireAdminKey(req, res, next) {
  const expectedKey = String(process.env.ADMIN_ACCESS_KEY || '').trim();
  const providedKey = String(req.get('x-admin-key') || '').trim();

  if (!expectedKey) {
    return res.status(500).json({
      ok: false,
      error: 'Configuração administrativa ausente.'
    });
  }

  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({ ok: false, error: 'Não autorizado.' });
  }

  return next();
}

router.get('/api/admin/organizations', requireAdminKey, async (req, res) => {
  try {
    const organizations = await listAdminOrganizations();
    return res.status(200).json({ ok: true, organizations });
  } catch (error) {
    console.error('[ADMIN ORGANIZATIONS ERROR]', error.message || error);
    return res.status(500).json({
      ok: false,
      error: 'Erro ao carregar organizações.'
    });
  }
});

module.exports = router;
