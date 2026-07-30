// Mini CRM automatic recent conversations.
// Creates/updates Mini CRM entries from new WhatsApp message events and lets the user archive irrelevant conversations.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '2.0.0-auto-crm-pipeline';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const AUTO_LOG_FILE = process.env.CRM_AUTO_CONVERSATION_LOG_FILE || path.join(ROOT, 'data', 'auto_conversation_events.json');
const PUBLIC_BACKEND_URL = String(process.env.PUBLIC_BACKEND_URL || process.env.API_PUBLIC_URL || 'https://lungo-disparos-app.dzpywk.easypanel.host').replace(/\/+$/, '');

const STATUS_LABELS = {
  novo: 'Novos',
  em_atendimento: 'Em atendimento',
  cotacao_enviada: 'Cotação enviada',
  documentacao_recebida: 'Documentação recebida',
  venda_cadastrada: 'Venda cadastrada',
  boleto_gerado: 'Boleto gerado',
  fechamento: 'Fechamento',
  venda_perdida: 'Venda perdida',
  arquivado: 'Arquivado'
};

const PIPELINE_STATUSES = [
  'novo',
  'em_atendimento',
  'cotacao_enviada',
  'documentacao_recebida',
  'venda_cadastrada',
  'boleto_gerado',
  'fechamento',
  'venda_perdida'
];

const DEFAULT_AUTO_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONTACTS_UPDATE',
  'CONTACTS_UPSERT',
  'CHATS_UPDATE',
  'CHATS_UPSERT'
];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-token');
}

function send(res, status, payload) {
  setCors(res);
  return res.status(status).json(payload);
}

function clean(value) {
  return String(value || '').trim();
}

function cleanToken(value) {
  return clean(value).toUpperCase().replace(/\s+/g, '');
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

function moneyText(value) {
  const text = clean(value);
  if (!text) return '';
  return text;
}

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

function findClientByInstance(instanceName) {
  const wanted = clean(instanceName).toLowerCase();
  if (!wanted) return null;
  return loadArray(CLIENTS_FILE).find((item) => clean(item.instanceName).toLowerCase() === wanted && item.ativo !== false) || null;
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
  return { apikey: process.env.EVOLUTION_API_KEY || '', 'Content-Type': 'application/json' };
}

function ensureEvolutionConfig() {
  if (!evolutionBaseUrl()) throw new Error('EVOLUTION_BASE_URL não configurado.');
  if (!process.env.EVOLUTION_API_KEY) throw new Error('EVOLUTION_API_KEY não configurado.');
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

function autoEvents() {
  return String(process.env.CRM_AUTO_CONVERSATION_EVENTS || DEFAULT_AUTO_EVENTS.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function setAutoWebhook(instanceName, webhookUrl) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_SET_WEBHOOK_PATH || '/webhook/set/:instanceName', instanceName);
  const webhook = {
    enabled: true,
    url: webhookUrl,
    events: autoEvents(),
    headers: {},
    base64: false,
    webhookByEvents: false,
    webhook_by_events: false
  };

  const response = await axios.post(url, { webhook }, {
    headers: evolutionHeaders(),
    timeout: 30000,
    validateStatus: () => true
  });

  return { status: response.status, data: response.data, payload: { webhook } };
}

function collectStrings(value, output = [], seen = new Set()) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output, seen));
    return output;
  }
  Object.values(value).forEach((child) => collectStrings(child, output, seen));
  return output;
}

function collectByKey(value, keyNames, output = [], seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectByKey(item, keyNames, output, seen));
    return output;
  }
  Object.entries(value).forEach(([key, child]) => {
    const normalized = slugify(key).replace(/_/g, '');
    if (keyNames.includes(normalized)) output.push(child);
    collectByKey(child, keyNames, output, seen);
  });
  return output;
}

function firstData(body) {
  if (Array.isArray(body?.data)) return body.data[0] || {};
  return body?.data && typeof body.data === 'object' ? body.data : {};
}

function normalizeJid(value) {
  const jid = clean(value).toLowerCase();
  if (!jid.includes('@')) return jid;
  const [left, domain] = jid.split('@');
  const cleanLeft = left.includes(':') ? left.split(':')[0] : left;
  return `${cleanLeft}@${domain}`;
}

