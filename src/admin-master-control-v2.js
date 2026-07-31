// Admin Master control routes for Lungo Corretores.
// Adds safe master actions: deactivate/reactivate access and delete Evolution instance without deleting CRM data.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const realExpress = require('express');
const { buildDashboard } = require('./admin-master-panel-v2');

let registered = false;
const VERSION = '1.0.0-admin-master-control-actions';
const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const ADMIN_ACCESS_KEY = process.env.ADMIN_ACCESS_KEY || '';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
}
function send(res, status, payload) { setCors(res); return res.status(status).json(payload); }
function clean(value) { return String(value || '').trim(); }
function cleanToken(value) { return clean(value).toUpperCase().replace(/\s+/g, ''); }
function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try { const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function saveArray(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
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
function adminKeyFromRequest(req, body = null) {
  const auth = req.headers.authorization || '';
  if (body?.adminKey) return clean(body.adminKey);
  if (req.query?.adminKey) return clean(req.query.adminKey);
  if (req.headers['x-admin-key']) return clean(req.headers['x-admin-key']);
  if (String(auth).toLowerCase().startsWith('bearer ')) return clean(String(auth).slice(7));
  return '';
}
function requireAdmin(req, body = null) {
  const provided = adminKeyFromRequest(req, body);
  if (!ADMIN_ACCESS_KEY) throw Object.assign(new Error('ADMIN_ACCESS_KEY não configurada no backend.'), { statusCode: 500 });
  if (!provided || provided !== ADMIN_ACCESS_KEY) throw Object.assign(new Error('Chave admin inválida.'), { statusCode: 403 });
}
function findClientIndex(clients, token) {
  const wanted = cleanToken(token);
  return clients.findIndex((client) => cleanToken(client.token) === wanted);
}
function publicClient(client) {
  return {
    nome: client.nome || client.instanceName || 'Corretor',
    token: client.token || '',
    instanceName: client.instanceName || '',
    ativo: client.ativo !== false,
    instanceStatus: client.instanceStatus || '',
    instanceDeletedAt: client.instanceDeletedAt || '',
    updatedAt: client.updatedAt || ''
  };
}
function evolutionBaseUrl() { return clean(process.env.EVOLUTION_BASE_URL).replace(/\/+$/, ''); }
function evolutionHeaders() { return { apikey: process.env.EVOLUTION_API_KEY || '', 'Content-Type': 'application/json' }; }
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
function trimData(data) {
  const text = JSON.stringify(data || null);
  if (text.length <= 1200) return data;
  return { preview: text.slice(0, 1200), truncated: true };
}
async function callEvolution(method, template, instanceName) {
  const url = buildEvolutionUrl(template, instanceName);
  const response = await axios({ method, url, headers: evolutionHeaders(), timeout: 30000, validateStatus: () => true });
  return { method, path: template, status: response.status, ok: response.status >= 200 && response.status < 300, data: trimData(response.data) };
}
async function cleanupEvolutionInstance(instanceName) {
  if (!evolutionBaseUrl() || !process.env.EVOLUTION_API_KEY || !instanceName) {
    return { ok: false, skipped: true, reason: 'evolution_not_configured' };
  }
  const templates = [
    process.env.EVOLUTION_DELETE_INSTANCE_PATH || '/instance/delete/:instanceName',
    process.env.EVOLUTION_LOGOUT_PATH || '/instance/logout/:instanceName',
    '/instance/delete/:instanceName',
    '/instance/logout/:instanceName'
  ].filter(Boolean);
  const attempts = [];
  const seen = new Set();
  for (const template of templates) {
    for (const method of ['delete', 'post', 'get']) {
      const key = `${method} ${template}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const attempt = await callEvolution(method, template, instanceName);
        attempts.push(attempt);
        const text = JSON.stringify(attempt.data || '').toLowerCase();
        if (attempt.ok || attempt.status === 404 || text.includes('not found') || text.includes('not_found') || text.includes('instance not found')) {
          return { ok: true, instanceName, attempts, finalStatus: attempt.status, alreadyMissing: attempt.status === 404 || text.includes('not found') || text.includes('not_found') };
        }
        if (![400, 404, 405, 409, 500].includes(attempt.status)) break;
      } catch (error) {
        attempts.push({ method, path: template, ok: false, error: error.message || 'Erro na Evolution' });
      }
    }
  }
  return { ok: false, instanceName, attempts };
}
async function setActiveRoute(req, res, active) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    const token = cleanToken(req.params.token || body.token || '');
    if (!token) throw Object.assign(new Error('Token não informado.'), { statusCode: 400 });
    const clients = loadArray(CLIENTS_FILE);
    const index = findClientIndex(clients, token);
    if (index < 0) throw Object.assign(new Error('Corretor não encontrado.'), { statusCode: 404 });
    const now = new Date().toISOString();
    clients[index].ativo = active;
    clients[index].updatedAt = now;
    if (active) clients[index].reactivatedAt = now;
    else clients[index].deactivatedAt = now;
    saveArray(CLIENTS_FILE, clients);
    return send(res, 200, { ok: true, client: publicClient(clients[index]), dashboard: buildDashboard(), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao atualizar corretor.', version: VERSION }); }
}
async function deleteInstanceRoute(req, res) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    const token = cleanToken(req.params.token || body.token || '');
    if (!token) throw Object.assign(new Error('Token não informado.'), { statusCode: 400 });
    const clients = loadArray(CLIENTS_FILE);
    const index = findClientIndex(clients, token);
    if (index < 0) throw Object.assign(new Error('Corretor não encontrado.'), { statusCode: 404 });
    const instanceName = clean(clients[index].instanceName || '');
    if (!instanceName) throw Object.assign(new Error('Corretor sem instância WhatsApp configurada.'), { statusCode: 400 });
    const evolution = await cleanupEvolutionInstance(instanceName);
    if (!evolution.ok) return send(res, 502, { ok: false, error: 'Não foi possível excluir a instância na Evolution.', evolution, version: VERSION });
    const now = new Date().toISOString();
    clients[index].instanceStatus = 'deleted';
    clients[index].instanceDeletedAt = now;
    clients[index].whatsappStatus = 'deleted';
    clients[index].updatedAt = now;
    saveArray(CLIENTS_FILE, clients);
    return send(res, 200, { ok: true, client: publicClient(clients[index]), evolution, dashboard: buildDashboard(), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao excluir instância.', version: VERSION }); }
}
function register(app) {
  if (registered) return;
  registered = true;
  app.options('/api/admin-master-v2/control-health', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v2/clients/:token/deactivate', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v2/clients/:token/reactivate', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v2/clients/:token/delete-instance', (req, res) => send(res, 204, {}));
  app.get('/api/admin-master-v2/control-health', (req, res) => send(res, 200, { ok: true, module: 'admin-master-control-v2', version: VERSION, evolutionConfigured: Boolean(evolutionBaseUrl() && process.env.EVOLUTION_API_KEY), deletePath: process.env.EVOLUTION_DELETE_INSTANCE_PATH || '/instance/delete/:instanceName', time: new Date().toISOString() }));
  app.post('/api/admin-master-v2/clients/:token/deactivate', (req, res) => setActiveRoute(req, res, false));
  app.post('/api/admin-master-v2/clients/:token/reactivate', (req, res) => setActiveRoute(req, res, true));
  app.post('/api/admin-master-v2/clients/:token/delete-instance', deleteInstanceRoute);
}
function patchExpress() {
  const patchedExpress = function patchedExpress(...args) { const app = realExpress(...args); register(app); return app; };
  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}
patchExpress();
module.exports = { register };
