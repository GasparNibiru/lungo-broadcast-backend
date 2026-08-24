const express = require('express');
const { createAdminSubscription } = require('../services/admin-subscriptions');
const requireAdmin = require('../middleware/require-admin');
const asaas = require('../services/asaas');

const router = express.Router();
const FIXED_DUE_DAYS = new Set([1, 5, 10, 15, 20, 25]);

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validate(body) {
  const errors = [];
  const requiredStrings = [
    'organizationName', 'responsibleName', 'email', 'phone', 'organizationType',
    'planCode', 'saleDate', 'firstPaymentDate', 'firstPaymentStatus', 'dueMode'
  ];

  for (const field of requiredStrings) {
    if (typeof body[field] !== 'string' || !body[field].trim()) errors.push(`${field} é obrigatório.`);
  }

  if (!Number.isInteger(body.extraAccesses) || body.extraAccesses < 0) {
    errors.push('extraAccesses deve ser um número inteiro maior ou igual a zero.');
  }
  if (['free', 'individual'].includes(body.planCode) && body.extraAccesses !== 0) {
    errors.push(`O Plano ${body.planCode === 'free' ? 'Free' : 'Individual'} não aceita acessos extras.`);
  }
  if (typeof body.legacy !== 'boolean') errors.push('legacy deve ser booleano.');
  if (body.documentNumber != null && typeof body.documentNumber !== 'string') {
    errors.push('documentNumber deve ser texto ou null.');
  }
  if (body.generateAccess != null && typeof body.generateAccess !== 'boolean') {
    errors.push('generateAccess deve ser booleano.');
  }
  if (body.generateAccess === true && !['supervisor', 'broker'].includes(body.accessRole)) {
    errors.push('accessRole deve ser supervisor ou broker quando generateAccess for true.');
  }
  if (body.organizationType && !['individual', 'brokerage'].includes(body.organizationType)) {
    errors.push('organizationType deve ser individual ou brokerage.');
  }
  if (body.firstPaymentStatus && !['pending', 'paid'].includes(body.firstPaymentStatus)) {
    errors.push('firstPaymentStatus deve ser pending ou paid.');
  }
  if (String(process.env.ASAAS_ENABLED || '').toLowerCase() === 'true' && body.planCode !== 'free') {
    const document = String(body.documentNumber || '').replace(/\D/g, '');
    if (![11, 14].includes(document.length)) errors.push('CPF/CNPJ válido é obrigatório para cobrança Asaas.');
    if (body.firstPaymentStatus !== 'pending') errors.push('A primeira cobrança Asaas deve iniciar como pendente.');
  }
  if (body.dueMode && !['thirty_days', 'fixed_day'].includes(body.dueMode)) {
    errors.push('dueMode deve ser thirty_days ou fixed_day.');
  }
  if (body.saleDate && !isIsoDate(body.saleDate)) errors.push('saleDate deve ser uma data válida no formato YYYY-MM-DD.');
  if (body.firstPaymentDate && !isIsoDate(body.firstPaymentDate)) {
    errors.push('firstPaymentDate deve ser uma data válida no formato YYYY-MM-DD.');
  }
  if (body.dueMode === 'fixed_day' && !FIXED_DUE_DAYS.has(body.fixedDueDay)) {
    errors.push('fixedDueDay deve ser 1, 5, 10, 15, 20 ou 25 para dueMode fixed_day.');
  }
  if (body.dueMode === 'thirty_days' && body.fixedDueDay != null) {
    errors.push('fixedDueDay deve ser null para dueMode thirty_days.');
  }

  if (errors.length) return { errors };

  return {
    value: {
      organizationName: body.organizationName.trim(),
      responsibleName: body.responsibleName.trim(),
      documentNumber: String(body.documentNumber || '').trim() || null,
      email: body.email.trim(),
      phone: body.phone.trim(),
      organizationType: body.organizationType,
      planCode: body.planCode.trim(),
      extraAccesses: body.extraAccesses,
      legacy: body.legacy,
      saleDate: body.saleDate,
      firstPaymentDate: body.firstPaymentDate,
      firstPaymentStatus: body.firstPaymentStatus,
      dueMode: body.dueMode,
      fixedDueDay: body.dueMode === 'fixed_day' ? body.fixedDueDay : null,
      generateAccess: body.generateAccess === true,
      accessRole: body.generateAccess === true ? body.accessRole : null
    }
  };
}

router.post('/api/admin/subscriptions', requireAdmin, async (req, res) => {
  const validation = validate(req.body || {});
  if (validation.errors) {
    return res.status(400).json({ ok: false, error: 'Dados inválidos.', details: validation.errors });
  }

  try {
    const result = await createAdminSubscription(validation.value);
    return res.status(201).json({
      ok: true,
      organization: result.organization,
      subscription: result.subscription,
      payment: result.payment,
      billing: result.billing,
      ...(result.access ? { access: result.access, token: result.token, emailDelivery: result.emailDelivery } : {})
    });
  } catch (error) {
    const statusCode = [400, 409].includes(error.statusCode) ? error.statusCode : 500;
    return res.status(statusCode).json({
      ok: false,
      error: statusCode === 500 ? 'Erro interno no servidor.' : error.message
    });
  }
});

router.post('/api/admin/subscriptions/:subscriptionId/asaas/retry', requireAdmin, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.subscriptionId)) return res.status(400).json({ ok: false, error: 'Assinatura inválida.' });
  try { return res.status(200).json({ ok: true, billing: await asaas.retrySubscription(req.params.subscriptionId) }); }
  catch (error) { return res.status(error.statusCode === 404 ? 404 : 500).json({ ok: false, error: error.message || 'Falha ao sincronizar cobrança.' }); }
});

module.exports = router;