function jidLeft(value) {
  return normalizeJid(value).split('@')[0] || '';
}

function extractInstanceName(body, req) {
  const data = firstData(body);
  const values = [
    req.query?.instance,
    req.query?.instanceName,
    body?.instance,
    body?.instanceName,
    body?.instanceId,
    body?.sender,
    body?.data?.instance,
    body?.data?.instanceName,
    body?.data?.instanceId,
    data?.instance,
    data?.instanceName,
    data?.instanceId,
    ...collectByKey(body, ['instance', 'instancename', 'instanceid'])
  ].map(clean).filter(Boolean);
  return values[0] || '';
}

function extractRemoteJid(body) {
  const data = firstData(body);
  const values = [
    body?.jid,
    body?.remoteJid,
    body?.chatId,
    body?.chatJid,
    body?.data?.jid,
    body?.data?.remoteJid,
    body?.data?.chatId,
    body?.data?.chatJid,
    body?.data?.key?.remoteJid,
    data?.jid,
    data?.remoteJid,
    data?.chatId,
    data?.chatJid,
    data?.key?.remoteJid,
    body?.key?.remoteJid,
    ...collectByKey(body, ['remotejid', 'chatjid', 'jid', 'chatid'])
  ].map(clean).filter(Boolean);

  const found = values.find((item) => item.includes('@')) || collectStrings(body).find((item) => /@(s\.whatsapp\.net|lid|c\.us|g\.us)/i.test(item)) || values[0] || '';
  return normalizeJid(found);
}

function extractName(body) {
  const data = firstData(body);
  const values = [
    body?.name,
    body?.pushName,
    body?.verifiedName,
    body?.data?.name,
    body?.data?.pushName,
    body?.data?.verifiedName,
    data?.name,
    data?.pushName,
    data?.verifiedName,
    data?.contact?.name,
    data?.contact?.pushName,
    ...collectByKey(body, ['pushname', 'verifiedname', 'profilename', 'name'])
  ].map(clean).filter(Boolean);
  return values.find((item) => !item.includes('@') && item.length > 1 && item.length < 100) || '';
}

