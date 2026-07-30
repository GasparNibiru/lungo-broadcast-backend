// Diagnostic Evolution webhook capture.
// Captures broad Evolution events and inspects nested payloads without storing message text.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '1.8.6-evolution-capture-deep-labels';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const DEFAULT_CAPTURE_LOG_FILE = process.env.LEADS_FILE_PATH
  ? path.join(path.dirname(process.env.LEADS_FILE_PATH), 'evolution_capture_events.json')
  : path.join(ROOT, 'data', 'evolution_capture_events.json');
const CAPTURE_LOG_FILE = process.env.CRM_EVOLUTION_CAPTURE_LOG_FILE || DEFAULT_CAPTURE_LOG_FILE;
const PUBLIC_BACKEND_URL = String(process.env.PUBLIC_BACKEND_URL || process.env.API_PUBLIC_URL || 'https://lungo-disparos-app.dzpywk.easypanel.host').replace(/\/+$/, '');

const DEFAULT_CAPTURE_EVENTS = [
  'APPLICATION_STARTUP',
  'QRCODE_UPDATED',
  'CONNECTION_UPDATE',
  'MESSAGES_SET',
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'MESSAGES_DELETE',
  'SEND_MESSAGE',
  'CONTACTS_SET',
  'CONTACTS_UPSERT',
  'CONTACTS_UPDATE',
  'CHATS_SET',
  'CHATS_UPSERT',
  'CHATS_UPDATE',
  'CHATS_DELETE',
  'LABELS_EDIT',
  'LABELS_ASSOCIATION'
];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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

function captureEvents() {
  return String(process.env.CRM_EVOLUTION_CAPTURE_EVENTS || DEFAULT_CAPTURE_EVENTS.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function setEvolutionCaptureWebhook(instanceName, webhookUrl) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_SET_WEBHOOK_PATH || '/webhook/set/:instanceName', instanceName);
  const webhook = {
    enabled: true,
    url: webhookUrl,
    events: captureEvents(),
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

function extractInstanceName(body, req) {
  const values = [
    req.query?.instance,
    req.query?.instanceName,
    body?.instance,
    body?.instanceName,
    body?.instanceId,
    body?.data?.instance,
    body?.data?.instanceName,
    body?.data?.instanceId,
    body?.sender
  ].map(clean).filter(Boolean);
  return values[0] || '';
}

function extractRemoteJid(body) {
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
    body?.key?.remoteJid
  ].map(clean).filter(Boolean);

  return values.find((item) => item.includes('@')) || collectStrings(body).find((item) => /@(s\.whatsapp\.net|lid|c\.us|g\.us)/i.test(item)) || values[0] || '';
}

function collectByKeyName(value, matcher, output = [], pathParts = [], seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);

  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, index) => collectByKeyName(item, matcher, output, pathParts.concat(String(index)), seen));
    return output;
  }

  Object.entries(value).forEach(([key, child]) => {
    const currentPath = pathParts.concat(key);
    const lowerKey = key.toLowerCase();
    if (matcher(lowerKey, child)) {
      output.push({ path: currentPath.join('.'), key, value: child });
    }
    collectByKeyName(child, matcher, output, currentPath, seen);
  });

  return output;
}

function extractLabelText(body) {
  const direct = [
    body?.labelId,
    body?.label_id,
    body?.label?.id,
    body?.label?.name,
    body?.labelName,
    body?.data?.labelId,
    body?.data?.label_id,
    body?.data?.label?.id,
    body?.data?.label?.name,
    body?.data?.labelName
  ].flatMap((item) => collectStrings(item)).map(clean).filter(Boolean);

  const nested = collectByKeyName(body, (key) => key.includes('label'))
    .flatMap((item) => collectStrings(item.value));

  return Array.from(new Set([...direct, ...nested].map(clean).filter(Boolean))).slice(0, 30);
}

function summarizeKeyPaths(body) {
  const interestingKeys = ['label', 'labels', 'labelid', 'labelname', 'jid', 'remotejid', 'chatid', 'pushname', 'profilename', 'profilepicurl', 'name'];
  return collectByKeyName(body, (key) => interestingKeys.some((wanted) => key.replace(/_/g, '').includes(wanted)))
    .map((item) => ({
      path: item.path,
      key: item.key,
      type: Array.isArray(item.value) ? 'array' : typeof item.value,
      sample: safeValue(item.value)
    }))
    .slice(0, 80);
}

function safeValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > 120) return `${value.slice(0, 120)}...`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';

  if (Array.isArray(value)) return value.slice(0, 3).map((item) => safeValue(item, depth + 1));

  const blockedKeys = ['apikey', 'apiKey', 'message', 'conversation', 'extendedTextMessage', 'imageMessage', 'audioMessage', 'videoMessage', 'documentMessage'];
  const result = {};
  Object.entries(value).slice(0, 30).forEach(([key, child]) => {
    if (blockedKeys.includes(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = safeValue(child, depth + 1);
    }
  });
  return result;
}

function payloadShape(body) {
  const data = body?.data;
  const dataZero = Array.isArray(data) ? data[0] : data?.[0];
  return {
    topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 30) : [],
    dataIsArray: Array.isArray(data),
    dataKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 30) : [],
    data0Keys: dataZero && typeof dataZero === 'object' ? Object.keys(dataZero).slice(0, 40) : [],
    hasMessage: !!(body?.message || body?.data?.message || body?.data?.messageType || dataZero?.message || dataZero?.messageType),
    hasContact: !!(body?.contact || body?.data?.contact || body?.data?.Contact || dataZero?.contact || dataZero?.Contact),
    hasLabels: !!(body?.labels || body?.data?.labels || body?.label || body?.data?.label || dataZero?.labels || dataZero?.label)
  };
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

