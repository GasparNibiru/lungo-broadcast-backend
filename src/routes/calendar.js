const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { requireAccess } = require('../middleware/require-access');

const router = express.Router();
const FILE = process.env.CALENDAR_EVENTS_FILE_PATH || (process.env.NODE_ENV === 'staging' ? '/data-staging/calendar-events.json' : path.resolve(__dirname, '../../data/calendar-events.json'));
function load() { try { const value = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; } }
function save(value) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function visible(item, user) { return item.organizationId === user.organizationId && (user.role === 'supervisor' || item.creatorId === user.id || item.audience === 'team'); }
function clean(value, max = 500) { return String(value || '').trim().slice(0, max); }

router.get('/api/calendar/events', requireAccess(['broker', 'supervisor']), (req, res) => {
  const events = load().filter((item) => visible(item, req.accessUser)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((item) => ({ ...item, reminderReceipts: undefined, canDelete: item.creatorId === req.accessUser.id }));
  res.json({ ok: true, events });
});

router.post('/api/calendar/events', requireAccess(['broker', 'supervisor']), (req, res) => {
  const title = clean(req.body?.title, 160); const startsAt = clean(req.body?.startsAt, 40); const date = new Date(startsAt);
  if (!title || !startsAt || Number.isNaN(date.getTime())) return res.status(400).json({ ok: false, error: 'Informe titulo, data e hora validos.' });
  const audience = req.accessUser.role === 'supervisor' && req.body?.audience === 'team' ? 'team' : 'self';
  const now = new Date().toISOString();
  const item = { id: crypto.randomUUID(), organizationId: req.accessUser.organizationId, creatorId: req.accessUser.id, creatorName: req.accessUser.name, creatorRole: req.accessUser.role, title, type: clean(req.body?.type, 60) || 'Compromisso', description: clean(req.body?.description, 2000), location: clean(req.body?.location, 240), startsAt: date.toISOString(), audience, reminderReceipts: {}, createdAt: now, updatedAt: now };
  const items = load(); items.push(item); save(items); res.status(201).json({ ok: true, event: item });
});

router.delete('/api/calendar/events/:id', requireAccess(['broker', 'supervisor']), (req, res) => {
  const items = load(); const index = items.findIndex((item) => item.id === req.params.id && item.organizationId === req.accessUser.organizationId);
  if (index < 0) return res.status(404).json({ ok: false, error: 'Agendamento nao encontrado.' });
  if (items[index].creatorId !== req.accessUser.id) return res.status(403).json({ ok: false, error: 'Somente quem criou pode excluir este agendamento.' });
  items.splice(index, 1); save(items); res.json({ ok: true, removed: true });
});

router.post('/api/calendar/reminders/check', requireAccess(['broker', 'supervisor']), (req, res) => {
  const now = Date.now(); const items = load(); const reminders = []; let changed = false;
  for (const item of items) {
    if (!visible(item, req.accessUser)) continue;
    const remaining = Date.parse(item.startsAt) - now;
    if (remaining < 0 || remaining > 24 * 60 * 60 * 1000) continue;
    const windowName = remaining <= 2 * 60 * 60 * 1000 ? '2h' : '24h';
    item.reminderReceipts ||= {}; item.reminderReceipts[req.accessUser.id] ||= {};
    if (item.reminderReceipts[req.accessUser.id][windowName]) continue;
    item.reminderReceipts[req.accessUser.id][windowName] = new Date().toISOString(); changed = true;
    reminders.push({ ...item, reminderWindow: windowName, reminderReceipts: undefined });
  }
  if (changed) save(items);
  res.json({ ok: true, reminders });
});

module.exports = router;