function extractProfilePic(body) {
  const data = firstData(body);
  const values = [
    body?.profilePicUrl,
    body?.profilePictureUrl,
    body?.avatar,
    body?.picture,
    body?.data?.profilePicUrl,
    body?.data?.profilePictureUrl,
    data?.profilePicUrl,
    data?.profilePictureUrl,
    data?.avatar,
    data?.picture,
    ...collectByKey(body, ['profilepicurl', 'profilepictureurl', 'avatar', 'picture', 'imgurl'])
  ].map(clean).filter(Boolean);
  return values.find((item) => /^https?:\/\//i.test(item)) || '';
}

function extractFromMe(body) {
  const data = firstData(body);
  const value = body?.fromMe ?? body?.data?.fromMe ?? body?.data?.key?.fromMe ?? data?.fromMe ?? data?.key?.fromMe;
  return value === true || String(value).toLowerCase() === 'true';
}

function extractMessageText(body) {
  const data = firstData(body);
  const msg = data?.message || body?.data?.message || body?.message || {};
  const type = clean(data?.messageType || body?.data?.messageType || body?.messageType || '');

  const candidates = [
    data?.text,
    body?.text,
    data?.body,
    body?.body,
    msg?.conversation,
    msg?.extendedTextMessage?.text,
    msg?.imageMessage?.caption,
    msg?.videoMessage?.caption,
    msg?.documentMessage?.caption,
    msg?.buttonsResponseMessage?.selectedDisplayText,
    msg?.listResponseMessage?.title,
    msg?.templateButtonReplyMessage?.selectedDisplayText
  ].map(clean).filter(Boolean);

  const text = candidates.find((item) => item.length > 0);
  if (text) return text.slice(0, 700);

  const normalized = type.toLowerCase();
  if (normalized.includes('image')) return '[imagem]';
  if (normalized.includes('audio')) return '[áudio]';
  if (normalized.includes('video')) return '[vídeo]';
  if (normalized.includes('document')) return '[documento]';
  if (normalized.includes('sticker')) return '[figurinha]';
  if (normalized.includes('reaction')) return '[reação]';
  return '';
}

function normalizeStatus(value) {
  const raw = slugify(value || 'novo');
  const aliases = {
    conversa: 'novo',
    conversas: 'novo',
    conversa_recente: 'novo',
    recente: 'novo',
    novo: 'novo',
    novos: 'novo',
    novo_lead: 'novo',
    lead: 'novo',
    em_atendimento: 'em_atendimento',
    atendimento: 'em_atendimento',
    cotacao: 'cotacao_enviada',
    cotacao_enviada: 'cotacao_enviada',
    proposta: 'cotacao_enviada',
    proposta_enviada: 'cotacao_enviada',
    documentacao: 'documentacao_recebida',
    documentacao_recebida: 'documentacao_recebida',
    documentos: 'documentacao_recebida',
    docs: 'documentacao_recebida',
    venda_cadastrada: 'venda_cadastrada',
    cadastro: 'venda_cadastrada',
    cadastrado: 'venda_cadastrada',
    boleto: 'boleto_gerado',
    boleto_gerado: 'boleto_gerado',
    fechamento: 'fechamento',
    fechado: 'fechamento',
    venda: 'fechamento',
    vendido: 'fechamento',
    perdido: 'venda_perdida',
    venda_perdida: 'venda_perdida',
    cancelado: 'venda_perdida',
    arquivado: 'arquivado',
    arquivo: 'arquivado',
    oculto: 'arquivado'
  };
  return aliases[raw] || (STATUS_LABELS[raw] ? raw : 'novo');
}

function leadSearchText(lead) {
  return [
    lead.nome,
    lead.telefone,
    lead.email,
    lead.pessoaTipo,
    lead.cnpjOuPf,
    lead.status,
    lead.origem,
    lead.observacao,
    lead.cidade,
    lead.planoAtual,
    lead.planoInteresse,
    lead.valor,
    lead.valorNegocio,
    lead.qtdVidas,
    lead.lastMessage,
    lead.whatsappJid,
    ...(Array.isArray(lead.tags) ? lead.tags : [])
  ].join(' ').toLowerCase();
}

function publicLead(lead) {
  const status = normalizeStatus(lead.status);
  const planoInteresse = clean(lead.planoInteresse || lead.planoAtual || '');
  const valorNegocio = moneyText(lead.valorNegocio || lead.valor || '');
  return {
    id: lead.id,
    nome: lead.nome || '',
    telefone: lead.telefone || '',
    email: lead.email || '',
    pessoaTipo: lead.pessoaTipo || lead.tipoPessoa || '',
    cnpjOuPf: lead.cnpjOuPf || lead.cnpj || lead.cpf || '',
    qtdVidas: lead.qtdVidas || lead.quantidadeVidas || '',
    valorNegocio,
    planoInteresse,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    origem: lead.origem || 'WhatsApp',
    observacao: lead.observacao || '',
    proximoRetorno: lead.proximoRetorno || '',
    cidade: lead.cidade || '',
    planoAtual: lead.planoAtual || '',
    valor: lead.valor || '',
    tags: Array.isArray(lead.tags) ? lead.tags : [],
    whatsappJid: lead.whatsappJid || '',
    externalId: lead.externalId || '',
    profilePictureUrl: lead.profilePictureUrl || '',
    lastMessage: lead.lastMessage || '',
    lastMessageAt: lead.lastMessageAt || null,
    lastMessageFromMe: Boolean(lead.lastMessageFromMe),
    archivedAt: lead.archivedAt || null,
    createdAt: lead.createdAt || null,
    updatedAt: lead.updatedAt || null
  };
}

function summarizeLeads(leads) {
  const summary = Object.fromEntries(Object.keys(STATUS_LABELS).map((status) => [status, 0]));
  leads.forEach((lead) => {
    const status = normalizeStatus(lead.status);
    summary[status] = (summary[status] || 0) + 1;
  });
  return { total: leads.length, ...summary };
}

function findLeadIndex(leads, instanceName, remoteJid, phone = '') {
  const normalizedJid = normalizeJid(remoteJid);
  const phoneDigits = normalizePhone(phone || jidLeft(remoteJid));
  return leads.findIndex((lead) => {
    if (clean(lead.instanceName) !== clean(instanceName)) return false;
    if (normalizedJid && normalizeJid(lead.whatsappJid || '') === normalizedJid) return true;
    if (normalizedJid && lead.externalId === `whatsapp:${normalizedJid}`) return true;
    if (phoneDigits && normalizePhone(lead.telefone || '') === phoneDigits) return true;
    return false;
  });
}

function shouldReplaceName(currentName, newName) {
  const current = clean(currentName);
  const next = clean(newName);
  if (!next) return false;
  if (!current) return true;
  if (/^contato\s+\d+/i.test(current)) return true;
  if (current.includes('@lid')) return true;
  return false;
}

function buildAutoLead({ client, remoteJid, body, eventName, existing = null }) {
  const now = new Date().toISOString();
  const normalizedJid = normalizeJid(remoteJid);
  const phoneFromJid = normalizedJid.includes('@s.whatsapp.net') ? normalizePhone(jidLeft(normalizedJid)) : '';
  const phoneFallback = phoneFromJid || normalizePhone(jidLeft(normalizedJid));
  const incomingName = extractName(body);
  const incomingPic = extractProfilePic(body);
  const lastMessage = extractMessageText(body);
  const fromMe = extractFromMe(body);

  const base = existing || {};
  const status = normalizeStatus(base.status || 'novo');
  const tags = Array.from(new Set([...(Array.isArray(base.tags) ? base.tags : []), 'WhatsApp'])).slice(0, 8);

  return {
    ...base,
    id: base.id || generateId('lead'),
    instanceName: client.instanceName,
    externalId: base.externalId || `whatsapp:${normalizedJid}`,
    whatsappJid: base.whatsappJid || normalizedJid,
    nome: shouldReplaceName(base.nome, incomingName) ? incomingName : (base.nome || incomingName || `Contato ${phoneFallback || jidLeft(normalizedJid) || 'WhatsApp'}`),
    telefone: base.telefone || phoneFromJid || phoneFallback || jidLeft(normalizedJid),
    email: base.email || '',
    pessoaTipo: base.pessoaTipo || base.tipoPessoa || '',
    cnpjOuPf: base.cnpjOuPf || base.cnpj || base.cpf || '',
    qtdVidas: base.qtdVidas || base.quantidadeVidas || '',
    valorNegocio: base.valorNegocio || base.valor || '',
    planoInteresse: base.planoInteresse || base.planoAtual || '',
    profilePictureUrl: base.profilePictureUrl || incomingPic || '',
    status,
    origem: base.origem || 'WhatsApp',
    observacao: base.observacao || '',
    proximoRetorno: base.proximoRetorno || '',
    cidade: base.cidade || '',
    planoAtual: base.planoAtual || '',
    valor: base.valor || '',
    tags,
    lastMessage: lastMessage || base.lastMessage || '',
    lastMessageAt: lastMessage ? now : (base.lastMessageAt || now),
    lastMessageFromMe: lastMessage ? fromMe : Boolean(base.lastMessageFromMe),
    lastEventName: eventName || base.lastEventName || '',
    lastWhatsappSyncAt: now,
    createdAt: base.createdAt || now,
    updatedAt: now
  };
}

function buildLeadFromBody(body, client, current = {}) {
  const now = new Date().toISOString();
  const nome = body.nome !== undefined ? clean(body.nome) : clean(current.nome);
  const telefone = body.telefone !== undefined ? normalizePhone(body.telefone) : clean(current.telefone);
  if (!nome || nome.length < 2) throw Object.assign(new Error('Informe o nome do lead.'), { statusCode: 400 });
  if (!telefone || telefone.length < 8) throw Object.assign(new Error('Informe um WhatsApp válido.'), { statusCode: 400 });

  const pessoaTipo = body.pessoaTipo !== undefined ? clean(body.pessoaTipo).toUpperCase() : clean(current.pessoaTipo || current.tipoPessoa || '');
  const cnpjOuPf = body.cnpjOuPf !== undefined ? clean(body.cnpjOuPf) : clean(current.cnpjOuPf || current.cnpj || current.cpf || '');
  const planoInteresse = body.planoInteresse !== undefined ? clean(body.planoInteresse) : clean(current.planoInteresse || current.planoAtual || '');
  const valorNegocio = body.valorNegocio !== undefined ? clean(body.valorNegocio) : clean(current.valorNegocio || current.valor || '');

  return {
    ...current,
    id: current.id || generateId('lead'),
    instanceName: client.instanceName,
    nome,
    telefone,
    email: body.email !== undefined ? clean(body.email) : clean(current.email || ''),
    pessoaTipo,
    tipoPessoa: pessoaTipo,
    cnpjOuPf,
    qtdVidas: body.qtdVidas !== undefined ? clean(body.qtdVidas) : clean(current.qtdVidas || current.quantidadeVidas || ''),
    valorNegocio,
    planoInteresse,
    status: body.status !== undefined ? normalizeStatus(body.status) : normalizeStatus(current.status || 'novo'),
    origem: body.origem !== undefined ? clean(body.origem) || 'Manual' : current.origem || 'Manual',
    observacao: body.observacao !== undefined ? clean(body.observacao) : current.observacao || '',
    proximoRetorno: body.proximoRetorno !== undefined ? clean(body.proximoRetorno) : current.proximoRetorno || '',
    cidade: body.cidade !== undefined ? clean(body.cidade) : current.cidade || '',
    planoAtual: body.planoAtual !== undefined ? clean(body.planoAtual) : current.planoAtual || planoInteresse,
    valor: body.valor !== undefined ? clean(body.valor) : current.valor || valorNegocio,
    tags: Array.isArray(body.tags) ? body.tags.map(clean).filter(Boolean).slice(0, 8) : Array.isArray(current.tags) ? current.tags : [],
    profilePictureUrl: current.profilePictureUrl || clean(body.profilePictureUrl || ''),
    lastMessage: current.lastMessage || '',
    lastMessageAt: current.lastMessageAt || null,
    createdAt: current.createdAt || now,
    updatedAt: now
  };
}

function logAuto(summary) {
  const logs = loadArray(AUTO_LOG_FILE);
  logs.unshift({ time: new Date().toISOString(), ...summary });
  saveArray(AUTO_LOG_FILE, logs.slice(0, 80));
}

async function readBody(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
    });
    req.on('error', () => resolve({}));
  });
}

