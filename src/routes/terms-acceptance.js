const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAccess } = require('../middleware/require-access');

const router = express.Router();
const FILE = process.env.TERMS_ACCEPTANCE_FILE_PATH || (process.env.NODE_ENV === 'staging' ? '/data-staging/terms-acceptance.json' : path.resolve(__dirname, '../../data/terms-acceptance.json'));

function load() { try { const value = JSON.parse(fs.readFileSync(FILE, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; } }
function save(value) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

router.get('/api/access/terms', requireAccess(['broker', 'supervisor']), (req, res) => {
  const item = load()[req.accessUser.id] || null;
  res.json({ ok: true, accepted: Boolean(item?.accepted), acceptance: item });
});

router.post('/api/access/terms', requireAccess(['broker', 'supervisor']), (req, res) => {
  const data = load();
  const item = { accepted: true, version: String(req.body?.version || 'current').slice(0, 100), acceptedAt: data[req.accessUser.id]?.acceptedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  data[req.accessUser.id] = item;
  save(data);
  res.json({ ok: true, acceptance: item });
});

module.exports = router;
