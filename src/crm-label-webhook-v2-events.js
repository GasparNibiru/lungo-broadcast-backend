// Mini CRM label webhook v2 event log reader.
// Adds a browser-friendly route to inspect events saved by crm-label-webhook-v2.

const fs = require('fs');
const path = require('path');
const realExpress = require('express');

let registered = false;
const VERSION = '1.8.4-v2-events-reader';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LOG_FILE = process.env.CRM_LABEL_WEBHOOK_LOG_FILE || path.join(ROOT, 'data', 'label_webhook_events.json');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
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

function findClientByToken(token) {
  const wanted = cleanToken(token);
  if (!wanted) return null;
  return loadArray(CLIENTS_FILE).find((item) => cleanToken(item.token) === wanted && item.ativo !== false) || null;
}

function publicClient(client) {
  return {
    nome: client.nome || client.instanceName,
    instanceName: client.instanceName,
    ativo: client.ativo !== false,
    whatsapp: client.whatsapp || ''
  };
}

function listV2Events(req, res) {
  const token = clean(req.query.token || req.query.t || '');
  const client = findClientByToken(token);
  if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

  const allEvents = loadArray(LOG_FILE);
  const instanceName = clean(client.instanceName);
  const events = allEvents
    .filter((item) => clean(item.instanceName) === instanceName)
    .slice(0, 50);

  const accepted = events.filter((item) => item.accepted === true).length;
  const created = events.reduce((sum, item) => sum + Number(item.created || 0), 0);
  const updated = events.reduce((sum, item) => sum + Number(item.updated || 0), 0);

  return send(res, 200, {
    ok: true,
    client: publicClient(client),
    count: events.length,
    accepted,
    created,
    updated,
    logFile: LOG_FILE,
    events,
    version: VERSION
  });
}

function register(app) {
  if (registered) return;
  registered = true;

  app.options('/api/crm/label-webhook-v2-events', (req, res) => send(res, 204, {}));
  app.get('/api/crm/label-webhook-v2-events', listV2Events);
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
