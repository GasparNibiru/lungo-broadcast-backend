// Diagnostic Evolution webhook capture.
// Captures broad Evolution events to verify whether the instance is delivering webhooks after persistence changes.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '1.8.5-evolution-capture';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const CAPTURE_LOG_FILE = process.env.CRM_EVOLUTION_CAPTURE_LOG_FILE || path.join(ROOT, 'data', 'evolution_capture_events.json');
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

function extractLabelText(body) {
  const values = [
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
  return Array.from(new Set(values)).slice(0, 10);
}

function payloadShape(body) {
  return {
    topLevelKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 30) : [],
    dataKeys: body?.data && typeof body.data === 'object' ? Object.keys(body.data).slice(0, 30) : [],
    hasMessage: !!(body?.message || body?.data?.message || body?.data?.messageType),
    hasContact: !!(body?.contact || body?.data?.contact || body?.data?.Contact),
    hasLabels: !!(body?.labels || body?.data?.labels || body?.label || body?.data?.label)
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
    const summary = {
      accepted: !!client,
      reason: client ? '' : 'instance_not_registered_or_missing',
      instanceName,
      clientName: client?.nome || '',
      eventName,
      route: req.path,
      remoteJid,
      labelCandidates: extractLabelText(body),
      payloadShape: payloadShape(body)
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

    const events = loadArray(CAPTURE_LOG_FILE)
      .filter((item) => clean(item.instanceName).toLowerCase() === clean(client.instanceName).toLowerCase())
      .slice(0, 50);

    return send(res, 200, {
      ok: true,
      client: publicClient(client),
      count: events.length,
      accepted: events.filter((item) => item.accepted).length,
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
