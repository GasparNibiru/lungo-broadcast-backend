const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const { requireAccess } = require('../middleware/require-access');
const supabase = require('../database/supabase');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const legacyBrokerAccess = require('../services/legacy-broker-access');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = (value) => Math.round(Number(value || 0) * 100) / 100;
function fail(res, error, fallback = 'Erro no marketplace de leads.') { console.error('[LEAD MARKETPLACE]', error?.message || error); const message = String(error?.message || ''); const known = ['Saldo insuficiente.', 'Este lead nao esta mais disponivel.', 'Usuario invalido ou inativo.', 'Usuario invalido.', 'O ajuste deixaria o saldo negativo.'].find((item) => message.includes(item)); return res.status(known ? 409 : 500).json({ ok: false, error: known || fallback }); }
function maskedName(value) { const text = String(value || '').trim(); return text ? `${text.slice(0, Math.min(3, text.length))}${'*'.repeat(Math.max(3, text.length - 3))}` : '***'; }
function maskedPhone(value) { const digits = String(value || '').replace(/\D/g, ''); return digits.length >= 4 ? `${digits.slice(0, 2)} ${'*'.repeat(Math.max(5, digits.length - 4))}${digits.slice(-2)}` : '********'; }
function publicOffer(item) { return { id: item.id, name: maskedName(item.name), phone: maskedPhone(item.phone), profile: item.profile, livesCount: Number(item.lives_count || 0), productInterest: item.product_interest, city: item.city, state: item.state, price: Number(item.price), status: item.status === 'reserved' ? 'reserved' : 'available', capturedAt: item.created_at }; }
async function addLegacyLead(user, token, offer) { const client = await legacyBrokerAccess.ensure(user, token); const file = process.env.LEADS_FILE_PATH || path.join(process.cwd(), 'data', 'leads.json'); let items = []; try { const parsed = JSON.parse(await fs.readFile(file, 'utf8')); items = Array.isArray(parsed) ? parsed : []; } catch (error) { if (error.code !== 'ENOENT') throw error; } if (!items.some((item) => item.marketplaceLeadId === offer.id)) { const now = new Date().toISOString(); items.push({ id: crypto.randomUUID(), marketplaceLeadId: offer.id, instanceName: client.instanceName, nome: offer.name, telefone: offer.phone, email: offer.email || '', pessoaTipo: offer.profile, qtdVidas: Number(offer.lives_count || 0), planoInteresse: offer.product_interest || '', cidade: offer.city || '', status: 'novo', origem: 'Marketplace de Leads', observacao: 'Lead adquirido no marketplace interno.', createdAt: now, updatedAt: now }); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(items, null, 2)}\n`, 'utf8'); } }

router.get('/api/admin/lead-marketplace', requireAdmin, async (_req, res) => {
  try {
    const [settings, users, wallets, leads, purchases, transactions] = await Promise.all([
      supabase.from('lead_marketplace_settings').select('*').eq('id', true).single(),
      supabase.from('users').select('id,name,email,role,status,organization_id,organizations!users_organization_id_fkey(name)').in('role', ['broker','supervisor']).order('name'),
      supabase.from('lead_credit_wallets').select('*'), supabase.from('marketplace_leads').select('*').order('created_at', { ascending: false }),
      supabase.from('marketplace_purchases').select('*,users!marketplace_purchases_buyer_user_id_fkey(name),marketplace_leads(name,phone,profile,lives_count,product_interest)').order('purchased_at', { ascending: false }).limit(200),
      supabase.from('lead_credit_transactions').select('*').order('created_at', { ascending: false }).limit(300)
    ]);
    const error = [settings, users, wallets, leads, purchases, transactions].find((result) => result.error)?.error; if (error) throw error;
    const walletMap = new Map((wallets.data || []).map((item) => [item.user_id, item]));
    res.json({ ok: true, settings: settings.data, users: (users.data || []).map((user) => ({ ...user, balance: Number(walletMap.get(user.id)?.balance || 0) })), leads: leads.data || [], purchases: purchases.data || [], transactions: transactions.data || [] });
  } catch (error) { fail(res, error, 'Estrutura do marketplace ainda nao foi aplicada no Supabase.'); }
});

router.patch('/api/admin/lead-marketplace/settings', requireAdmin, async (req, res) => {
  const min = money(req.body?.minPrice); const max = money(req.body?.maxPrice); if (min < 0 || max < min) return res.status(400).json({ ok: false, error: 'Faixa de preco invalida.' });
  const payload = { min_price: min, max_price: max, support_whatsapp: String(req.body?.supportWhatsapp || '5555992102864').replace(/\D/g, ''), reservation_minutes: Math.max(1, Math.min(30, Number(req.body?.reservationMinutes || 2))), updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('lead_marketplace_settings').update(payload).eq('id', true).select().single(); if (error) return fail(res, error); res.json({ ok: true, settings: data });
});

router.post('/api/admin/lead-marketplace/credits', requireAdmin, async (req, res) => {
  const userId = String(req.body?.userId || ''); const amount = money(req.body?.amount); if (!UUID.test(userId) || !amount) return res.status(400).json({ ok: false, error: 'Usuario e valor sao obrigatorios.' });
  const { data, error } = await supabase.rpc('adjust_lead_credits', { p_user_id: userId, p_amount: amount, p_description: String(req.body?.description || 'Ajuste manual pelo Admin') }); if (error) return fail(res, error); res.json({ ok: true, balance: Number(data) });
});

router.post('/api/admin/lead-marketplace/leads', requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim(); const phone = String(req.body?.phone || '').replace(/\D/g, ''); const profile = String(req.body?.profile || 'PF'); if (!name || phone.length < 8 || !['PF','PJ','Adesao'].includes(profile)) return res.status(400).json({ ok: false, error: 'Nome, telefone e perfil validos sao obrigatorios.' });
  try { const { data: settings } = await supabase.from('lead_marketplace_settings').select('*').eq('id', true).single(); const low = Number(settings?.min_price || 10), high = Number(settings?.max_price || 20); const price = req.body?.price === '' || req.body?.price == null ? money(low + Math.random() * (high - low)) : money(req.body.price); const { data, error } = await supabase.from('marketplace_leads').insert({ name, phone, email: String(req.body?.email || '').trim() || null, profile, lives_count: Math.max(0, Number(req.body?.livesCount || 0)), product_interest: String(req.body?.productInterest || '').trim() || null, city: String(req.body?.city || '').trim() || null, state: String(req.body?.state || '').trim() || null, campaign_name: String(req.body?.campaignName || '').trim() || 'Cadastro manual', price }).select().single(); if (error) throw error; res.status(201).json({ ok: true, lead: data }); } catch (error) { fail(res, error); }
});

router.patch('/api/admin/lead-marketplace/leads/:id', requireAdmin, async (req, res) => { if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'Lead invalido.' }); const payload = {}; if (req.body?.status && ['available','invalid','duplicate'].includes(req.body.status)) payload.status = req.body.status; if (req.body?.price != null) payload.price = money(req.body.price); payload.updated_at = new Date().toISOString(); const { data, error } = await supabase.from('marketplace_leads').update(payload).eq('id', req.params.id).select().single(); if (error) return fail(res, error); res.json({ ok: true, lead: data }); });

router.get('/api/lead-marketplace', requireAccess(['broker','supervisor']), async (req, res) => {
  try { const [wallet, settings, offers] = await Promise.all([supabase.from('lead_credit_wallets').select('balance').eq('user_id', req.accessUser.id).maybeSingle(), supabase.from('lead_marketplace_settings').select('support_whatsapp').eq('id', true).single(), supabase.from('marketplace_leads').select('*').in('status', ['available','reserved']).order('created_at', { ascending: false })]); const error = wallet.error || settings.error || offers.error; if (error) throw error; const now = Date.now(); const visible = (offers.data || []).filter((item) => item.status === 'available' || Date.parse(item.reserved_until || 0) <= now || item.reserved_by === req.accessUser.id).map(publicOffer); res.json({ ok: true, balance: Number(wallet.data?.balance || 0), supportWhatsapp: settings.data.support_whatsapp, leads: visible }); } catch (error) { fail(res, error); }
});

router.get('/api/lead-marketplace/history', requireAccess(['broker','supervisor']), async (req, res) => { const { data, error } = await supabase.from('marketplace_purchases').select('id,price,purchased_at,crm_lead_id,marketplace_leads(name,phone,email,profile,lives_count,product_interest,city,state)').eq('buyer_user_id', req.accessUser.id).order('purchased_at', { ascending: false }); if (error) return fail(res, error); res.json({ ok: true, purchases: data || [] }); });
router.post('/api/lead-marketplace/:id/buy', requireAccess(['broker','supervisor']), async (req, res) => { if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'Lead invalido.' }); const { data, error } = await supabase.rpc('buy_marketplace_lead', { p_user_id: req.accessUser.id, p_lead_id: req.params.id }); if (error) return fail(res, error); try { await addLegacyLead(req.accessUser, req.accessToken, data.lead); } catch (legacyError) { console.error('[LEAD MARKETPLACE LEGACY SYNC]', legacyError.message || legacyError); } res.json({ ok: true, purchase: data }); });

module.exports = router;
