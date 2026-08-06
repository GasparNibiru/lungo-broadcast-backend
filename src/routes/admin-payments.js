const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const {
  getAdminPayment,
  updateAdminPayment,
  confirmAdminPayment,
  getOrganizationPaymentHistory
} = require('../services/admin-payments');

const router = express.Router();
const UPDATE_FIELDS = new Set(['dueDate', 'expectedAmount', 'paymentMethod', 'notes']);
const CONFIRM_FIELDS = new Set(['paidAmount', 'paidAt', 'paymentMethod', 'notes']);

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requireUuid(parameter, label) {
  return (req, res, next) => {
    if (!isUuid(req.params[parameter])) {
      return res.status(400).json({ ok: false, error: `${label} inválido.` });
    }
    return next();
  };
}

function validateOptionalText(body, field, errors) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  if (body[field] !== null && typeof body[field] !== 'string') {
    errors.push(`${field} deve ser texto ou null.`);
  }
}

function rejectUnknownFields(body, allowed, errors) {
  Object.keys(body).forEach((field) => {
    if (!allowed.has(field)) errors.push(`Campo não permitido: ${field}.`);
  });
}

function validateUpdate(body) {
  const errors = [];
  rejectUnknownFields(body, UPDATE_FIELDS, errors);
  if (!Object.keys(body).length) errors.push('Informe ao menos um campo para atualização.');
  if (Object.prototype.hasOwnProperty.call(body, 'dueDate') && !isIsoDate(body.dueDate)) {
    errors.push('dueDate deve ser uma data válida no formato YYYY-MM-DD.');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'expectedAmount')
    && (typeof body.expectedAmount !== 'number' || !Number.isFinite(body.expectedAmount) || body.expectedAmount < 0)) {
    errors.push('expectedAmount deve ser um número maior ou igual a zero.');
  }
  validateOptionalText(body, 'paymentMethod', errors);
  validateOptionalText(body, 'notes', errors);
  return errors;
}

function validateConfirmation(body) {
  const errors = [];
  rejectUnknownFields(body, CONFIRM_FIELDS, errors);
  if (typeof body.paidAmount !== 'number' || !Number.isFinite(body.paidAmount) || body.paidAmount < 0) {
    errors.push('paidAmount é obrigatório e deve ser um número maior ou igual a zero.');
  }
  if (!isIsoDate(body.paidAt)) errors.push('paidAt é obrigatório e deve estar no formato YYYY-MM-DD.');
  validateOptionalText(body, 'paymentMethod', errors);
  validateOptionalText(body, 'notes', errors);
  return errors;
}

function sendError(res, error, context) {
  const statusCode = [400, 404, 409].includes(error.statusCode) ? error.statusCode : 500;
  if (statusCode === 500) console.error(`[${context}]`, error.message || error);
  return res.status(statusCode).json({
    ok: false,
    error: statusCode === 500 ? 'Erro interno no servidor.' : error.message
  });
}

const requirePaymentId = requireUuid('paymentId', 'Identificador de pagamento');
const requireOrganizationId = requireUuid('organizationId', 'Identificador de organização');

router.get('/api/admin/payments/:paymentId', requireAdmin, requirePaymentId, async (req, res) => {
  try {
    return res.status(200).json({ ok: true, payment: await getAdminPayment(req.params.paymentId) });
  } catch (error) {
    return sendError(res, error, 'ADMIN PAYMENT GET ERROR');
  }
});

router.patch('/api/admin/payments/:paymentId', requireAdmin, requirePaymentId, async (req, res) => {
  const body = req.body || {};
  const errors = validateUpdate(body);
  if (errors.length) return res.status(400).json({ ok: false, error: 'Dados inválidos.', details: errors });
  try {
    return res.status(200).json({ ok: true, payment: await updateAdminPayment(req.params.paymentId, body) });
  } catch (error) {
    return sendError(res, error, 'ADMIN PAYMENT UPDATE ERROR');
  }
});

router.post('/api/admin/payments/:paymentId/confirm', requireAdmin, requirePaymentId, async (req, res) => {
  const body = req.body || {};
  const errors = validateConfirmation(body);
  if (errors.length) return res.status(400).json({ ok: false, error: 'Dados inválidos.', details: errors });
  try {
    return res.status(200).json({ ok: true, payment: await confirmAdminPayment(req.params.paymentId, body) });
  } catch (error) {
    return sendError(res, error, 'ADMIN PAYMENT CONFIRM ERROR');
  }
});

router.get('/api/admin/organizations/:organizationId/payment-history', requireAdmin, requireOrganizationId, async (req, res) => {
  try {
    const result = await getOrganizationPaymentHistory(req.params.organizationId);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    return sendError(res, error, 'ADMIN ORGANIZATION PAYMENT HISTORY ERROR');
  }
});

module.exports = router;
module.exports.isUuid = isUuid;
module.exports.isIsoDate = isIsoDate;
module.exports.validateUpdate = validateUpdate;
module.exports.validateConfirmation = validateConfirmation;
