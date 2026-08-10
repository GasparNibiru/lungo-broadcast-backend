// Robust recent WhatsApp sync fallback for Lungo Corretores.
// Registers before the old recent-sync route and imports chats or contacts from Evolution.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '2.4.0-recent-sync-fallback-contacts';
const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const SYNC_LOG_FILE = process.env.CRM_RECENT_SYNC_LOG_FILE || path.join(ROOT, 'data', 'recent_conversation_sync.json');

const STATUS_LABELS = {
  novo: 'Novos',
  em_atendimento: 'Em atendimento',
  cotacao_enviada: 'Cotação enviada',
  documentacao_recebida: 'Documentação recebida',
  venda_cadastrada: 'Venda cadastrada',
  boleto_gerado: 'Boleto gerado',
  fechamento: 'Fechamento',
  venda_perdida: 'Venda perdida',
  arquivado: 'Arquivado',
  lixeira: 'Lixeira'
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-token');
}
function send(res, status, payload) { setCors(res); return res.status(status).json(payload); }
function clean(value) { return String(value || '').trim(); }
function cleanToken(value) { return clean(value).toUpperCase().replace(/\s+/g, ''); }
function slugify(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}
function generateId(prefix = 'id') { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }
function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try { const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function saveArray(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}
function findClientByToken(token) {
  const wanted = cleanToken(token);
  if (!wanted) return null;
  return loadArray(CLIENTS_FILE).find((item) => cleanToken(item.token) === wanted && item.ativo !== false) || null;
}
function publicClient(client) {
  return { nome: client.nome || client.instanceName, instanceName: client.instanceName, ativo: client.ativo !== false, whatsapp: client.whatsapp || '' };
}
function tokenFromRequest(req, body = null) {
  const auth = req.headers.authorization || '';
  if (body?.token) return String(body.token);
  if (req.query?.token) return String(req.query.token);
  if (req.query?.t) return String(req.query.t);
  if (req.headers['x-client-token']) return String(req.headers['x-client-token']);
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7);
  return '';
}
function evolutionBaseUrl() { return clean(process.env.EVOLUTION_BASE_URL).replace(/\/+$/, ''); }
function evolutionHeaders() { return { apikey: process.env.EVOLUTION_API_KEY || '', 'Content-Type': 'application/json' }; }
function ensureEvolutionConfig() {
  if (!evolutionBaseUrl()) throw new Error('EVOLUTION_BASE_URL não configurado.');
  if (!process.env.EVOLUTION_API_KEY) throw new Error('EVOLUTION_API_KEY não configurado.');
}
function buildEvolutionUrl(template, instanceName) {
  const base = evolutionBaseUrl();
  const encoded = encodeURIComponent(instanceName || '');
  const endpoint = clean(template)
    .replace(':instanceName', encoded)
    .replace('{instanceName}', encoded)
    .replace(':instance', encoded)
    .replace('{instance}', encoded);
  return `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}
function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  if (digits.length < 10 || digits.length > 15) return '';
  return digits;
}
function normalizeJid(value) {
  const jid = clean(value).toLowerCase();
  if (!jid.includes('@')) return jid;
  const [left, domain] = jid.split('@');
  const cleanLeft = left.includes(':') ? left.split(':')[0] : left;
  return `${cleanLeft}@${domain}`;
}
function jidLeft(value) { return normalizeJid(value).split('@')[0] || ''; }
function jidDomain(value) { return normalizeJid(value).split('@')[1] || ''; }
function collectStrings(value, output = [], seen = new Set()) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { output.push(String(value)); return output; }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) { value.forEach((item) => collectStrings(item, output, seen)); return output; }
  Object.values(value).forEach((child) => collectStrings(child, output, seen));
  return output;
}
function collectByKey(value, keyNames, output = [], seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) { value.forEach((item) => collectByKey(item, keyNames, output, seen)); return output; }
  Object.entries(value).forEach(([key, child]) => {
    const normalized = slugify(key).replace(/_/g, '');
    if (keyNames.includes(normalized)) output.push(child);
    collectByKey(child, keyNames, output, seen);
  });
  return output;
}
function extractArrayCandidates(value, output = [], seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    const score = value.filter((item) => item && typeof item === 'object' && collectStrings(item).some((str) => /@(s\.whatsapp\.net|lid|c\.us|g\.us)/i.test(str))).length;
    if (score) output.push({ score, items: value });
    value.forEach((item) => extractArrayCandidates(item, output, seen));
    return output;
  }
  Object.values(value).forEach((child) => extractArrayCandidates(child, output, seen));
  return output;
}
function extractItems(responseBody) {
  const direct = [responseBody, responseBody?.data, responseBody?.chats, responseBody?.contacts, responseBody?.data?.chats, responseBody?.data?.contacts, responseBody?.response, responseBody?.result, responseBody?.data?.result, responseBody?.instance?.chats, responseBody?.instance?.contacts];
  for (const item of direct) if (Array.isArray(item)) return item;
  const candidates = extractArrayCandidates(responseBody).sort((a, b) => b.score - a.score);
  return candidates[0]?.items || [];
}
function extractRemoteJid(item) {
  const values = [item?.remoteJid, item?.jid, item?.id, item?.chatId, item?.chatJid, item?.waId, item?.number, item?.phone, item?.key?.remoteJid, item?.contact?.id, item?.contact?.jid, item?.contact?.remoteJid, item?.lastMessage?.key?.remoteJid, item?.messages?.[0]?.key?.remoteJid, ...collectByKey(item, ['remotejid', 'chatjid', 'jid', 'chatid', 'waid', 'id'])].map(clean).filter(Boolean);
  const found = values.find((entry) => entry.includes('@')) || collectStrings(item).find((entry) => /@(s\.whatsapp\.net|lid|c\.us|g\.us)/i.test(entry)) || '';
  if (found) return normalizeJid(found);
  const phone = values.map(normalizePhone).find(Boolean);
  return phone ? `${phone}@s.whatsapp.net` : '';
}
function isSelfOrBadName(value) {
  const raw = clean(value);
  if (!raw) return true;
  const normalized = slugify(raw);
  if (['voce', 'voces', 'eu', 'me', 'myself', 'you', 'self', 'owner', 'whatsapp', 'unknown', 'desconhecido'].includes(normalized)) return true;
  if (raw.includes('@')) return true;
  if (/^https?:\/\//i.test(raw)) return true;
  if (/^\+?\d{8,}$/.test(raw.replace(/[\s().-]/g, ''))) return true;
  if (/^(true|false|null|undefined)$/i.test(raw)) return true;
  return false;
}
function isUsefulName(value) { const raw = clean(value); return raw.length >= 2 && raw.length <= 80 && !isSelfOrBadName(raw); }
function extractName(item) {
  const values = [item?.contact?.name, item?.contact?.pushName, item?.contact?.verifiedName, item?.name, item?.pushName, item?.verifiedName, item?.notify, item?.shortName, item?.lastMessage?.pushName, item?.messages?.[0]?.pushName, ...collectByKey(item, ['pushname', 'verifiedname', 'profilename', 'name', 'notify', 'shortname'])].map(clean).filter(Boolean);
  return values.find(isUsefulName) || '';
}
function extractProfilePic(item) {
  const values = [item?.profilePicUrl, item?.profilePictureUrl, item?.picture, item?.avatar, item?.imgUrl, item?.contact?.profilePicUrl, item?.contact?.profilePictureUrl, ...collectByKey(item, ['profilepicurl', 'profilepictureurl', 'avatar', 'picture', 'imgurl'])].map(clean).filter(Boolean);
  return values.find((entry) => /^https?:\/\//i.test(entry)) || '';
}
function extractPhone(item, remoteJid) {
  const values = [item?.number, item?.phone, item?.waId, item?.contact?.number, item?.contact?.phone, item?.contact?.waId, ...collectByKey(item, ['number', 'phone', 'phonenumber', 'waid', 'telefone', 'celular'])].map(normalizePhone).filter(Boolean);
  const domain = jidDomain(remoteJid);
  if (domain === 's.whatsapp.net' || domain === 'c.us') {
    const fromJid = normalizePhone(jidLeft(remoteJid));
    if (fromJid) values.unshift(fromJid);
  }
  return Array.from(new Set(values))[0] || '';
}
function extractMessageText(item) {
  const msg = item?.message || item?.lastMessage?.message || item?.messages?.[0]?.message || item?.lastMessage || {};
  const candidates = [item?.lastMessageText, item?.lastMessage?.text, item?.text, item?.body, msg?.conversation, msg?.extendedTextMessage?.text, msg?.imageMessage?.caption, msg?.videoMessage?.caption, msg?.documentMessage?.caption].map(clean).filter(Boolean);
  return (candidates.find(Boolean) || '').slice(0, 700);
}
function extractDate(item) {
  const raw = item?.updatedAt || item?.lastMessageAt || item?.lastMessage?.messageTimestamp || item?.messageTimestamp || item?.conversationTimestamp || item?.timestamp;
  if (!raw) return new Date().toISOString();
  if (typeof raw === 'number') { const ms = raw > 9999999999 ? raw : raw * 1000; const date = new Date(ms); return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(); }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}
function normalizeStatus(value) {
  const raw = slugify(value || 'novo');
  const aliases = { conversa_recente: 'novo', novo_lead: 'novo', novo: 'novo', novos: 'novo', atendimento: 'em_atendimento', em_atendimento: 'em_atendimento', cotacao: 'cotacao_enviada', cotacao_enviada: 'cotacao_enviada', proposta: 'cotacao_enviada', documentacao: 'documentacao_recebida', documentacao_recebida: 'documentacao_recebida', venda_cadastrada: 'venda_cadastrada', boleto: 'boleto_gerado', boleto_gerado: 'boleto_gerado', fechamento: 'fechamento', fechado: 'fechamento', perdido: 'venda_perdida', venda_perdida: 'venda_perdida', arquivado: 'arquivado', lixeira: 'lixeira', excluido: 'lixeira', deletado: 'lixeira', ignorado: 'lixeira' };
  return aliases[raw] || (STATUS_LABELS[raw] ? raw : 'novo');
}
function publicLead(lead) {
  const status = normalizeStatus(lead.status);
  return { id: lead.id, nome: lead.nome || '', telefone: lead.telefone || '', email: lead.email || '', status, statusLabel: STATUS_LABELS[status] || status, origem: lead.origem || 'WhatsApp', whatsappJid: lead.whatsappJid || '', lastMessage: lead.lastMessage || '', lastMessageAt: lead.lastMessageAt || null, createdAt: lead.createdAt || null, updatedAt: lead.updatedAt || null };
}
function findLeadIndex(leads, instanceName, remoteJid, phone = '') {
  const normalizedJid = normalizeJid(remoteJid);
  const phoneDigits = normalizePhone(phone || '');
  return leads.findIndex((lead) => {
    if (clean(lead.instanceName) !== clean(instanceName)) return false;
    if (normalizedJid && normalizeJid(lead.whatsappJid || '') === normalizedJid) return true;
    if (normalizedJid && lead.externalId === `whatsapp:${normalizedJid}`) return true;
    if (phoneDigits && normalizePhone(lead.telefone || '') === phoneDigits) return true;
    return false;
  });
}
function fallbackName(phone, remoteJid) { return phone ? `Contato ${phone}` : `Contato ${jidLeft(remoteJid) || 'WhatsApp'}`; }
function shouldReplaceName(currentName, newName) {
  const current = clean(currentName);
  const next = clean(newName);
  if (!isUsefulName(next)) return false;
  if (!current) return true;
  if (isSelfOrBadName(current)) return true;
  if (/^contato\s+/i.test(current)) return true;
  if (current.includes('@lid')) return true;
  return false;
}
function syncItemIntoLead(leads, client, item, sourceType) {
  const remoteJid = extractRemoteJid(item);
  if (!remoteJid) return { skipped: true, reason: 'jid_not_found' };
  if (remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) return { skipped: true, reason: 'group_or_status_ignored', remoteJid };
  const name = extractName(item);
  const phone = extractPhone(item, remoteJid);
  const profilePic = extractProfilePic(item);
  const lastMessage = extractMessageText(item);
  const lastMessageAt = extractDate(item);
  if (!name && !phone && !lastMessage && remoteJid.includes('@lid')) return { skipped: true, reason: 'empty_lid_ignored', remoteJid };
  const index = findLeadIndex(leads, client.instanceName, remoteJid, phone);
  const now = new Date().toISOString();
  if (index >= 0) {
    const current = leads[index];
    if (normalizeStatus(current.status || '') === 'lixeira') return { skipped: true, reason: 'trashed_lead_ignored', remoteJid };
    leads[index] = {
      ...current,
      externalId: current.externalId || `whatsapp:${remoteJid}`,
      whatsappJid: current.whatsappJid || remoteJid,
      nome: shouldReplaceName(current.nome, name) ? name : (current.nome || name || fallbackName(phone, remoteJid)),
      telefone: phone || current.telefone || '',
      profilePictureUrl: current.profilePictureUrl || profilePic || '',
      status: normalizeStatus(current.status || 'novo'),
      origem: current.origem || 'WhatsApp',
      lastMessage: lastMessage || current.lastMessage || '',
      lastMessageAt: lastMessageAt || current.lastMessageAt || now,
      lastWhatsappSyncAt: now,
      updatedAt: now
    };
    return { updated: true, lead: leads[index], remoteJid };
  }
  const lead = {
    id: generateId('lead'),
    instanceName: client.instanceName,
    externalId: `whatsapp:${remoteJid}`,
    whatsappJid: remoteJid,
    nome: name || fallbackName(phone, remoteJid),
    telefone: phone,
    email: '', pessoaTipo: '', tipoPessoa: '', cnpjOuPf: '', qtdVidas: '', valorNegocio: '', planoInteresse: '',
    profilePictureUrl: profilePic || '',
    status: 'novo', origem: sourceType === 'contacts' ? 'WhatsApp Contato' : 'WhatsApp', observacao: '', proximoRetorno: '', cidade: '', planoAtual: '', valor: '', tags: ['WhatsApp'],
    lastMessage: lastMessage || '', lastMessageAt: lastMessageAt || now, lastWhatsappSyncAt: now, createdAt: now, updatedAt: now
  };
  leads.push(lead);
  return { created: true, lead, remoteJid };
}
async function readBody(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); } });
    req.on('error', () => resolve({}));
  });
}
async function callEvolutionList(method, template, instanceName, payload = null) {
  const url = buildEvolutionUrl(template, instanceName);
  const response = await axios({ method, url, data: payload, headers: evolutionHeaders(), timeout: 30000, validateStatus: () => true });
  const items = response.status >= 200 && response.status < 300 ? extractItems(response.data) : [];
  return { status: response.status, ok: response.status >= 200 && response.status < 300, items, raw: response.data, payload, path: template, method };
}
async function fetchRecentItems(instanceName, limit) {
  ensureEvolutionConfig();
  const chatPath = process.env.EVOLUTION_FIND_CHATS_PATH || '/chat/findChats/:instanceName';
  const contactPath = process.env.EVOLUTION_FIND_CONTACTS_PATH || '/chat/findContacts/:instanceName';
  const payloads = [
    { where: {}, take: limit, skip: 0, orderBy: { updatedAt: 'desc' } },
    { take: limit, skip: 0 },
    { where: {}, limit },
    {}
  ];
  const attempts = [];
  for (const payload of payloads) {
    const attempt = await callEvolutionList('post', chatPath, instanceName, payload);
    attempts.push({ source: 'chats', status: attempt.status, count: attempt.items.length, path: attempt.path });
    if (attempt.items.length) return { sourceType: 'chats', status: attempt.status, items: attempt.items, attempts };
  }
  for (const payload of payloads) {
    const attempt = await callEvolutionList('post', contactPath, instanceName, payload);
    attempts.push({ source: 'contacts', status: attempt.status, count: attempt.items.length, path: attempt.path });
    if (attempt.items.length) return { sourceType: 'contacts', status: attempt.status, items: attempt.items, attempts };
  }
  const getAttempt = await callEvolutionList('get', contactPath, instanceName, null);
  attempts.push({ source: 'contacts_get', status: getAttempt.status, count: getAttempt.items.length, path: getAttempt.path });
  if (getAttempt.items.length) return { sourceType: 'contacts', status: getAttempt.status, items: getAttempt.items, attempts };
  return { sourceType: 'none', status: attempts[attempts.length - 1]?.status || 0, items: [], attempts };
}
function logSync(summary) {
  const logs = loadArray(SYNC_LOG_FILE);
  logs.unshift({ time: new Date().toISOString(), ...summary });
  saveArray(SYNC_LOG_FILE, logs.slice(0, 80));
}
async function syncRecent(req, res) {
  try {
    const body = await readBody(req);
    const client = findClientByToken(tokenFromRequest(req, body));
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });
    const limitInput = Number(req.query.limit || body.limit || 100);
    const limit = Math.min(Math.max(Number.isFinite(limitInput) ? limitInput : 100, 1), 300);
    const result = await fetchRecentItems(client.instanceName, limit);
    const leads = loadArray(LEADS_FILE);
    let created = 0; let updated = 0; let skipped = 0;
    const reasons = {};
    result.items.slice(0, limit).forEach((item) => {
      const outcome = syncItemIntoLead(leads, client, item, result.sourceType);
      if (outcome.created) created += 1;
      else if (outcome.updated) updated += 1;
      else { skipped += 1; reasons[outcome.reason || 'ignored'] = (reasons[outcome.reason || 'ignored'] || 0) + 1; }
    });
    saveArray(LEADS_FILE, leads);
    const clientLeads = leads.filter((lead) => clean(lead.instanceName) === clean(client.instanceName));
    const activeClientLeads = clientLeads.filter((lead) => normalizeStatus(lead.status) !== 'lixeira');
    const summary = {
      ok: true,
      client: publicClient(client), requestedLimit: limit, sourceType: result.sourceType, scanned: result.items.length, created, updated, skipped, reasons,
      evolutionStatus: result.status, attempts: result.attempts, leadCount: activeClientLeads.length, ignoredCount: clientLeads.length - activeClientLeads.length,
      leads: activeClientLeads.slice().sort((a, b) => clean(b.lastMessageAt || b.updatedAt || '').localeCompare(clean(a.lastMessageAt || a.updatedAt || ''))).slice(0, limit).map(publicLead),
      sample: activeClientLeads.sort((a, b) => clean(b.updatedAt || '').localeCompare(clean(a.updatedAt || ''))).slice(0, 5).map(publicLead),
      version: VERSION
    };
    logSync(summary);
    return send(res, 200, summary);
  } catch (error) {
    return send(res, error.response?.status || 500, { ok: false, error: error.message || 'Erro ao sincronizar conversas/contatos.', details: error.response?.data || null, version: VERSION });
  }
}
function readSyncEvents(req, res) {
  try {
    const client = findClientByToken(tokenFromRequest(req));
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });
    const events = loadArray(SYNC_LOG_FILE).filter((item) => clean(item.client?.instanceName || item.instanceName).toLowerCase() === clean(client.instanceName).toLowerCase()).slice(0, 30);
    return send(res, 200, { ok: true, client: publicClient(client), count: events.length, events, version: VERSION });
  } catch (error) { return send(res, 500, { ok: false, error: error.message || 'Erro ao ler sincronizações recentes.', version: VERSION }); }
}
function register(app) {
  if (registered) return;
  registered = true;
  app.options('/api/crm/sync-recent-conversations-browser', (req, res) => send(res, 204, {}));
  app.options('/api/crm/sync-recent-conversations', (req, res) => send(res, 204, {}));
  app.get('/api/crm/recent-sync-health', (req, res) => send(res, 200, { ok: true, module: 'crm-recent-conversation-sync', version: VERSION, fallbackContacts: true, clientsFile: CLIENTS_FILE, leadsFile: LEADS_FILE, syncLogFile: SYNC_LOG_FILE, chatsPath: process.env.EVOLUTION_FIND_CHATS_PATH || '/chat/findChats/:instanceName', contactsPath: process.env.EVOLUTION_FIND_CONTACTS_PATH || '/chat/findContacts/:instanceName', time: new Date().toISOString() }));
  app.get('/api/crm/sync-recent-conversations-browser', syncRecent);
  app.get('/api/crm/sync-recent-events', readSyncEvents);
  app.post('/api/crm/sync-recent-conversations', syncRecent);
}
function patchExpress() {
  const patchedExpress = function patchedExpress(...args) { const app = realExpress(...args); register(app); return app; };
  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}
patchExpress();
module.exports = { register };
