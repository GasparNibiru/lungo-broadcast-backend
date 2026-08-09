const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const supabase = require('../database/supabase');
const { requireAccess } = require('../middleware/require-access');

const router = express.Router();
const FILE = process.env.TEAM_MESSAGES_FILE_PATH || (process.env.NODE_ENV === 'staging' ? '/data-staging/team-messages.json' : path.resolve(__dirname, '../../data/team-messages.json'));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function load() { try { const data = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(data) ? data : []; } catch { return []; } }
function save(data) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8'); }
function publicMessage(item, userId = null) { return { ...item, recipients: userId ? undefined : item.recipients, readAt: userId ? item.recipients.find((r) => r.userId === userId)?.readAt || null : undefined }; }

router.post('/api/supervisor/messages', requireAccess('supervisor'), async (req, res) => {
  const text = String(req.body?.message || '').trim(); const recipientId = String(req.body?.recipientId || 'all');
  if (!text || text.length > 2000) return res.status(400).json({ ok: false, error: 'Informe uma mensagem de até 2.000 caracteres.' });
  let query = supabase.from('users').select('id, name').eq('organization_id', req.accessUser.organizationId).eq('role', 'broker').eq('status', 'active');
  if (recipientId !== 'all') { if (!UUID.test(recipientId)) return res.status(400).json({ ok: false, error: 'Destinatário inválido.' }); query = query.eq('id', recipientId); }
  const { data: brokers, error } = await query; if (error) return res.status(500).json({ ok: false, error: 'Erro ao consultar corretores.' });
  if (!brokers?.length) return res.status(404).json({ ok: false, error: 'Nenhum corretor ativo encontrado.' });
  const now = new Date().toISOString(); const item = { id: crypto.randomUUID(), organizationId: req.accessUser.organizationId, senderId: req.accessUser.id, senderName: req.accessUser.name, message: text, audience: recipientId === 'all' ? 'all' : 'individual', recipients: brokers.map((broker) => ({ userId: broker.id, name: broker.name, readAt: null })), createdAt: now };
  const items = load(); items.push(item); save(items); res.status(201).json({ ok: true, message: publicMessage(item) });
});

router.get('/api/supervisor/messages', requireAccess('supervisor'), (req, res) => {
  const messages = load().filter((item) => item.organizationId === req.accessUser.organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map((item) => publicMessage(item));
  res.json({ ok: true, messages });
});

router.get('/api/team/messages', requireAccess('broker'), (req, res) => {
  let messages = load().filter((item) => item.organizationId === req.accessUser.organizationId && item.recipients.some((recipient) => recipient.userId === req.accessUser.id));
  if (req.query.unread === '1') messages = messages.filter((item) => !item.recipients.find((recipient) => recipient.userId === req.accessUser.id)?.readAt);
  res.json({ ok: true, messages: messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((item) => publicMessage(item, req.accessUser.id)) });
});

router.post('/api/team/messages/:id/read', requireAccess('broker'), (req, res) => {
  const items = load(); const item = items.find((entry) => entry.id === req.params.id && entry.organizationId === req.accessUser.organizationId); const recipient = item?.recipients.find((entry) => entry.userId === req.accessUser.id);
  if (!item || !recipient) return res.status(404).json({ ok: false, error: 'Mensagem não encontrada.' });
  recipient.readAt ||= new Date().toISOString(); save(items); res.json({ ok: true, readAt: recipient.readAt });
});

module.exports = router;
