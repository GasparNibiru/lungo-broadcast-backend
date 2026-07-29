// Lungo Mini CRM WhatsApp label sync add-on.
// Adds routes to import only chats marked with the WhatsApp label "MiniCRM".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const realExpress = require('express');

let routesRegistered = false;

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const SYNC_VERSION = '1.7.0';
const DEFAULT_LABEL = process.env.CRM_WHATSAPP_LABEL || 'MiniCRM';
const DEFAULT_SYNC_LIMIT = Number(process.env.CRM_SYNC_LIMIT || 500);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-token');
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  return res.status(statusCode).json(payload);
}

function appError(message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function cleanToken(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function cleanText(value) {
  return String(value || '').trim();
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'item';
}

function cellToPlainText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value).toString();
  let text = String(value).trim().replace(/\u00A0/g, ' ');
  if (text.startsWith("'")) text = text.slice(1);
  if (/^\d+\.0+$/.test(text)) return text.replace(/\.0+$/, '');
  const compact = text.replace(/\s/g, '').replace(',', '.');
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(compact)) {
    const parsed = Number(compact);
    if (Number.isFinite(parsed)) return Math.trunc(parsed).toString();
  }
  return text;
}

function normalizePhone(value) {
  let digits = cellToPlainText(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  return digits;
}

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function loadJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveJsonArray(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function loadClients() {
  return loadJsonArray(CLIENTS_FILE);
}

function loadLeads() {
  return loadJsonArray(LEADS_FILE);
}

function saveLeads(leads) {
  saveJsonArray(LEADS_FILE, leads);
}

function findClientByToken(token) {
  const clean = cleanToken(token);
  if (!clean) return null;
  return loadClients().find((item) => cleanToken(item.token) === clean && item.ativo !== false) || null;
}

function getTokenFromRequest(req, parsedBody = null) {
  const headerToken = req.headers['x-client-token'];
  const auth = req.headers.authorization || '';
  if (parsedBody?.token) return String(parsedBody.token);
  if (req.query?.token) return String(req.query.token);
  if (headerToken) return String(headerToken);
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7);
  return '';
}

function publicClient(client) {
  return {
    nome: client.nome || client.instanceName,
    instanceName: client.instanceName,
    ativo: client.ativo !== false,
    whatsapp: client.whatsapp || ''
  };
}

function evolutionBaseUrl() {
  return String(process.env.EVOLUTION_BASE_URL || '').replace(/\/+$/, '');
}

function evolutionHeaders() {
  return {
    apikey: process.env.EVOLUTION_API_KEY || '',
    'Content-Type': 'application/json'
  };
}

function buildEvolutionUrl(template, instanceName) {
  const base = evolutionBaseUrl();
  const encoded = encodeURIComponent(instanceName || '');
  const endpoint = String(template || '')
    .replace(':instanceName', encoded)
    .replace('{instanceName}', encoded)
    .replace(':instance', encoded)
    .replace('{instance}', encoded);
  return `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

function ensureEvolutionConfig() {
  if (!evolutionBaseUrl()) throw appError('EVOLUTION_BASE_URL não configurado.', 500);
  if (!process.env.EVOLUTION_API_KEY) throw appError('EVOLUTION_API_KEY não configurado.', 500);
}

async function readJsonBody(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

async function findEvolutionLabels(instanceName) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_FIND_LABELS_PATH || '/label/findLabels/:instanceName', instanceName);
  const response = await axios.get(url, { headers: evolutionHeaders(), timeout: 30000 });
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.labels)) return data.labels;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function findEvolutionChats(instanceName, limit = DEFAULT_SYNC_LIMIT) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_FIND_CHATS_PATH || '/chat/findChats/:instanceName', instanceName);
  const take = Math.min(Math.max(Number(limit) || DEFAULT_SYNC_LIMIT, 1), 1000);
  const response = await axios.post(url, {
    where: {},
    take,
    skip: 0,
    orderBy: { updatedAt: 'desc' }
  }, { headers: evolutionHeaders(), timeout: 60000 });

  const data = response.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.chats)) return data.chats;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function labelMatches(value, targetName, targetLabel) {
  if (value === null || value === undefined) return false;
  const targetSlug = slugify(targetName);
  const targetId = String(targetLabel?.id || '').toLowerCase();

  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value || '').trim();
    return slugify(text) === targetSlug || (!!targetId && text.toLowerCase() === targetId);
  }

  if (Array.isArray(value)) return value.some((item) => labelMatches(item, targetName, targetLabel));

  if (typeof value === 'object') {
    const possible = [value.name, value.label, value.title, value.id, value.labelId, value.label_id, value.value];
    if (possible.some((item) => labelMatches(item, targetName, targetLabel))) return true;
    if (Array.isArray(value.labels) && labelMatches(value.labels, targetName, targetLabel)) return true;
    if (Array.isArray(value.Tags) && labelMatches(value.Tags, targetName, targetLabel)) return true;
  }

  return false;
}

function chatHasLabel(chat, labelName, targetLabel) {
  if (!chat || typeof chat !== 'object') return false;
  const buckets = [
    chat.labels,
    chat.label,
    chat.Label,
    chat.Labels,
    chat.tags,
    chat.Tags,
    chat.labelId,
    chat.labelIds,
    chat.labelsId,
    chat.whatsappLabels,
    chat.chatLabels,
    chat.metadata?.labels,
    chat.contact?.labels
  ];
  return buckets.some((bucket) => labelMatches(bucket, labelName, targetLabel));
}

function extractRemoteJid(chat) {
  return cleanText(
    chat.remoteJid ||
    chat.jid ||
    chat.id ||
    chat.chatId ||
    chat.key?.remoteJid ||
    chat.contact?.remoteJid ||
    chat.contact?.id ||
    ''
  );
}

function extractLeadName(chat, phone) {
  const name = cleanText(
    chat.name ||
    chat.pushName ||
    chat.verifiedName ||
    chat.contact?.name ||
    chat.contact?.pushName ||
    chat.contact?.verifiedName ||
    chat.profileName ||
    ''
  );
  return name || `Contato ${phone}`;
}

function buildLeadFromChat(chat, client, labelName) {
  const remoteJid = extractRemoteJid(chat);
  if (!remoteJid || remoteJid.includes('@g.us')) return null;
  const phone = normalizePhone(remoteJid.split('@')[0]);
  if (!phone || phone.length < 10) return null;

  const now = new Date().toISOString();
  const lastText = cleanText(
    chat.lastMessage?.message?.conversation ||
    chat.lastMessage?.text ||
    chat.lastMessage?.messageText ||
    chat.lastMessage?.message?.extendedTextMessage?.text ||
    chat.messages?.[0]?.message?.conversation ||
    ''
  );

  return {
    id: generateId('lead'),
    instanceName: client.instanceName,
    externalId: `whatsapp:${remoteJid}`,
    whatsappJid: remoteJid,
    nome: extractLeadName(chat, phone),
    telefone: phone,
    status: 'novo_lead',
    origem: `WhatsApp etiqueta ${labelName}`,
    observacao: lastText ? `Sincronizado do WhatsApp. Última mensagem: ${lastText.slice(0, 240)}` : 'Sincronizado do WhatsApp pela etiqueta MiniCRM.',
    proximoRetorno: '',
    cidade: '',
    planoAtual: '',
    valor: '',
    tags: [labelName, 'WhatsApp'],
    createdAt: now,
    updatedAt: now,
    lastWhatsappSyncAt: now
  };
}

function upsertLeadsFromChats(currentLeads, client, chats, labelName) {
  const instanceName = cleanText(client.instanceName);
  let created = 0;
  let updated = 0;
  let ignored = 0;

  chats.forEach((chat) => {
    const incoming = buildLeadFromChat(chat, client, labelName);
    if (!incoming) {
      ignored += 1;
      return;
    }

    const index = currentLeads.findIndex((lead) => (
      cleanText(lead.instanceName) === instanceName &&
      (
        (incoming.externalId && lead.externalId === incoming.externalId) ||
        (incoming.whatsappJid && lead.whatsappJid === incoming.whatsappJid) ||
        (incoming.telefone && normalizePhone(lead.telefone) === incoming.telefone)
      )
    ));

    if (index >= 0) {
      const existing = currentLeads[index];
      const mergedTags = Array.from(new Set([...(Array.isArray(existing.tags) ? existing.tags : []), labelName, 'WhatsApp'])).slice(0, 8);
      currentLeads[index] = {
        ...existing,
        nome: existing.nome || incoming.nome,
        telefone: existing.telefone || incoming.telefone,
        externalId: existing.externalId || incoming.externalId,
        whatsappJid: existing.whatsappJid || incoming.whatsappJid,
        origem: existing.origem || incoming.origem,
        tags: mergedTags,
        lastWhatsappSyncAt: incoming.lastWhatsappSyncAt,
        updatedAt: incoming.updatedAt
      };
      updated += 1;
      return;
    }

    currentLeads.push(incoming);
    created += 1;
  });

  return { created, updated, ignored };
}

function handleRouteError(res, error) {
  console.error('[CRM SYNC ERROR]', error.response?.data || error.message || error);
  return sendJson(res, error.statusCode || error.response?.status || 500, {
    ok: false,
    error: error.message || 'Erro ao sincronizar WhatsApp.',
    details: error.details || error.response?.data || null
  });
}

function registerWhatsAppSyncRoutes(app) {
  if (routesRegistered) return;
  routesRegistered = true;

  const optionsHandler = (req, res) => sendJson(res, 204, {});
  app.options('/api/crm/sync-health', optionsHandler);
  app.options('/api/crm/whatsapp/labels', optionsHandler);
  app.options('/api/crm/sync-whatsapp-label', optionsHandler);

  app.get('/api/crm/sync-health', (req, res) => {
    return sendJson(res, 200, {
      ok: true,
      status: 'online',
      module: 'crm-whatsapp-sync',
      version: SYNC_VERSION,
      defaultLabel: DEFAULT_LABEL,
      time: new Date().toISOString()
    });
  });

  app.get('/api/crm/whatsapp/labels', async (req, res) => {
    try {
      const client = findClientByToken(getTokenFromRequest(req));
      if (!client) throw appError('Token inválido ou inativo.', 403);
      const labels = await findEvolutionLabels(client.instanceName);
      return sendJson(res, 200, { ok: true, client: publicClient(client), labels, count: labels.length });
    } catch (error) {
      return handleRouteError(res, error);
    }
  });

  app.post('/api/crm/sync-whatsapp-label', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const client = findClientByToken(getTokenFromRequest(req, body));
      if (!client) throw appError('Token inválido ou inativo.', 403);

      const labelName = cleanText(body.labelName || body.label || DEFAULT_LABEL) || DEFAULT_LABEL;
      const limit = Number(body.limit || DEFAULT_SYNC_LIMIT);
      const labels = await findEvolutionLabels(client.instanceName);
      const targetLabel = labels.find((item) => slugify(item?.name || item?.label || item?.title || item?.id) === slugify(labelName)) || null;

      if (!targetLabel && body.requireExistingLabel !== false) {
        return sendJson(res, 404, {
          ok: false,
          error: `Etiqueta "${labelName}" não encontrada no WhatsApp conectado.`,
          labels,
          hint: `Crie/adicione a etiqueta "${labelName}" no WhatsApp Business e marque as conversas que devem entrar no Mini CRM.`
        });
      }

      const chats = await findEvolutionChats(client.instanceName, limit);
      const matchedChats = chats.filter((chat) => chatHasLabel(chat, labelName, targetLabel));
      const leads = loadLeads();
      const result = upsertLeadsFromChats(leads, client, matchedChats, labelName);
      saveLeads(leads);

      return sendJson(res, 200, {
        ok: true,
        client: publicClient(client),
        labelName,
        label: targetLabel,
        scannedChats: chats.length,
        matchedChats: matchedChats.length,
        created: result.created,
        updated: result.updated,
        ignored: result.ignored,
        warning: matchedChats.length === 0 ? 'Nenhuma conversa com essa etiqueta foi retornada pela Evolution. Confirme se as conversas estão marcadas com MiniCRM e se o endpoint findChats retorna labels.' : null
      });
    } catch (error) {
      return handleRouteError(res, error);
    }
  });
}

function patchExpress() {
  const patchedExpress = function patchedExpress(...args) {
    const app = realExpress(...args);
    registerWhatsAppSyncRoutes(app);
    return app;
  };

  Object.keys(realExpress).forEach((key) => {
    patchedExpress[key] = realExpress[key];
  });

  require.cache[require.resolve('express')].exports = patchedExpress;
}

patchExpress();

module.exports = { registerWhatsAppSyncRoutes };
