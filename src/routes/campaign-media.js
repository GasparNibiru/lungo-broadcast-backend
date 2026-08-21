const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const requireAdmin = require('../middleware/require-admin');
const { requireAccess } = require('../middleware/require-access');

const router = express.Router();
const dataDir = process.env.NODE_ENV === 'staging' ? '/data-staging' : process.env.NODE_ENV === 'production' ? '/data' : path.resolve(__dirname, '../../data');
const file = process.env.CAMPAIGN_MEDIA_FILE_PATH || path.join(dataDir, 'campaign-media.json');
const empty = () => ({ banner: null, popup: null });

function load() { try { return { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return empty(); } }
function save(value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(temporary, file); }
function validImage(value) { return /^data:image\/(?:png|jpe?g|webp);base64,/i.test(String(value || '')) && String(value).length <= 3500000; }
function active(item, now = Date.now()) { if (!item?.active || !item.image) return false; const start = item.startAt ? Date.parse(item.startAt) : 0; const end = item.endAt ? Date.parse(item.endAt) : 0; return (!start || start <= now) && (!end || end >= now); }
function publicValue(value) { return { banner: active(value.banner) ? value.banner : null, popup: active(value.popup) ? value.popup : null }; }
function campaign(body, current, type) {
  if (body.remove === true) return null;
  const image = String(body.image ?? current?.image ?? '');
  if (!validImage(image)) throw Object.assign(new Error('Envie uma imagem PNG, JPG ou WebP válida.'), { statusCode: 400 });
  const startAt = type === 'popup' && body.startAt ? new Date(body.startAt).toISOString() : null;
  const endAt = type === 'popup' && body.endAt ? new Date(body.endAt).toISOString() : null;
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) throw Object.assign(new Error('O encerramento deve ser posterior ao início.'), { statusCode: 400 });
  return { id: body.image && body.image !== current?.image ? crypto.randomUUID() : current?.id || crypto.randomUUID(), type, image, active: body.active !== false, startAt, endAt, updatedAt: new Date().toISOString() };
}

router.get('/api/campaign-media', requireAccess(['supervisor', 'broker']), (req, res) => res.json({ ok: true, campaigns: publicValue(load()) }));
router.get('/api/admin/campaign-media', requireAdmin, (req, res) => res.json({ ok: true, campaigns: load() }));
router.put('/api/admin/campaign-media/:type', requireAdmin, (req, res, next) => {
  try { const type = req.params.type; if (!['banner', 'popup'].includes(type)) return res.status(400).json({ ok: false, error: 'Tipo de campanha inválido.' }); const value = load(); value[type] = campaign(req.body || {}, value[type], type); save(value); res.json({ ok: true, campaign: value[type] }); }
  catch (error) { next(error); }
});

module.exports = router;