async function handleAutoWebhook(req, res) {
  try {
    const body = await readBody(req);
    const instanceName = extractInstanceName(body, req);
    const client = findClientByInstance(instanceName);
    const eventName = clean(req.params?.eventName || body.event || body.type || firstData(body)?.event || firstData(body)?.type || 'unknown').toLowerCase();
    const remoteJid = extractRemoteJid(body);
    const fromMe = extractFromMe(body);
    const lastMessage = extractMessageText(body);

    if (!client) {
      const summary = { accepted: false, reason: 'instance_not_registered_or_missing', instanceName, eventName, route: req.path, remoteJid };
      logAuto(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    if (!remoteJid) {
      const summary = { accepted: false, reason: 'jid_not_found', instanceName: client.instanceName, eventName, route: req.path };
      logAuto(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    if (remoteJid.includes('@g.us') || remoteJid.includes('status@broadcast')) {
      const summary = { accepted: false, reason: 'group_or_status_ignored', instanceName: client.instanceName, eventName, route: req.path, remoteJid };
      logAuto(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    const leads = loadArray(LEADS_FILE);
    const index = findLeadIndex(leads, client.instanceName, remoteJid);
    const isMessageEvent = eventName.includes('messages.upsert') || eventName.includes('send.message') || eventName.includes('send_message');
    const isContactOrChatEvent = eventName.includes('contacts.') || eventName.includes('chats.') || eventName.includes('messages.update');

    if (!isMessageEvent && index < 0) {
      const summary = { accepted: false, reason: 'non_message_event_without_existing_lead', instanceName: client.instanceName, eventName, route: req.path, remoteJid };
      logAuto(summary);
      return send(res, 200, { ok: true, client: publicClient(client), ...summary, version: VERSION });
    }

    if (fromMe && index < 0) {
      const summary = { accepted: false, reason: 'outgoing_message_without_existing_lead_ignored', instanceName: client.instanceName, eventName, route: req.path, remoteJid };
      logAuto(summary);
      return send(res, 200, { ok: true, client: publicClient(client), ...summary, version: VERSION });
    }

    if (!lastMessage && index < 0) {
      const summary = { accepted: false, reason: 'empty_message_without_existing_lead_ignored', instanceName: client.instanceName, eventName, route: req.path, remoteJid };
      logAuto(summary);
      return send(res, 200, { ok: true, client: publicClient(client), ...summary, version: VERSION });
    }

    if (!isMessageEvent && !isContactOrChatEvent) {
      const summary = { accepted: false, reason: 'unsupported_event_ignored', instanceName: client.instanceName, eventName, route: req.path, remoteJid };
      logAuto(summary);
      return send(res, 200, { ok: true, client: publicClient(client), ...summary, version: VERSION });
    }

    let created = 0;
    let updated = 0;
    let lead;
    if (index >= 0) {
      lead = buildAutoLead({ client, remoteJid, body, eventName, existing: leads[index] });
      leads[index] = lead;
      updated = 1;
    } else {
      lead = buildAutoLead({ client, remoteJid, body, eventName });
      leads.push(lead);
      created = 1;
    }

    saveArray(LEADS_FILE, leads);
    const summary = {
      accepted: true,
      reason: '',
      instanceName: client.instanceName,
      eventName,
      route: req.path,
      remoteJid,
      fromMe,
      created,
      updated,
      status: lead.status,
      hasMessage: !!lastMessage,
      hasProfilePicture: !!lead.profilePictureUrl
    };
    logAuto(summary);
    return send(res, 200, { ok: true, client: publicClient(client), ...summary, lead: publicLead(lead), version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || error.response?.status || 500, { ok: false, error: error.message || 'Erro no webhook de conversas automáticas.', details: error.response?.data || null, version: VERSION });
  }
}

async function configureAutoWebhook(req, res) {
  try {
    const token = clean(req.query.token || req.query.t || '');
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const query = new URLSearchParams({ instance: client.instanceName });
    const webhookUrl = `${PUBLIC_BACKEND_URL}/api/crm/auto-conversations-webhook?${query.toString()}`;
    const result = await setAutoWebhook(client.instanceName, webhookUrl);

    return send(res, result.status >= 200 && result.status < 300 ? 200 : result.status, {
      ok: result.status >= 200 && result.status < 300,
      client: publicClient(client),
      webhookUrl,
      events: result.payload.webhook.events,
      evolutionStatus: result.status,
      evolutionResponse: result.data,
      behavior: 'Mensagens recebidas criam Novos automaticamente. Mensagens enviadas só atualizam conversas já existentes.',
      version: VERSION
    });
  } catch (error) {
    return send(res, error.statusCode || error.response?.status || 500, { ok: false, error: error.message || 'Erro ao configurar conversas automáticas.', details: error.response?.data || null, version: VERSION });
  }
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

function listAutoLeads(req, res) {
  try {
    const token = tokenFromRequest(req);
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const statusQuery = clean(req.query.status || '');
    const includeArchived = ['1', 'true', 'sim', 'yes'].includes(clean(req.query.includeArchived).toLowerCase());
    const query = clean(req.query.q || req.query.search || '').toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit || 300), 1), 1000);

    let leads = loadArray(LEADS_FILE).filter((lead) => clean(lead.instanceName) === clean(client.instanceName));
    const allForSummary = leads.slice();

    if (statusQuery) {
      const status = normalizeStatus(statusQuery);
      leads = leads.filter((lead) => normalizeStatus(lead.status) === status);
    } else if (!includeArchived) {
      leads = leads.filter((lead) => normalizeStatus(lead.status) !== 'arquivado');
    }

    if (query) leads = leads.filter((lead) => leadSearchText(lead).includes(query));

    const sorted = leads
      .sort((a, b) => String(b.lastMessageAt || b.updatedAt || b.createdAt || '').localeCompare(String(a.lastMessageAt || a.updatedAt || a.createdAt || '')))
      .slice(0, limit);

    return send(res, 200, {
      ok: true,
      client: publicClient(client),
      leads: sorted.map(publicLead),
      summary: summarizeLeads(leads),
      fullSummary: summarizeLeads(allForSummary),
      statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label, pipeline: PIPELINE_STATUSES.includes(value) })),
      pipelineStatuses: PIPELINE_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
      version: VERSION
    });
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message || 'Erro ao listar conversas.', version: VERSION });
  }
}

