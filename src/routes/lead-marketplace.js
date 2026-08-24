const express = require('express');
const requireAdmin = require('../middleware/require-admin');
const { requireAccess } = require('../middleware/require-access');
const supabase = require('../database/supabase');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const legacyBrokerAccess = require('../services/legacy-broker-access');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = (value) => Math.round(Number(value || 0) * 100) / 100;
const META_FIELDS = 'id,created_time,field_data,ad_id,form_id';
function effectivePrice(item, minimum) {
  const original = Number(item.original_price ?? item.price ?? 0);
  const received = Date.parse(item.received_at || item.created_at || new Date().toISOString());
  const hours = Math.max(0, Math.floor((Date.now() - received) / 3600000));
  return money(Math.max(Number(minimum || 0), original * Math.max(0, 1 - hours * 0.10)));
}
function metaSignatureValid(req) {
  const secret = String(process.env.META_APP_SECRET || '');
  const signature = String(req.headers['x-hub-signature-256'] || '');
  if (!secret || !signature.startsWith('sha256=') || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
  const left = Buffer.from(signature); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function normalizeMetaKey(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function metaFields(data) {
  return Object.fromEntries((data?.field_data || []).map((field) => [normalizeMetaKey(field.name), String(field.values?.[0] || '').trim()]));
}
function firstMetaField(fields, names, fragments = []) {
  for (const name of names) if (fields[name]) return fields[name];
  const entry = Object.entries(fields).find(([key, value]) => value && fragments.some((fragment) => key.includes(fragment)));
  return entry?.[1] || '';
}
function metaLivesAndAges(fields) {
  const answer = firstMetaField(fields,
    ['quantas_pessoas_entrarao_no_plano_e_quais_sao_as_idades','beneficiary_ages','idades_dos_beneficiarios','idades','lives_count','quantidade_de_vidas','qtd_de_vidas','vidas'],
    ['quantas_pessoas','quantidade_de_pessoas','idades','idade_dos_beneficiarios']);
  if (!answer) return { answer: null, lives: 0 };
  const normalized = normalizeMetaKey(answer);
  const explicitCount = normalized.match(/(?:^|_)(\d{1,3})_(?:pessoas?|vidas?|beneficiarios?)(?:_|$)/)?.[1];
  const numbers = [...String(answer).matchAll(/\b(\d{1,3})\b/g)].map((match) => Number(match[1]));
  const ages = numbers.filter((number) => number >= 0 && number <= 120);
  const lives = explicitCount ? Number(explicitCount) : ages.length;
  return { answer: String(answer).trim().slice(0, 500), lives: Math.max(0, Math.min(999, lives)) };
}
function metaProductInterest(fields) {
  return firstMetaField(fields,
    ['o_beneficiario_possui_plano_de_saude_ativo_e_quer_trocar_se_sim_qual_plano','product_interest','plano_de_interesse','operadora','interesse'],
    ['qual_plano','plano_de_saude','operadora','plano_interesse']).slice(0, 500) || null;
}
async function fetchMetaLead(leadId, token, version) {
  const { data } = await axios.get(`https://graph.facebook.com/${version}/${encodeURIComponent(leadId)}`, {
    params: { fields: META_FIELDS, access_token: token }, timeout: 15000
  });
  return data;
}
async function metaAdDetails(adId, token, version) {
  if (!adId) return {};
  try {
    const { data } = await axios.get(`https://graph.facebook.com/${version}/${encodeURIComponent(adId)}`, {
      params: { fields: 'name,campaign{name}', access_token: token }, timeout: 12000
    });
    return { adName: String(data?.name || ''), campaignName: String(data?.campaign?.name || '') };
  } catch { return {}; }
}
async function importMetaLead(value) {
  const token = String(process.env.META_PAGE_ACCESS_TOKEN || '').trim();
  const version = String(process.env.META_GRAPH_API_VERSION || '').trim();
  if (!token || !/^v\d+\.\d+$/.test(version)) throw new Error('Integracao Meta incompleta no servidor.');
  const leadId = String(value?.leadgen_id || '').trim();
  if (!leadId) return null;
  const existing = await supabase.from('marketplace_leads').select('id').eq('external_id', leadId).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data;
  const data = await fetchMetaLead(leadId, token, version);
  const fields = metaFields(data);
  const firstName = firstMetaField(fields, ['first_name','primeiro_nome']);
  const lastName = firstMetaField(fields, ['last_name','sobrenome']);
  const rawName = firstMetaField(fields, ['full_name','nome_completo','name','nome']) || [firstName, lastName].filter(Boolean).join(' ') || firstMetaField(fields, [], ['nome','name']);
  const rawPhone = firstMetaField(fields, ['phone_number','numero_de_telefone','numero_do_whatsapp','telefone','whatsapp','celular'], ['phone','telefone','whatsapp','celular']);
  const phoneDigits = rawPhone.replace(/\D/g, '');
  const validContact = Boolean(rawName) && phoneDigits.length >= 8;
  if (!validContact) {
    console.warn('[META LEAD ADS] Campos recebidos sem dados pessoais:', Object.keys(fields).join(', ') || 'nenhum');
    console.warn(`[META LEAD ADS] Lead Meta ${leadId} importado como invalido por nao conter nome ou telefone real.`);
  }
  const name = rawName || 'Lead de teste Meta';
  const phone = validContact ? phoneDigits : `meta-${leadId}`;
  const profileValue = firstMetaField(fields, ['profile','perfil','tipo_de_contratacao','tipo']).toLowerCase();
  const profile = profileValue.includes('pj') || profileValue.includes('empresa') ? 'PJ' : profileValue.includes('ades') ? 'Adesao' : 'PF';
  const qualification = metaLivesAndAges(fields);
  const settingsResult = await supabase.from('lead_marketplace_settings').select('min_price,max_price').eq('id', true).single();
  if (settingsResult.error) throw settingsResult.error;
  const low = Number(settingsResult.data.min_price || 0); const high = Number(settingsResult.data.max_price || low);
  const originalPrice = money(low + Math.random() * Math.max(0, high - low));
  const adId = String(data?.ad_id || value?.ad_id || '');
  const ad = await metaAdDetails(adId, token, version);
  const receivedAt = new Date().toISOString();
  const payload = {
    external_id: leadId, name, phone,
    email: firstMetaField(fields, ['email','e_mail'], ['email']) || null, profile, lives_count: qualification.lives,
    beneficiary_ages: qualification.answer,
    product_interest: metaProductInterest(fields),
    city: firstMetaField(fields, ['city','cidade']) || null,
    state: firstMetaField(fields, ['state','estado','uf']).slice(0, 2).toUpperCase() || null,
    campaign_name: ad.campaignName || 'Meta Lead Ads', ad_name: ad.adName || null,
    meta_page_id: String(value?.page_id || '') || null, meta_form_id: String(data?.form_id || value?.form_id || '') || null,
    meta_ad_id: adId || null, original_price: originalPrice, price: originalPrice, received_at: receivedAt,
    status: validContact ? 'available' : 'invalid'
  };
  const inserted = await supabase.from('marketplace_leads').insert(payload).select().single();
  if (inserted.error?.code === '23505') return (await supabase.from('marketplace_leads').select('id').eq('external_id', leadId).single()).data;
  if (inserted.error) throw inserted.error;
  return inserted.data;
}
function fail(res, error, fallback = 'Erro no marketplace de leads.') { console.error('[LEAD MARKETPLACE]', error?.message || error); const message = String(error?.message || ''); const known = ['Saldo insuficiente.', 'Este lead nao esta mais disponivel.', 'Usuario invalido ou inativo.', 'Usuario invalido.', 'O ajuste deixaria o saldo negativo.'].find((item) => message.includes(item)); return res.status(known ? 409 : 500).json({ ok: false, error: known || fallback }); }
function maskedName(value) { const text = String(value || '').trim(); return text ? `${text.slice(0, Math.min(3, text.length))}${'*'.repeat(Math.max(3, text.length - 3))}` : '***'; }
function maskedPhone(value) { const digits = String(value || '').replace(/\D/g, ''); return digits.length >= 4 ? `${digits.slice(0, 2)} ${'*'.repeat(Math.max(5, digits.length - 4))}${digits.slice(-2)}` : '********'; }
function publicOffer(item, minimum) { return { id: item.id, name: maskedName(item.name), phone: maskedPhone(item.phone), profile: item.profile, livesCount: Number(item.lives_count || 0), beneficiaryAges: item.beneficiary_ages, productInterest: item.product_interest, city: item.city, state: item.state, price: effectivePrice(item, minimum), originalPrice: Number(item.original_price ?? item.price), status: item.status === 'reserved' ? 'reserved' : 'available', capturedAt: item.received_at || item.created_at }; }
async function addLegacyLead(user, token, offer) { const client = await legacyBrokerAccess.ensure(user, token); const file = process.env.LEADS_FILE_PATH || path.join(process.cwd(), 'data', 'leads.json'); let items = []; try { const parsed = JSON.parse(await fs.readFile(file, 'utf8')); items = Array.isArray(parsed) ? parsed : []; } catch (error) { if (error.code !== 'ENOENT') throw error; } if (!items.some((item) => item.marketplaceLeadId === offer.id)) { const now = new Date().toISOString(); items.push({ id: crypto.randomUUID(), marketplaceLeadId: offer.id, instanceName: client.instanceName, nome: offer.name, telefone: offer.phone, email: offer.email || '', pessoaTipo: offer.profile, qtdVidas: Number(offer.lives_count || 0), planoInteresse: offer.product_interest || '', cidade: offer.city || '', status: 'novo', origem: 'Marketplace de Leads', observacao: `Lead adquirido no marketplace interno.${offer.beneficiary_ages ? `\nIdades dos beneficiários: ${offer.beneficiary_ages}` : ''}`, createdAt: now, updatedAt: now }); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(items, null, 2)}\n`, 'utf8'); } }

router.get('/api/integrations/meta/lead-ads/webhook', (req, res) => {
  const expected = String(process.env.META_WEBHOOK_VERIFY_TOKEN || '');
  if (req.query['hub.mode'] === 'subscribe' && expected && req.query['hub.verify_token'] === expected) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  return res.sendStatus(403);
});

router.post('/api/integrations/meta/lead-ads/webhook', async (req, res) => {
  if (!metaSignatureValid(req)) return res.status(401).json({ ok: false, error: 'Assinatura Meta invalida.' });
  try {
    const changes = (req.body?.entry || []).flatMap((entry) => entry.changes || []).filter((change) => change.field === 'leadgen');
    for (const change of changes) await importMetaLead(change.value);
    return res.status(200).json({ ok: true, received: changes.length });
  } catch (error) {
    console.error('[META LEAD ADS]', error?.response?.data?.error?.message || error.message || error);
    return res.status(500).json({ ok: false, error: 'Falha ao importar lead da Meta.' });
  }
});

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
    res.json({ ok: true, settings: settings.data, users: (users.data || []).map((user) => ({ ...user, balance: Number(walletMap.get(user.id)?.balance || 0) })), leads: (leads.data || []).map((lead) => ({ ...lead, effective_price: lead.status === 'sold' ? Number(lead.price) : effectivePrice(lead, settings.data.min_price) })), purchases: purchases.data || [], transactions: transactions.data || [] });
  } catch (error) { fail(res, error, 'Estrutura do marketplace ainda nao foi aplicada no Supabase.'); }
});

router.post('/api/admin/lead-marketplace/meta/backfill', requireAdmin, async (_req, res) => {
  const token = String(process.env.META_PAGE_ACCESS_TOKEN || '').trim();
  const version = String(process.env.META_GRAPH_API_VERSION || '').trim();
  if (!token || !/^v\d+\.\d+$/.test(version)) return res.status(409).json({ ok: false, error: 'Integracao Meta incompleta no servidor.' });
  try {
    const result = await supabase.from('marketplace_leads').select('id,external_id')
      .not('external_id', 'is', null).order('received_at', { ascending: false }).limit(25);
    if (result.error) throw result.error;
    let updated = 0; let skipped = 0; let failed = 0;
    for (const lead of result.data || []) {
      try {
        const data = await fetchMetaLead(lead.external_id, token, version);
        const fields = metaFields(data);
        const qualification = metaLivesAndAges(fields);
        const productInterest = metaProductInterest(fields);
        if (!qualification.answer && !productInterest) { skipped += 1; continue; }
        const changes = { updated_at: new Date().toISOString() };
        if (qualification.answer) {
          changes.beneficiary_ages = qualification.answer;
          changes.lives_count = qualification.lives;
        }
        if (productInterest) changes.product_interest = productInterest;
        const saved = await supabase.from('marketplace_leads').update(changes).eq('id', lead.id);
        if (saved.error) throw saved.error;
        updated += 1;
      } catch (error) {
        failed += 1;
        console.error('[META LEAD ADS BACKFILL]', lead.external_id, error?.response?.data?.error?.message || error.message || error);
      }
    }
    return res.json({ ok: true, updated, skipped, failed });
  } catch (error) { return fail(res, error, 'Nao foi possivel reprocessar os leads da Meta.'); }
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
  try { const { data: settings } = await supabase.from('lead_marketplace_settings').select('*').eq('id', true).single(); const low = Number(settings?.min_price || 10), high = Number(settings?.max_price || 20); const price = Math.max(low, req.body?.price === '' || req.body?.price == null ? money(low + Math.random() * (high - low)) : money(req.body.price)); const now = new Date().toISOString(); const { data, error } = await supabase.from('marketplace_leads').insert({ name, phone, email: String(req.body?.email || '').trim() || null, profile, lives_count: Math.max(0, Number(req.body?.livesCount || 0)), product_interest: String(req.body?.productInterest || '').trim() || null, city: String(req.body?.city || '').trim() || null, state: String(req.body?.state || '').trim() || null, campaign_name: String(req.body?.campaignName || '').trim() || 'Cadastro manual', original_price: price, price, received_at: now }).select().single(); if (error) throw error; res.status(201).json({ ok: true, lead: data }); } catch (error) { fail(res, error); }
});

router.patch('/api/admin/lead-marketplace/leads/:id', requireAdmin, async (req, res) => { if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'Lead invalido.' }); const payload = {}; if (req.body?.status && ['available','invalid','duplicate'].includes(req.body.status)) payload.status = req.body.status; if (req.body?.price != null) { const price = money(req.body.price); payload.price = price; payload.original_price = price; payload.received_at = new Date().toISOString(); } payload.updated_at = new Date().toISOString(); const { data, error } = await supabase.from('marketplace_leads').update(payload).eq('id', req.params.id).select().single(); if (error) return fail(res, error); res.json({ ok: true, lead: data }); });

router.get('/api/lead-marketplace', requireAccess(['broker','supervisor']), async (req, res) => {
  try { const [wallet, settings, offers] = await Promise.all([supabase.from('lead_credit_wallets').select('balance').eq('user_id', req.accessUser.id).maybeSingle(), supabase.from('lead_marketplace_settings').select('support_whatsapp,min_price').eq('id', true).single(), supabase.from('marketplace_leads').select('*').in('status', ['available','reserved']).order('received_at', { ascending: false })]); const error = wallet.error || settings.error || offers.error; if (error) throw error; const now = Date.now(); const visible = (offers.data || []).filter((item) => item.status === 'available' || Date.parse(item.reserved_until || 0) <= now || item.reserved_by === req.accessUser.id).map((item) => publicOffer(item, settings.data.min_price)); res.json({ ok: true, balance: Number(wallet.data?.balance || 0), supportWhatsapp: settings.data.support_whatsapp, leads: visible }); } catch (error) { fail(res, error); }
});

router.get('/api/lead-marketplace/history', requireAccess(['broker','supervisor']), async (req, res) => { const { data, error } = await supabase.from('marketplace_purchases').select('id,price,purchased_at,crm_lead_id,marketplace_leads(name,phone,email,profile,lives_count,beneficiary_ages,product_interest,city,state)').eq('buyer_user_id', req.accessUser.id).order('purchased_at', { ascending: false }); if (error) return fail(res, error); res.json({ ok: true, purchases: data || [] }); });
router.post('/api/lead-marketplace/:id/buy', requireAccess(['broker','supervisor']), async (req, res) => { if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'Lead invalido.' }); const { data, error } = await supabase.rpc('buy_marketplace_lead', { p_user_id: req.accessUser.id, p_lead_id: req.params.id }); if (error) return fail(res, error); try { await addLegacyLead(req.accessUser, req.accessToken, data.lead); } catch (legacyError) { console.error('[LEAD MARKETPLACE LEGACY SYNC]', legacyError.message || legacyError); } res.json({ ok: true, purchase: data }); });

module.exports = router;
