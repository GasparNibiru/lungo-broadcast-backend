const express = require('express');
const requireAdmin = require('../middleware/require-admin');

const router = express.Router();

router.post('/api/admin/auth/verify', requireAdmin, (req, res) => {
  return res.status(200).json({ ok: true });
});

module.exports = router;