async function createOrUpdateManualLead(req, res, existingId = '') {
  try {
    const body = await readBody(req);
    const token = tokenFromRequest(req, body);
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const leads = loadArray(LEADS_FILE);
    const id = clean(existingId || req.params?.id || '');
    const index = id ? leads.findIndex((lead) => lead.id === id && clean(lead.instanceName) === clean(client.instanceName)) : -1;
    const current = index >= 0 ? leads[index] : {};

    if (id && index < 0) return send(res, 404, { ok: false, error: 'Lead não encontrado para este cliente.', version: VERSION });

    const lead = buildLeadFromBody(body, client, current);

    if (index >= 0) leads[index] = lead;
    else leads.push(lead);
    saveArray(LEADS_FILE, leads);

    return send(res, index >= 0 ? 200 : 201, { ok: true, lead: publicLead(lead), summary: summarizeLeads(leads.filter((item) => clean(item.instanceName) === clean(client.instanceName))), version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao salvar lead.', version: VERSION });
  }
}

async function importAutoLeads(req, res) {
  try {
    const body = await readBody(req);
    const token = tokenFromRequest(req, body);
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const incoming = Array.isArray(body.leads) ? body.leads : [];
    if (!incoming.length) return send(res, 400, { ok: false, error: 'Envie uma lista de leads para importar.', version: VERSION });

    const leads = loadArray(LEADS_FILE);
    let created = 0;
    let updated = 0;
    const errors = [];

    incoming.slice(0, 1000).forEach((item, idx) => {
      try {
        const phone = normalizePhone(item.telefone || item.whatsapp || item.celular || '');
        let index = -1;
        if (phone) {
          index = leads.findIndex((lead) => clean(lead.instanceName) === clean(client.instanceName) && normalizePhone(lead.telefone || '') === phone);
        }
        const current = index >= 0 ? leads[index] : {};
        const lead = buildLeadFromBody({ ...item, telefone: phone, origem: item.origem || 'Importação', status: item.status || 'novo' }, client, current);
        if (index >= 0) {
          leads[index] = lead;
          updated += 1;
        } else {
          leads.push(lead);
          created += 1;
        }
      } catch (error) {
        errors.push({ row: idx + 2, error: error.message });
      }
    });

    saveArray(LEADS_FILE, leads);
    return send(res, 200, {
      ok: true,
      created,
      updated,
      errors,
      summary: summarizeLeads(leads.filter((item) => clean(item.instanceName) === clean(client.instanceName))),
      version: VERSION
    });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao importar leads.', version: VERSION });
  }
}

function setLeadStatus(req, res, status, extra = {}) {
  try {
    const token = tokenFromRequest(req);
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const id = clean(req.params?.id || '');
    const leads = loadArray(LEADS_FILE);
    const index = leads.findIndex((lead) => lead.id === id && clean(lead.instanceName) === clean(client.instanceName));
    if (index < 0) return send(res, 404, { ok: false, error: 'Lead não encontrado para este cliente.', version: VERSION });

    leads[index] = { ...leads[index], ...extra, status: normalizeStatus(status), updatedAt: new Date().toISOString() };
    saveArray(LEADS_FILE, leads);
    return send(res, 200, { ok: true, lead: publicLead(leads[index]), removedFromMainView: normalizeStatus(status) === 'arquivado', version: VERSION });
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message || 'Erro ao alterar status.', version: VERSION });
  }
}

