'use strict';
const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const { createAdminService } = require('../modules/prospecting/admin');
function createAdminRouter({ service = createAdminService(), auth = requireAdmin } = {}) {
  const router = express.Router();
  router.use('/api/admin/prospecting', (req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('Vary', 'x-admin-key'); next(); }, auth);
  const handle = action => async (req, res) => { try { res.json({ ok: true, ...await action(req) }); } catch (e) { res.status(e.statusCode || 503).json({ ok: false, error: e.statusCode ? e.message : 'Prospecção indisponível. Tente novamente.' }); } };
  router.get('/api/admin/prospecting/users', handle(req => service.list(req.query)));
  router.get('/api/admin/prospecting/users/:id', handle(req => service.detail(req.params.id, req.query)));
  router.post('/api/admin/prospecting/users/:id/credits', handle(req => service.credit(req.params.id, req.body)));
  return router;
}
module.exports = { createAdminRouter };