function logCapture(summary) {
  const logs = loadArray(CAPTURE_LOG_FILE);
  logs.unshift({ time: new Date().toISOString(), ...summary });
  saveArray(CAPTURE_LOG_FILE, logs.slice(0, 80));
}

async function handleCapture(req, res) {
  try {
    const body = await readBody(req);
    const instanceName = extractInstanceName(body, req);
    const client = findClientByInstance(instanceName);
    const eventName = clean(req.params?.eventName || body.event || body.type || body?.data?.event || body?.data?.type || 'unknown');
    const remoteJid = extractRemoteJid(body);
    const labelCandidates = extractLabelText(body);
    const summary = {
      accepted: !!client,
      reason: client ? '' : 'instance_not_registered_or_missing',
      instanceName,
      clientName: client?.nome || '',
      eventName,
      route: req.path,
      remoteJid,
      labelCandidates,
      likelyMiniCrmLabel: labelCandidates.some((item) => String(item).toLowerCase().replace(/\s+/g, '') === 'minicrm' || String(item) === '5'),
      payloadShape: payloadShape(body),
      keyPaths: summarizeKeyPaths(body),
      safePreview: safeValue(body)
    };

    logCapture(summary);
    return send(res, 200, { ok: true, client: client ? publicClient(client) : null, ...summary, version: VERSION });
  } catch (error) {
    return send(res, error.response?.status || 500, { ok: false, error: error.message || 'Erro no capturador de eventos.', details: error.response?.data || null, version: VERSION });
  }
}

async function configureCaptureWebhook(req, res) {
  try {
    const token = clean(req.query.token || req.query.t || '');
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const query = new URLSearchParams({ instance: client.instanceName });
    const webhookUrl = `${PUBLIC_BACKEND_URL}/api/crm/evolution-capture-webhook?${query.toString()}`;
    const result = await setEvolutionCaptureWebhook(client.instanceName, webhookUrl);

    return send(res, result.status >= 200 && result.status < 300 ? 200 : result.status, {
      ok: result.status >= 200 && result.status < 300,
      client: publicClient(client),
      webhookUrl,
      events: result.payload.webhook.events,
      evolutionStatus: result.status,
      evolutionResponse: result.data,
      warning: 'Esta rota é apenas diagnóstico. Ela troca temporariamente o webhook da instância para capturar eventos amplos.',
      version: VERSION
    });
  } catch (error) {
    return send(res, error.response?.status || 500, { ok: false, error: error.message || 'Erro ao configurar capturador.', details: error.response?.data || null, version: VERSION });
  }
}

function readCaptureEvents(req, res) {
  try {
    const token = clean(req.query.token || req.query.t || '');
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const includePreview = clean(req.query.preview).toLowerCase() === '1' || clean(req.query.preview).toLowerCase() === 'true';
    const events = loadArray(CAPTURE_LOG_FILE)
      .filter((item) => clean(item.instanceName).toLowerCase() === clean(client.instanceName).toLowerCase())
      .slice(0, 20)
      .map((item) => includePreview ? item : {
        time: item.time,
        accepted: item.accepted,
        reason: item.reason,
        instanceName: item.instanceName,
        clientName: item.clientName,
        eventName: item.eventName,
        route: item.route,
        remoteJid: item.remoteJid,
        labelCandidates: item.labelCandidates,
        likelyMiniCrmLabel: item.likelyMiniCrmLabel,
        payloadShape: item.payloadShape,
        keyPaths: item.keyPaths
      });

    return send(res, 200, {
      ok: true,
      client: publicClient(client),
      count: events.length,
      accepted: events.filter((item) => item.accepted).length,
      withLabels: events.filter((item) => Array.isArray(item.labelCandidates) && item.labelCandidates.length > 0).length,
      likelyMiniCrm: events.filter((item) => item.likelyMiniCrmLabel).length,
      logFile: CAPTURE_LOG_FILE,
      events,
      version: VERSION
    });
  } catch (error) {
    return send(res, 500, { ok: false, error: error.message || 'Erro ao ler eventos capturados.', version: VERSION });
  }
}

function register(app) {
  if (registered) return;
  registered = true;

  app.options('/api/crm/evolution-capture-webhook', (req, res) => send(res, 204, {}));
  app.options('/api/crm/evolution-capture-webhook/:eventName', (req, res) => send(res, 204, {}));
  app.post('/api/crm/evolution-capture-webhook', handleCapture);
  app.post('/api/crm/evolution-capture-webhook/:eventName', handleCapture);

  app.get('/api/crm/evolution-capture-health', (req, res) => send(res, 200, {
    ok: true,
    module: 'crm-evolution-capture',
    version: VERSION,
    publicBackendUrl: PUBLIC_BACKEND_URL,
    logFile: CAPTURE_LOG_FILE,
    defaultEvents: captureEvents(),
    time: new Date().toISOString()
  }));
  app.get('/api/crm/configure-capture-webhook-browser', configureCaptureWebhook);
  app.get('/api/crm/evolution-capture-events', readCaptureEvents);
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