async function patchLeadStatus(req, res) {
  try {
    const body = await readBody(req);
    const status = body.status || req.query.status || '';
    if (!status) return send(res, 400, { ok: false, error: 'Informe o status.', version: VERSION });
    return setLeadStatus(req, res, status);
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message || 'Erro ao alterar status.', version: VERSION });
  }
}

function deleteAutoLead(req, res) {
  try {
    const token = tokenFromRequest(req);
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const id = clean(req.params?.id || '');
    const leads = loadArray(LEADS_FILE);
    const filtered = leads.filter((lead) => !(lead.id === id && clean(lead.instanceName) === clean(client.instanceName)));
    if (filtered.length === leads.length) return send(res, 404, { ok: false, error: 'Lead não encontrado para este cliente.', version: VERSION });
    saveArray(LEADS_FILE, filtered);
    return send(res, 200, { ok: true, removed: true, version: VERSION });
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message || 'Erro ao excluir lead.', version: VERSION });
  }
}

function readAutoEvents(req, res) {
  try {
    const token = tokenFromRequest(req);
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const events = loadArray(AUTO_LOG_FILE)
      .filter((item) => clean(item.instanceName).toLowerCase() === clean(client.instanceName).toLowerCase())
      .slice(0, 50);

    return send(res, 200, {
      ok: true,
      client: publicClient(client),
      count: events.length,
      accepted: events.filter((item) => item.accepted).length,
      created: events.filter((item) => item.created).length,
      updated: events.filter((item) => item.updated).length,
      logFile: AUTO_LOG_FILE,
      events,
      version: VERSION
    });
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message || 'Erro ao ler eventos automáticos.', version: VERSION });
  }
}

