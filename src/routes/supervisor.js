const express = require('express');
const { requireAccess } = require('../middleware/require-access');
const service = require('../services/supervisor');
const legacyBrokerAccess = require('../services/legacy-broker-access');

const router = express.Router();
const requireSupervisor = requireAccess('supervisor');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sendError(res, error) {
  const status = [400, 404, 409].includes(error.statusCode) ? error.statusCode : 500;
  return res.status(status).json({ ok: false, error: status === 500 ? 'Erro interno no servidor.' : error.message });
}

function brokerPayload(body, creating = false) {
  const value = { name: String(body.name || '').trim(), email: String(body.email || '').trim().toLowerCase(), phone: body.phone == null || body.phone === '' ? null : String(body.phone).trim() };
  if (!value.name || !EMAIL.test(value.email)) return { error: 'Nome e e-mail válido são obrigatórios.' };
  if (creating) value.expiresAt = body.expiresAt || null;
  return { value };
}

router.post('/api/access/auth/verify', requireAccess(), async (req, res) => {
  try {
    const client = ['broker', 'supervisor'].includes(req.accessUser.role) ? await legacyBrokerAccess.ensure(req.accessUser, req.accessToken) : null;
    return res.status(200).json({ ok: true, user: req.accessUser, client: client ? { nome: client.nome, instanceName: client.instanceName } : null });
  } catch (error) { return sendError(res, error); }
});

router.use('/api/supervisor', requireSupervisor);
router.get('/api/supervisor/session', (req, res) => res.status(200).json({ ok: true, user: req.accessUser }));
router.get('/api/supervisor/dashboard', async (req, res) => { try { return res.status(200).json({ ok: true, dashboard: await service.getSupervisorDashboard(req.accessUser.organizationId) }); } catch (error) { return sendError(res, error); } });
router.get('/api/supervisor/brokers', async (req, res) => { try { return res.status(200).json({ ok: true, brokers: await service.listSupervisorBrokers(req.accessUser.organizationId) }); } catch (error) { return sendError(res, error); } });
router.post('/api/supervisor/brokers', async (req, res) => { const payload = brokerPayload(req.body, true); if (payload.error) return res.status(400).json({ ok: false, error: payload.error }); try { const result = await service.createSupervisorBroker(req.accessUser.organizationId, payload.value); return res.status(201).json({ ok: true, broker: result.user, token: result.token }); } catch (error) { return sendError(res, error); } });
router.patch('/api/supervisor/brokers/:userId', async (req, res) => { if (!UUID.test(req.params.userId)) return res.status(400).json({ ok: false, error: 'Corretor inválido.' }); const payload = brokerPayload(req.body); if (payload.error) return res.status(400).json({ ok: false, error: payload.error }); try { return res.status(200).json({ ok: true, broker: await service.updateSupervisorBroker(req.accessUser.organizationId, req.params.userId, payload.value) }); } catch (error) { return sendError(res, error); } });
for (const [path, action] of [['block', 'block'], ['reactivate', 'reactivate'], ['token/invalidate', 'invalidate_token']]) router.post(`/api/supervisor/brokers/:userId/${path}`, async (req, res) => { if (!UUID.test(req.params.userId)) return res.status(400).json({ ok: false, error: 'Corretor inválido.' }); try { return res.status(200).json({ ok: true, broker: await service.changeSupervisorBroker(req.accessUser.organizationId, req.params.userId, action) }); } catch (error) { return sendError(res, error); } });
router.post('/api/supervisor/brokers/:userId/token/renew', async (req, res) => { if (!UUID.test(req.params.userId)) return res.status(400).json({ ok: false, error: 'Corretor inválido.' }); try { const result = await service.renewSupervisorBrokerToken(req.accessUser.organizationId, req.params.userId, req.body?.expiresAt || null); return res.status(200).json({ ok: true, broker: result.user, token: result.token }); } catch (error) { return sendError(res, error); } });
router.get('/api/supervisor/clients', async (req, res) => { try { return res.status(200).json({ ok: true, clients: await service.listSupervisorClients(req.accessUser.organizationId) }); } catch (error) { return sendError(res, error); } });
router.post('/api/supervisor/clients/import', async (req, res) => { try { return res.status(200).json({ ok: true, ...(await service.importSupervisorClients(req.accessUser.organizationId, req.body?.clientes)) }); } catch (error) { return sendError(res, error); } });
router.get('/api/supervisor/leads', async (req, res) => { try { return res.status(200).json({ ok: true, leads: await service.listSupervisorLeads(req.accessUser.organizationId) }); } catch (error) { return sendError(res, error); } });
router.get('/api/supervisor/operational-clients', async (req, res) => { try { return res.status(200).json({ ok: true, clients: await service.listSupervisorOperationalCustomers(req.accessUser.organizationId) }); } catch (error) { return sendError(res, error); } });

module.exports = router;
