const express = require('express');
const supabase = require('../database/supabase');
const requireAdmin = require('../middleware/require-admin');
const { requireAccess } = require('../middleware/require-access');

const router = express.Router();
const STATES = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = 'id,name,state,contact_name,whatsapp,products,notes,active,sort_order,created_at,updated_at';

function payload(body = {}, partial = false) {
  const result = {};
  const set = (source, target, value) => { if (!partial || source in body) result[target] = value; };
  set('name', 'name', String(body.name || '').trim().slice(0, 160));
  set('state', 'state', String(body.state || '').trim().toUpperCase());
  set('contactName', 'contact_name', String(body.contactName || '').trim().slice(0, 120) || null);
  set('whatsapp', 'whatsapp', String(body.whatsapp || '').replace(/\D/g, '').slice(0, 15));
  set('products', 'products', (Array.isArray(body.products) ? body.products : String(body.products || '').split(/[,\n]/)).map(v => String(v).trim().slice(0, 100)).filter(Boolean).slice(0, 60));
  set('notes', 'notes', String(body.notes || '').trim().slice(0, 2000) || null);
  if (!partial || 'active' in body) result.active = body.active !== false;
  set('sortOrder', 'sort_order', Math.max(0, Math.min(9999, Number(body.sortOrder) || 0)));
  result.updated_at = new Date().toISOString();
  return result;
}
function valid(item, partial = false) { const has = key => Object.prototype.hasOwnProperty.call(item, key); return (partial || item.name) && (partial || STATES.has(item.state)) && (partial || /^\d{10,15}$/.test(item.whatsapp)) && (!has('name') || Boolean(item.name)) && (!has('state') || STATES.has(item.state)) && (!has('whatsapp') || /^\d{10,15}$/.test(item.whatsapp)); }
function fail(res, error) { console.error('[BRAZIL PARTNERS]', error.message || error); return res.status(500).json({ ok: false, error: 'Não foi possível acessar a rede de parceiros.' }); }

router.get('/api/brazil-partners', requireAccess('supervisor'), async (_req, res) => { const { data, error } = await supabase.from('brazil_partners').select(fields).eq('active', true).order('state').order('sort_order').order('name'); if (error) return fail(res, error); res.json({ ok: true, partners: data || [] }); });
router.get('/api/admin/brazil-partners', requireAdmin, async (_req, res) => { const { data, error } = await supabase.from('brazil_partners').select(fields).order('state').order('sort_order').order('name'); if (error) return fail(res, error); res.json({ ok: true, partners: data || [] }); });
router.post('/api/admin/brazil-partners', requireAdmin, async (req, res) => { const item = payload(req.body); if (!valid(item)) return res.status(400).json({ ok: false, error: 'Informe nome, UF e WhatsApp válido com DDD.' }); const { data, error } = await supabase.from('brazil_partners').insert(item).select(fields).single(); if (error) return fail(res, error); res.status(201).json({ ok: true, partner: data }); });
router.patch('/api/admin/brazil-partners/:id', requireAdmin, async (req, res) => { if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'Parceiro inválido.' }); const item = payload(req.body, true); if (!valid(item, true)) return res.status(400).json({ ok: false, error: 'Dados do parceiro inválidos.' }); const { data, error } = await supabase.from('brazil_partners').update(item).eq('id', req.params.id).select(fields).single(); if (error) return fail(res, error); res.json({ ok: true, partner: data }); });
router.delete('/api/admin/brazil-partners/:id', requireAdmin, async (req, res) => { if (!UUID.test(req.params.id)) return res.status(400).json({ ok: false, error: 'Parceiro inválido.' }); const { error } = await supabase.from('brazil_partners').delete().eq('id', req.params.id); if (error) return fail(res, error); res.json({ ok: true }); });

module.exports = router;
