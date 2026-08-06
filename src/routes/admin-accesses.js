const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const {
  listAdminAccesses,
  createAdminAccess,
  updateAdminAccess,
  runUserAction,
  renewAdminAccessToken
} = require('../services/admin-accesses');

const router = express.Router();
const ROLES = new Set(['admin_master', 'supervisor', 'broker']);
const UPDATE_FIELDS = new Set(['name', 'email', 'phone', 'role']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanNullable(value) {
  return value === null || value === undefined || value === '' ? null : value.trim();
}

function validDate(value) {
  return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value) > new Date());
}

function validateBody(body, creating) {
  const errors = [];
  const allowed = creating ? new Set(['organizationId', ...UPDATE_FIELDS, 'expiresAt']) : UPDATE_FIELDS;
  for (const field of Object.keys(body)) if (!allowed.has(field)) errors.push(`Campo não permitido: ${field}.`);
  if (!creating && !Object.keys(body).length) errors.push('Informe ao menos um campo.');
  if (creating && !UUID.test(body.organizationId || '')) errors.push('organizationId deve ser um UUID válido.');
  if ((creating || 'name' in body) && (typeof body.name !== 'string' || !body.name.trim())) errors.push('name deve ser um texto não vazio.');
  if ((creating || 'email' in body) && (typeof body.email !== 'string' || !EMAIL.test(body.email.trim()))) errors.push('email deve ser válido.');
  if ((creating || 'phone' in body) && body.phone !== null && (typeof body.phone !== 'string' || !body.phone.trim())) errors.push('phone deve ser texto não vazio ou null.');
  if ((creating || 'role' in body) && !ROLES.has(body.role)) errors.push('role deve ser admin_master, supervisor ou broker.');
  if (creating && !validDate(body.expiresAt ?? null)) errors.push('expiresAt deve ser null ou uma data futura válida.');
  if (errors.length) return { errors };
  return { value: {
    ...body,
    ...('name' in body ? { name: body.name.trim() } : {}),
    ...('email' in body ? { email: body.email.trim().toLowerCase() } : {}),
    ...((creating || 'phone' in body) ? { phone: cleanNullable(body.phone) } : {}),
    ...(creating ? { expiresAt: body.expiresAt ?? null } : {})
  } };
}

function requireUserId(req, res, next) {
  if (!UUID.test(req.params.userId || '')) return res.status(400).json({ ok: false, error: 'userId inválido.' });
  return next();
}

function sendError(res, error, context) {
  const status = [400, 404, 409].includes(error.statusCode) ? error.statusCode : 500;
  if (status === 500) console.error(`[ADMIN ACCESSES ERROR] ${context}`, error.message || error);
  return res.status(status).json({ ok: false, error: status === 500 ? 'Erro interno no servidor.' : error.message });
}

router.use('/api/admin/accesses', requireAdmin);

router.get('/api/admin/accesses', async (req, res) => {
  try { return res.status(200).json({ ok: true, accesses: await listAdminAccesses() }); }
  catch (error) { return sendError(res, error, 'list'); }
});

router.post('/api/admin/accesses', async (req, res) => {
  const validation = validateBody(req.body || {}, true);
  if (validation.errors) return res.status(400).json({ ok: false, error: 'Dados inválidos.', details: validation.errors });
  try {
    const result = await createAdminAccess(validation.value);
    return res.status(201).json({ ok: true, user: result.user, token: result.token });
  } catch (error) { return sendError(res, error, 'create'); }
});

router.patch('/api/admin/accesses/:userId', requireUserId, async (req, res) => {
  const validation = validateBody(req.body || {}, false);
  if (validation.errors) return res.status(400).json({ ok: false, error: 'Dados inválidos.', details: validation.errors });
  try { return res.status(200).json({ ok: true, user: await updateAdminAccess(req.params.userId, validation.value) }); }
  catch (error) { return sendError(res, error, 'update'); }
});

for (const [path, action] of [['block', 'block'], ['reactivate', 'reactivate'], ['token/invalidate', 'invalidate_token']]) {
  router.post(`/api/admin/accesses/:userId/${path}`, requireUserId, async (req, res) => {
    try { return res.status(200).json({ ok: true, user: await runUserAction(req.params.userId, action) }); }
    catch (error) { return sendError(res, error, action); }
  });
}

router.post('/api/admin/accesses/:userId/token/renew', requireUserId, async (req, res) => {
  const expiresAt = req.body?.expiresAt ?? null;
  if (Object.keys(req.body || {}).some((key) => key !== 'expiresAt') || !validDate(expiresAt)) {
    return res.status(400).json({ ok: false, error: 'expiresAt deve ser null ou uma data futura válida.' });
  }
  try {
    const result = await renewAdminAccessToken(req.params.userId, expiresAt);
    return res.status(200).json({ ok: true, user: result.user, token: result.token });
  } catch (error) { return sendError(res, error, 'renew token'); }
});

module.exports = router;
