const express = require('express');

const router = express.Router();

router.post('/api/admin/auth/verify', (req, res) => {
  const expectedKey = String(process.env.ADMIN_ACCESS_KEY || '').trim();
  const providedKey = String(req.get('x-admin-key') || '').trim();

  if (!expectedKey) {
    return res.status(500).json({
      ok: false,
      error: 'Configuração administrativa ausente.'
    });
  }

  if (!providedKey || providedKey !== expectedKey) {
    return res.status(401).json({
      ok: false,
      error: 'Não autorizado.'
    });
  }

  return res.status(200).json({ ok: true });
});

module.exports = router;