function register(app) {
  if (registered) return;
  registered = true;

  app.options('/api/crm/auto-conversations-webhook', (req, res) => send(res, 204, {}));
  app.options('/api/crm/auto-conversations-webhook/:eventName', (req, res) => send(res, 204, {}));
  app.options('/api/crm/auto-leads', (req, res) => send(res, 204, {}));
  app.options('/api/crm/auto-leads/import', (req, res) => send(res, 204, {}));
  app.options('/api/crm/auto-leads/:id', (req, res) => send(res, 204, {}));
  app.options('/api/crm/auto-leads/:id/archive', (req, res) => send(res, 204, {}));
  app.options('/api/crm/auto-leads/:id/unarchive', (req, res) => send(res, 204, {}));
  app.options('/api/crm/auto-leads/:id/status', (req, res) => send(res, 204, {}));

  app.post('/api/crm/auto-conversations-webhook', handleAutoWebhook);
  app.post('/api/crm/auto-conversations-webhook/:eventName', handleAutoWebhook);

  app.get('/api/crm/auto-conversations-health', (req, res) => send(res, 200, {
    ok: true,
    module: 'crm-auto-conversations',
    version: VERSION,
    publicBackendUrl: PUBLIC_BACKEND_URL,
    clientsFile: CLIENTS_FILE,
    leadsFile: LEADS_FILE,
    logFile: AUTO_LOG_FILE,
    events: autoEvents(),
    statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label, pipeline: PIPELINE_STATUSES.includes(value) })),
    behavior: 'Mensagens recebidas criam Novos; mensagens enviadas sem lead existente são ignoradas.',
    time: new Date().toISOString()
  }));
  app.get('/api/crm/configure-auto-conversations-browser', configureAutoWebhook);
  app.get('/api/crm/auto-conversation-events', readAutoEvents);

  app.get('/api/crm/auto-leads', listAutoLeads);
  app.post('/api/crm/auto-leads', (req, res) => createOrUpdateManualLead(req, res));
  app.post('/api/crm/auto-leads/import', importAutoLeads);
  app.put('/api/crm/auto-leads/:id', (req, res) => createOrUpdateManualLead(req, res, req.params.id));
  app.patch('/api/crm/auto-leads/:id', (req, res) => createOrUpdateManualLead(req, res, req.params.id));
  app.post('/api/crm/auto-leads/:id/status', patchLeadStatus);
  app.patch('/api/crm/auto-leads/:id/status', patchLeadStatus);
  app.post('/api/crm/auto-leads/:id/archive', (req, res) => setLeadStatus(req, res, 'arquivado', { archivedAt: new Date().toISOString() }));
  app.post('/api/crm/auto-leads/:id/unarchive', (req, res) => setLeadStatus(req, res, 'novo', { archivedAt: null }));
  app.delete('/api/crm/auto-leads/:id', deleteAutoLead);
}

function patchExpress() {
  const patchedExpress = function patchedExpress(...args) {
    const app = realExpress(...args);
    register(app);
    return app;
  };

  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}

patchExpress();

module.exports = { register };
