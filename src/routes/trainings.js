const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const requireAdmin = require('../middleware/require-admin');
const { requireAccess } = require('../middleware/require-access');

const router = express.Router();
const TRAININGS_FILE = process.env.TRAININGS_FILE_PATH || (process.env.NODE_ENV === 'staging' ? '/data-staging/trainings.json' : path.resolve(__dirname, '../../data/trainings.json'));

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TRAININGS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function save(items) {
  fs.mkdirSync(path.dirname(TRAININGS_FILE), { recursive: true });
  fs.writeFileSync(TRAININGS_FILE, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function youtubeId(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtu.be')) return parsed.pathname.slice(1).split('/')[0];
    if (parsed.hostname.includes('youtube.com')) return parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop();
  } catch {}
  return '';
}

function payload(body, current = {}) {
  const title = String(body.title ?? current.title ?? '').trim();
  const url = String(body.url ?? current.url ?? '').trim();
  const track = String(body.track ?? current.track ?? 'Geral').trim() || 'Geral';
  const description = String(body.description ?? current.description ?? '').trim();
  const stars = Math.max(0, Math.min(5, Number(body.stars ?? current.stars ?? 0) || 0));
  const order = Math.max(0, Number(body.order ?? current.order ?? 0) || 0);
  if (title.length < 2) throw Object.assign(new Error('Informe o nome do treinamento.'), { statusCode: 400 });
  if (!youtubeId(url)) throw Object.assign(new Error('Informe um link válido do YouTube.'), { statusCode: 400 });
  return { ...current, title, url, youtubeId: youtubeId(url), track, description, stars, order, active: body.active === undefined ? current.active !== false : Boolean(body.active) };
}

router.get('/api/trainings', requireAccess(['supervisor', 'broker']), (req, res) => {
  const trainings = load().filter((item) => item.active !== false).sort((a, b) => a.track.localeCompare(b.track) || a.order - b.order || a.title.localeCompare(b.title));
  res.json({ ok: true, trainings });
});

router.get('/api/admin/trainings', requireAdmin, (req, res) => res.json({ ok: true, trainings: load() }));
router.post('/api/admin/trainings', requireAdmin, (req, res, next) => {
  try {
    const items = load();
    const now = new Date().toISOString();
    const item = payload(req.body);
    Object.assign(item, { id: crypto.randomUUID(), createdAt: now, updatedAt: now });
    items.push(item); save(items);
    res.status(201).json({ ok: true, training: item });
  } catch (error) { next(error); }
});
router.patch('/api/admin/trainings/:id', requireAdmin, (req, res, next) => {
  try {
    const items = load(); const index = items.findIndex((item) => item.id === req.params.id);
    if (index < 0) return res.status(404).json({ ok: false, error: 'Treinamento não encontrado.' });
    items[index] = { ...payload(req.body, items[index]), updatedAt: new Date().toISOString() };
    save(items); res.json({ ok: true, training: items[index] });
  } catch (error) { next(error); }
});
router.delete('/api/admin/trainings/:id', requireAdmin, (req, res) => {
  const items = load(); const next = items.filter((item) => item.id !== req.params.id);
  if (next.length === items.length) return res.status(404).json({ ok: false, error: 'Treinamento não encontrado.' });
  save(next); res.json({ ok: true });
});

module.exports = router;
