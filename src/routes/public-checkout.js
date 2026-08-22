const express = require('express');
const checkout = require('../services/public-checkout');

const router = express.Router();
const attempts = new Map();
function limited(req) {
  const key = req.ip || 'unknown', now = Date.now(), windowStart = now - 15 * 60 * 1000;
  const recent = (attempts.get(key) || []).filter((time) => time > windowStart);
  recent.push(now); attempts.set(key, recent); return recent.length > 20;
}
function digits(value) { return String(value || '').replace(/\D/g, ''); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '')); }

router.post('/api/public/checkout', async (req, res) => {
  if (limited(req)) { res.set('Retry-After', '900'); return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde 15 minutos antes de tentar novamente.' }); }
  const body = req.body || {}, documentNumber = digits(body.documentNumber), extraAccesses = Number(body.extraAccesses);
  const errors = [];
  if (!String(body.organizationName || '').trim()) errors.push('Nome ou razão social é obrigatório.');
  if (!String(body.responsibleName || '').trim()) errors.push('Nome do responsável é obrigatório.');
  if (![11, 14].includes(documentNumber.length)) errors.push('Informe um CPF ou CNPJ válido.');
  if (!validEmail(body.email)) errors.push('Informe um e-mail válido.');
  if (digits(body.phone).length < 10) errors.push('Informe um WhatsApp válido.');
  if (!checkout.PUBLIC_PLANS.has(body.planCode)) errors.push('Plano inválido.');
  if (!Number.isInteger(extraAccesses) || extraAccesses < 0 || extraAccesses > 100) errors.push('Quantidade de adicionais inválida.');
  if (body.acceptedTerms !== true) errors.push('Você precisa aceitar os termos.');
  if (errors.length) return res.status(400).json({ ok: false, error: 'Confira os dados informados.', details: errors });
  try {
    const result = await checkout.create({ organizationName: body.organizationName.trim(), responsibleName: body.responsibleName.trim(),
      documentNumber, email: body.email.trim(), phone: digits(body.phone), planCode: body.planCode, extraAccesses,
      checkoutToken: typeof body.checkoutToken === 'string' && body.checkoutToken.length >= 32 ? body.checkoutToken : undefined });
    if (result.billing?.pending || !result.billing?.invoiceUrl) return res.status(502).json({ ok: false, error: result.billing?.error || 'A cobrança ficou pendente de sincronização.', checkoutId: result.checkoutId, checkoutToken: result.checkoutToken });
    return res.status(201).json({ ok: true, ...result });
  } catch (error) {
    console.error('[PUBLIC CHECKOUT ERROR]', error.message || error);
    const duplicate = error.code === '23505';
    return res.status(duplicate ? 409 : 500).json({ ok: false, error: duplicate ? 'Já existe uma organização ativa com este CPF/CNPJ.' : 'Não foi possível iniciar a contratação.' });
  }
});

router.post('/api/public/checkout/status', async (req, res) => {
  const id = String(req.body?.checkoutId || ''), token = String(req.body?.checkoutToken || '');
  if ((id && !/^[0-9a-f-]{36}$/i.test(id)) || token.length < 32) return res.status(400).json({ ok: false, error: 'Contratação inválida.' });
  const result = await checkout.status(id, token);
  return result ? res.json({ ok: true, ...result }) : res.status(404).json({ ok: false, error: 'Contratação não encontrada.' });
});

module.exports = router;
