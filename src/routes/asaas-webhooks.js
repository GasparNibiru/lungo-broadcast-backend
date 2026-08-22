const express = require('express');
const crypto = require('crypto');
const supabase = require('../database/supabase');

const router = express.Router();

function safeEqual(left, right) { const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function paymentStatus(event) {
  if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(event)) return 'paid';
  if (event === 'PAYMENT_OVERDUE') return 'overdue';
  if (event === 'PAYMENT_REFUNDED') return 'refunded';
  if (['PAYMENT_DELETED', 'PAYMENT_RESTORED'].includes(event)) return event === 'PAYMENT_DELETED' ? 'cancelled' : 'pending';
  return 'pending';
}
function competence(dueDate) { return /^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || '')) ? `${dueDate.slice(0, 7)}-01` : new Date().toISOString().slice(0, 7) + '-01'; }

async function savePayment(event, payment) {
  if (!payment?.id || !payment.subscription) return;
  const { data: subscription } = await supabase.from('subscriptions').select('id').eq('asaas_subscription_id', payment.subscription).maybeSingle();
  if (!subscription) return;
  const status = paymentStatus(event), paid = status === 'paid' || status === 'refunded';
  const row = { subscription_id: subscription.id, competence: competence(payment.dueDate), due_date: payment.dueDate, expected_amount: Number(payment.value || 0), paid_amount: paid ? Number(payment.value || 0) : null, paid_at: paid ? payment.paymentDate || payment.clientPaymentDate || payment.confirmedDate || new Date().toISOString() : null, status, payment_method: payment.billingType || null, asaas_payment_id: payment.id, invoice_url: payment.invoiceUrl || null, updated_at: new Date().toISOString() };
  const { data: current } = await supabase.from('payments').select('id,status').eq('asaas_payment_id', payment.id).maybeSingle();
  let paymentId = current?.id;
  if (paymentId) await supabase.from('payments').update(row).eq('id', paymentId);
  else { const { data, error } = await supabase.from('payments').upsert(row, { onConflict: 'subscription_id,competence' }).select('id').single(); if (error) throw error; paymentId = data.id; }
  if (current?.status !== status) await supabase.from('payment_history').insert({ payment_id: paymentId, action: `asaas_${String(event).toLowerCase()}`, old_status: current?.status || null, new_status: status, amount: Number(payment.value || 0), notes: `Evento Asaas ${event}` });
}

async function saveSubscription(event, subscription) {
  if (!subscription?.id) return;
  await supabase.from('subscriptions').update({ asaas_status: subscription.status || event.replace('SUBSCRIPTION_', ''), asaas_sync_status: 'synced', asaas_last_error: null, asaas_synced_at: new Date().toISOString() }).eq('asaas_subscription_id', subscription.id);
}

router.post('/api/webhooks/asaas', async (req, res) => {
  const expectedToken = String(process.env.ASAAS_WEBHOOK_TOKEN || '');
  if (expectedToken.length < 32 || !safeEqual(req.get('asaas-access-token'), expectedToken)) return res.status(401).json({ ok: false, error: 'Webhook não autorizado.' });
  const eventId = String(req.body?.id || ''), event = String(req.body?.event || '');
  if (!eventId || !event) return res.status(400).json({ ok: false, error: 'Evento inválido.' });
  const resource = req.body.payment || req.body.subscription || null;
  const inserted = await supabase.from('asaas_webhook_events').insert({ id: eventId, event_type: event, resource_id: resource?.id || null, payload: req.body });
  if (inserted.error?.code === '23505') { const { data: previous } = await supabase.from('asaas_webhook_events').select('processed_at,processing_error').eq('id', eventId).maybeSingle(); if (previous?.processed_at) return res.status(200).json({ ok: true, duplicate: true }); if (!previous?.processing_error) return res.status(409).json({ ok: false, error: 'Evento em processamento.' }); await supabase.from('asaas_webhook_events').update({ processing_error: null }).eq('id', eventId); }
  if (inserted.error && inserted.error.code !== '23505') return res.status(500).json({ ok: false, error: 'Não foi possível registrar o evento.' });
  try { if (event.startsWith('PAYMENT_')) await savePayment(event, req.body.payment); if (event.startsWith('SUBSCRIPTION_')) await saveSubscription(event, req.body.subscription); await supabase.from('asaas_webhook_events').update({ processed_at: new Date().toISOString(), processing_error: null }).eq('id', eventId); return res.status(200).json({ ok: true }); }
  catch (error) { console.error('[ASAAS WEBHOOK ERROR]', error.message || error); await supabase.from('asaas_webhook_events').update({ processing_error: String(error.message || error).slice(0, 500) }).eq('id', eventId); return res.status(500).json({ ok: false, error: 'Falha ao processar evento.' }); }
});

module.exports = router;
