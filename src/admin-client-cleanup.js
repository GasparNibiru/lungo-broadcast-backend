// Admin cleanup and duplicate protection for Lungo clients.
// Keeps Admin clients and Evolution instances from drifting apart.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '1.0.0-admin-client-cleanup';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
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

function cleanInstanceName(value) {
  return clean(value);
}

function normalizeText(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  return digits;
}

function loadClients() {
  if (!fs.existsSync(CLIENTS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveClients(clients) {
  fs.mkdirSync(path.dirname(CLIENTS_FILE), { recursive: true });
  fs.writeFileSync(CLIENTS_FILE, `${JSON.stringify(clients, null, 2)}\n`, 'utf8');
}

function publicClient(client, includeToken = false) {
  const output = {
    nome: client.nome || client.instanceName,
    instanceName: client.instanceName,
    ativo: client.ativo !== false,
    whatsapp: client.whatsapp || '',
    createdAt: client.createdAt || null,
    updatedAt: client.updatedAt || null
  };
  if (includeToken) output.token = client.token;
  return output;
}

function appError(message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getAdminSecret() {
  return process.env.ADMIN_ACCESS_KEY || process.env.ADMIN_KEY || '';
}

function getAdminKeyFromRequest(req, body = null) {
  const headerKey = req.headers['x-admin-key'];
  const auth = req.headers.authorization || '';
  if (body?.adminKey) return String(body.adminKey);
  if (req.query?.adminKey) return String(req.query.adminKey);
  if (headerKey) return String(headerKey);
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7);
  return String(auth || '');
}

function requireAdmin(req, body = null) {
  const secret = getAdminSecret();
  if (!secret) throw appError('ADMIN_ACCESS_KEY não configurada no backend.', 500);
  const provided = getAdminKeyFromRequest(req, body);
  if (!provided || provided !== secret) throw appError('Chave administrativa inválida.', 401);
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

function slugify(value) {
  const normalized = clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return normalized || 'cliente';
}

function randomCode(size = 4) {
  return require('crypto').randomBytes(size).toString('hex').toUpperCase();
}

function generateToken(nome, clients) {
  const prefix = slugify(nome).replace(/_/g, '').toUpperCase().slice(0, 8) || 'CLIENTE';
  let token;
  do {
    token = `${prefix}-${randomCode(2)}-${randomCode(2)}`;
  } while (clients.some((item) => cleanToken(item.token) === cleanToken(token)));
  return token;
}

function generateInstanceName(nome, clients) {
  const base = `lungo_${slugify(nome)}`.slice(0, 42);
  let instanceName = `${base}_${randomCode(2).toLowerCase()}`;
  while (clients.some((item) => clean(item.instanceName).toLowerCase() === instanceName.toLowerCase())) {
    instanceName = `${base}_${randomCode(2).toLowerCase()}`;
  }
  return instanceName;
}

function findExistingClientIndex(clients, { token, instanceName, whatsapp, nome }) {
  const wantedToken = cleanToken(token);
  const wantedInstance = clean(instanceName).toLowerCase();
  const wantedPhone = normalizePhone(whatsapp);
  const wantedName = normalizeText(nome);

  if (wantedToken) {
    const index = clients.findIndex((item) => cleanToken(item.token) === wantedToken);
    if (index >= 0) return index;
  }
  if (wantedInstance) {
    const index = clients.findIndex((item) => clean(item.instanceName).toLowerCase() === wantedInstance);
    if (index >= 0) return index;
  }
  if (wantedPhone) {
    const index = clients.findIndex((item) => normalizePhone(item.whatsapp || item.number || '') === wantedPhone);
    if (index >= 0) return index;
  }
  if (wantedName) {
    const index = clients.findIndex((item) => normalizeText(item.nome || '') === wantedName);
    if (index >= 0) return index;
  }
  return -1;
}

function evolutionBaseUrl() {
  return clean(process.env.EVOLUTION_BASE_URL).replace(/\/+$/, '');
}

function evolutionHeaders() {
  return { apikey: process.env.EVOLUTION_API_KEY || '', 'Content-Type': 'application/json' };
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

async function getEvolutionState(instanceName) {
  if (!evolutionBaseUrl() || !process.env.EVOLUTION_API_KEY || !instanceName) {
    return { ok: false, skipped: true, reason: 'evolution_not_configured' };
  }
  try {
    const result = await callEvolution('get', process.env.EVOLUTION_CONNECTION_PATH || '/instance/connectionState/:instanceName', instanceName);
    const body = result.data || {};
    return { ...result, state: body?.instance?.state || body?.state || body?.connectionState || 'unknown' };
  } catch (error) {
    return { ok: false, error: error.message || 'Erro ao consultar Evolution.' };
  }
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

async function upsertAdminClient(req, res) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);

    const nome = clean(body.nome || '');
    const whatsapp = normalizePhone(body.whatsapp || body.number || '');
    const requestedToken = cleanToken(body.token || '');
    const requestedInstance = cleanInstanceName(body.instanceName || '');
    if (nome.length < 2) throw appError('Informe o nome do cliente.', 400);

    const clients = loadClients();
    const existingIndex = findExistingClientIndex(clients, { token: requestedToken, instanceName: requestedInstance, whatsapp, nome });
    const now = new Date().toISOString();

    if (existingIndex >= 0) {
      const current = clients[existingIndex];
      const next = {
        ...current,
        nome,
        token: requestedToken || current.token || generateToken(nome, clients),
        instanceName: requestedInstance || current.instanceName || generateInstanceName(nome, clients),
        whatsapp: whatsapp || current.whatsapp || '',
        ativo: body.ativo !== undefined ? Boolean(body.ativo) : true,
        createdAt: current.createdAt || now,
        updatedAt: now
      };
      clients[existingIndex] = next;
      saveClients(clients);
      return send(res, 200, { ok: true, updatedExisting: true, duplicatePrevented: true, client: publicClient(next, true), version: VERSION });
    }

    const token = requestedToken || generateToken(nome, clients);
    const instanceName = requestedInstance || generateInstanceName(nome, clients);

    const tokenConflict = clients.some((item) => cleanToken(item.token) === cleanToken(token));
    if (tokenConflict) throw appError('Já existe um cliente com esse token.', 409);
    const instanceConflict = clients.some((item) => clean(item.instanceName).toLowerCase() === instanceName.toLowerCase());
    if (instanceConflict) throw appError('Já existe um cliente com esse ID/instância.', 409);

    const client = { nome, token, instanceName, ativo: true, whatsapp, createdAt: now, updatedAt: now };
    clients.push(client);
    saveClients(clients);
    return send(res, 201, { ok: true, created: true, client: publicClient(client, true), version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro administrativo.', details: error.details || null, version: VERSION });
  }
}

async function deleteAdminClient(req, res) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    const token = cleanToken(req.params.token || body.token || '');
    if (!token) throw appError('Informe o token do cliente.', 400);

    const clients = loadClients();
    const index = clients.findIndex((item) => cleanToken(item.token) === token);
    if (index < 0) throw appError('Cliente não encontrado.', 404);

    const removedClient = clients[index];
    const filtered = clients.filter((_, itemIndex) => itemIndex !== index);
    saveClients(filtered);

    const skipEvolution = ['1', 'true', 'sim', 'yes'].includes(clean(req.query.skipEvolution || body.skipEvolution).toLowerCase());
    const evolution = skipEvolution ? { skipped: true, reason: 'skipEvolution=true' } : await cleanupEvolutionInstance(removedClient.instanceName);

    return send(res, 200, {
      ok: true,
      removed: true,
      client: publicClient(removedClient, true),
      evolution,
      remainingClients: filtered.length,
      version: VERSION
    });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao excluir cliente.', details: error.details || null, version: VERSION });
  }
}

async function checkClientEvolutionStatus(req, res) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    const token = cleanToken(req.params.token || req.query.token || body.token || '');
    const clients = loadClients();
    const client = clients.find((item) => cleanToken(item.token) === token);
    if (!client) throw appError('Cliente não encontrado.', 404);
    const evolution = await getEvolutionState(client.instanceName);
    return send(res, 200, { ok: true, client: publicClient(client, true), evolution, version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao consultar cliente na Evolution.', version: VERSION });
  }
}

function register(app) {
  if (registered) return;
  registered = true;

  app.options('/api/admin/clients', (req, res) => send(res, 204, {}));
  app.options('/api/admin/clients/:token', (req, res) => send(res, 204, {}));
  app.options('/api/admin/clients/:token/evolution-status', (req, res) => send(res, 204, {}));
  app.options('/api/admin/client-cleanup/health', (req, res) => send(res, 204, {}));

  app.get('/api/admin/client-cleanup/health', (req, res) => send(res, 200, {
    ok: true,
    module: 'admin-client-cleanup',
    version: VERSION,
    clientsFile: CLIENTS_FILE,
    evolutionConfigured: Boolean(evolutionBaseUrl() && process.env.EVOLUTION_API_KEY),
    deletePath: process.env.EVOLUTION_DELETE_INSTANCE_PATH || '/instance/delete/:instanceName',
    time: new Date().toISOString()
  }));

  app.post('/api/admin/clients', upsertAdminClient);
  app.delete('/api/admin/clients/:token', deleteAdminClient);
  app.post('/api/admin/clients/:token/delete-complete', deleteAdminClient);
  app.get('/api/admin/clients/:token/evolution-status', checkClientEvolutionStatus);
  app.post('/api/admin/clients/:token/evolution-status', checkClientEvolutionStatus);
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
