const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const {
  listAdminOrganizations,
  updateAdminOrganization,
  changeAdminOrganizationSubscriptionStatus
} = require('../services/admin-organizations');

const router = express.Router();
const ALLOWED_FIELDS = new Set([
  'name', 'organizationType', 'planCode', 'extraAccesses',
  'legacy', 'nextDueDate', 'dueMode', 'fixedDueDay'
]);
const ORGANIZATION_TYPES = new Set(['individual', 'brokerage']);
const DUE_MODES = new Set(['thirty_days', 'fixed_day']);
const FIXED_DUE_DAYS = new Set([1, 5, 10, 15, 20, 25]);

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function requireOrganizationId(req, res, next) {
  if (!isUuid(req.params.organizationId)) {
    return res.status(400).json({ ok: false, error: 'Identificador de organização inválido.' });
  }
  return next();
}
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validateUpdate(body) {
  const errors = [];
  const fields = Object.keys(body);
  const has = (field) => Object.prototype.hasOwnProperty.call(body, field);

  if (!fields.length) errors.push('Informe ao menos um campo para atualização.');
  for (const field of fields) {
    if (!ALLOWED_FIELDS.has(field)) errors.push(`Campo não permitido: ${field}.`);
  }
  if (has('name') && (typeof body.name !== 'string' || !body.name.trim())) errors.push('name deve ser um texto não vazio.');
  if (has('organizationType') && !ORGANIZATION_TYPES.has(body.organizationType)) errors.push('organizationType deve ser individual ou brokerage.');
  if (has('planCode') && (typeof body.planCode !== 'string' || !body.planCode.trim())) errors.push('planCode deve ser um texto não vazio.');
  if (has('extraAccesses') && (!Number.isInteger(body.extraAccesses) || body.extraAccesses < 0)) errors.push('extraAccesses deve ser um número inteiro maior ou igual a zero.');
  if (has('legacy') && typeof body.legacy !== 'boolean') errors.push('legacy deve ser booleano.');
  if (has('nextDueDate') && !isIsoDate(body.nextDueDate)) errors.push('nextDueDate deve ser uma data válida no formato YYYY-MM-DD.');
  if (has('dueMode') && !DUE_MODES.has(body.dueMode)) errors.push('dueMode deve ser thirty_days ou fixed_day.');
  if (has('fixedDueDay') && body.fixedDueDay !== null && !FIXED_DUE_DAYS.has(body.fixedDueDay)) errors.push('fixedDueDay deve ser 1, 5, 10, 15, 20, 25 ou null.');
  if (body.dueMode === 'fixed_day' && !FIXED_DUE_DAYS.has(body.fixedDueDay)) errors.push('fixedDueDay deve ser 1, 5, 10, 15, 20 ou 25 para dueMode fixed_day.');
  if (body.dueMode === 'thirty_days' && has('fixedDueDay') && body.fixedDueDay !== null) errors.push('fixedDueDay deve ser null para dueMode thirty_days.');

  if (errors.length) return { errors };
  return {
    value: {
      ...body,
      ...(has('name') ? { name: body.name.trim() } : {}),
      ...(has('planCode') ? { planCode: body.planCode.trim() } : {}),
      ...(body.dueMode === 'thirty_days' ? { fixedDueDay: null } : {})
    }
  };
}

router.get('/api/admin/organizations', requireAdmin, async (req, res) => {
  try {
    const organizations = await listAdminOrganizations();
    return res.status(200).json({ ok: true, organizations });
  } catch (error) {
    console.error('[ADMIN ORGANIZATIONS ERROR]', error.message || error);
    return res.status(500).json({ ok: false, error: 'Erro ao carregar organizações.' });
  }
});

router.patch('/api/admin/organizations/:organizationId', requireAdmin, requireOrganizationId, async (req, res) => {
  const validation = validateUpdate(req.body || {});
  if (validation.errors) return res.status(400).json({ ok: false, error: 'Dados inválidos.', details: validation.errors });

  try {
    const result = await updateAdminOrganization(req.params.organizationId, validation.value);
    return res.status(200).json({ ok: true, organization: result.organization, subscription: result.subscription });
  } catch (error) {
    const statusCode = [400, 404].includes(error.statusCode) ? error.statusCode : 500;
    if (statusCode === 500) console.error('[ADMIN ORGANIZATION UPDATE ERROR]', error.message || error);
    return res.status(statusCode).json({ ok: false, error: statusCode === 500 ? 'Erro interno no servidor.' : error.message });
  }
});

function organizationStatusAction(action) {
  return async (req, res) => {
    try {
      const result = await changeAdminOrganizationSubscriptionStatus(req.params.organizationId, action);
      return res.status(200).json({
        ok: true,
        organization: result.organization,
        subscription: result.subscription
      });
    } catch (error) {
      const statusCode = [400, 404, 409].includes(error.statusCode) ? error.statusCode : 500;
      if (statusCode === 500) console.error('[ADMIN ORGANIZATION STATUS ERROR]', error.message || error);
      return res.status(statusCode).json({
        ok: false,
        error: statusCode === 500 ? 'Erro interno no servidor.' : error.message
      });
    }
  };
}

router.post('/api/admin/organizations/:organizationId/suspend', requireAdmin, requireOrganizationId, organizationStatusAction('suspend'));
router.post('/api/admin/organizations/:organizationId/reactivate', requireAdmin, requireOrganizationId, organizationStatusAction('reactivate'));
router.post('/api/admin/organizations/:organizationId/cancel', requireAdmin, requireOrganizationId, organizationStatusAction('cancel'));

module.exports = router;
