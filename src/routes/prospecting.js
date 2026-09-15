'use strict';
const express = require('express');
const { requireAccess } = require('../middleware/require-access');
const { createService } = require('../modules/prospecting/service');
function createProspectingRouter({ service = createService(), auth = requireAccess(['broker','supervisor']) } = {}) {
  const router = express.Router();
  router.use('/api/prospecting', (req, res, next) => { res.set('Cache-Control', 'private, no-store'); res.set('Vary', 'x-access-token, Authorization'); next(); }, auth);
  const handler = action => async (req, res) => {
    try {
      if (!req.accessUser?.id || !['broker','supervisor'].includes(req.accessUser.role)) return res.status(403).json({ ok: false, error: 'Perfil sem acesso à Prospecção.' });
      res.json({ ok: true, ...await action(req) });
    } catch (error) {
      res.status(error.statusCode || 503).json({ ok: false, code: error.code || 'prospecting_unavailable', error: error.statusCode ? error.message : 'Prospecção indisponível. Tente novamente.' });
    }
  };
  router.get('/api/prospecting/wallet', handler(async req => ({ wallet: await service.wallet(req.accessUser) })));
  router.get('/api/prospecting/companies', handler(req => service.companies(req.accessUser, req.query)));
  router.post('/api/prospecting/acquisitions', handler(req => service.acquire(req.accessUser, req.body)));
  router.get('/api/prospecting/my-companies', handler(req => service.myCompanies(req.accessUser, req.query)));
  router.post('/api/prospecting/exports', handler(req => service.requestExport(req.accessUser, req.accessToken, req.body)));
  router.get('/api/prospecting/exports/:id', handler(req => service.exportStatus(req.accessUser, req.params.id)));
  return router;
}
module.exports = createProspectingRouter();
module.exports.createProspectingRouter = createProspectingRouter;
