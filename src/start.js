// Lungo Broadcast startup wrapper.
// Keeps the campaign backend and adds token-based onboarding/admin/CRM routes.

process.env.ALLOWED_ORIGINS = '*';

const realExpress = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let extraRoutesRegistered = false;

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const VERSION = '1.6.5';

const CRM_STATUS_LABELS = {
  novo_lead: 'Novo lead',
  em_atendimento: 'Em atendimento',
  cotacao_enviada: 'Cotação enviada',
  aguardando_retorno: 'Aguardando retorno',
  fechado: 'Fechado',
  perdido: 'Perdido'
};

function appError(message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function cleanToken(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function cleanInstanceName(value) {
  return String(value || '').trim();
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

function loadClients() {
  if (!fs.existsSync(CLIENTS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveClients(clients) {
  fs.mkdirSync(path.dirname(CLIENTS_FILE), { recursive: true });
  fs.writeFileSync(CLIENTS_FILE, `${JSON.stringify(clients, null, 2)}\n`, 'utf8');
}

function loadLeads() {
  if (!fs.existsSync(LEADS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveLeads(leads) {
  fs.mkdirSync(path.dirname(LEADS_FILE), { recursive: true });
  fs.writeFileSync(LEADS_FILE, `${JSON.stringify(leads, null, 2)}\n`, 'utf8');
}

function findClientByToken(token) {
  const clean = cleanToken(token);
  if (!clean) return null;
  return loadClients().find((item) => cleanToken(item.token) === clean && item.ativo !== false) || null;
}

function getClientTokenFromRequest(req) {
  const bodyToken = req.body?.token;
  const queryToken = req.query?.token;
  const headerToken = req.headers['x-client-token'];
  const auth = req.headers.authorization || '';
  if (bodyToken) return String(bodyToken);
  if (queryToken) return String(queryToken);
  if (headerToken) return String(headerToken);
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7);
  return '';
}

function requireClientByToken(req) {
  const client = findClientByToken(getClientTokenFromRequest(req));
  if (!client) throw appError('Token inválido ou inativo.', 403);
  if (!cleanInstanceName(client.instanceName)) throw appError('Cliente sem instanceName configurado.', 500);
  return client;
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

function slugify(value) {
  const clean = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return clean || 'cliente';
}

function randomCode(size = 4) {
  return crypto.randomBytes(size).toString('hex').toUpperCase();
}

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
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
  while (clients.some((item) => String(item.instanceName || '').toLowerCase() === instanceName.toLowerCase())) {
    instanceName = `${base}_${randomCode(2).toLowerCase()}`;
  }
  return instanceName;
}

function normalizeLeadStatus(value) {
  const raw = slugify(value || 'novo_lead');
  const aliases = {
    novo: 'novo_lead',
    novo_lead: 'novo_lead',
    lead: 'novo_lead',
    em_atendimento: 'em_atendimento',
    atendimento: 'em_atendimento',
    cotacao: 'cotacao_enviada',
    cotacao_enviada: 'cotacao_enviada',
    proposta: 'cotacao_enviada',
    proposta_enviada: 'cotacao_enviada',
    aguardando: 'aguardando_retorno',
    aguardando_retorno: 'aguardando_retorno',
    retorno: 'aguardando_retorno',
    follow_up: 'aguardando_retorno',
    fechado: 'fechado',
    venda: 'fechado',
    vendido: 'fechado',
    perdido: 'perdido',
    cancelado: 'perdido'
  };
  return aliases[raw] || (CRM_STATUS_LABELS[raw] ? raw : 'novo_lead');
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
  }
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function publicLead(lead) {
  const status = normalizeLeadStatus(lead.status);
  return {
    id: lead.id,
    nome: lead.nome || '',
    telefone: lead.telefone || '',
    status,
    statusLabel: CRM_STATUS_LABELS[status] || status,
    origem: lead.origem || 'Manual',
    observacao: lead.observacao || '',
    proximoRetorno: lead.proximoRetorno || '',
    cidade: lead.cidade || '',
    planoAtual: lead.planoAtual || '',
    valor: lead.valor || '',
    tags: Array.isArray(lead.tags) ? lead.tags : [],
    createdAt: lead.createdAt || null,
    updatedAt: lead.updatedAt || null
  };
}

function leadSearchText(lead) {
  return [
    lead.nome,
    lead.telefone,
    lead.status,
    lead.origem,
    lead.observacao,
    lead.cidade,
    lead.planoAtual,
    lead.valor,
    ...(Array.isArray(lead.tags) ? lead.tags : [])
  ].join(' ').toLowerCase();
}

function summarizeLeads(leads) {
  const summary = Object.fromEntries(Object.keys(CRM_STATUS_LABELS).map((status) => [status, 0]));
  leads.forEach((lead) => {
    const status = normalizeLeadStatus(lead.status);
    summary[status] = (summary[status] || 0) + 1;
  });
  return {
    total: leads.length,
    ...summary
  };
}

function buildLeadPayload(body, client, existing = {}) {
  const nome = body.nome !== undefined ? String(body.nome || '').trim() : existing.nome || '';
  const telefone = body.telefone !== undefined ? normalizePhone(body.telefone || '') : existing.telefone || '';

  if (!nome || nome.length < 2) throw appError('Informe o nome do lead.', 400);
  if (!telefone || telefone.length < 10) throw appError('Informe um WhatsApp válido para o lead.', 400);

  const now = new Date().toISOString();
  return {
    ...existing,
    id: existing.id || generateId('lead'),
    instanceName: client.instanceName,
    nome,
    telefone,
    status: body.status !== undefined ? normalizeLeadStatus(body.status) : normalizeLeadStatus(existing.status),
    origem: body.origem !== undefined ? String(body.origem || 'Manual').trim() || 'Manual' : existing.origem || 'Manual',
    observacao: body.observacao !== undefined ? String(body.observacao || '').trim() : existing.observacao || '',
    proximoRetorno: body.proximoRetorno !== undefined ? String(body.proximoRetorno || '').trim() : existing.proximoRetorno || '',
    cidade: body.cidade !== undefined ? String(body.cidade || '').trim() : existing.cidade || '',
    planoAtual: body.planoAtual !== undefined ? String(body.planoAtual || '').trim() : existing.planoAtual || '',
    valor: body.valor !== undefined ? String(body.valor || '').trim() : existing.valor || '',
    tags: body.tags !== undefined ? normalizeTags(body.tags) : Array.isArray(existing.tags) ? existing.tags : [],
    createdAt: existing.createdAt || now,
    updatedAt: now
  };
}

function getAdminSecret() {
  return process.env.ADMIN_ACCESS_KEY || process.env.ADMIN_KEY || '';
}

function getAdminKeyFromRequest(req) {
  const bodyKey = req.body?.adminKey;
  const headerKey = req.headers['x-admin-key'];
  const auth = req.headers.authorization || '';
  if (bodyKey) return String(bodyKey);
  if (headerKey) return String(headerKey);
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7);
  return String(auth || '');
}

function requireAdmin(req) {
  const secret = getAdminSecret();
  if (!secret) throw appError('ADMIN_ACCESS_KEY não configurada no backend.', 500);
  const provided = getAdminKeyFromRequest(req);
  if (!provided || provided !== secret) throw appError('Chave administrativa inválida.', 401);
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

function isConnectedState(state) {
  return ['open', 'connected', 'online'].includes(String(state || '').toLowerCase());
}

function evolutionErrorIsNotFound(error) {
  const status = error?.response?.status;
  const data = JSON.stringify(error?.response?.data || '').toLowerCase();
  return status === 404 || data.includes('not_found') || data.includes('not found') || data.includes('instance not found');
}

async function getConnectionState(instanceName) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_CONNECTION_PATH || '/instance/connectionState/:instanceName', instanceName);
  const response = await axios.get(url, { headers: evolutionHeaders(), timeout: 20000 });
  const body = response.data || {};
  return body?.instance?.state || body?.state || body?.connectionState || 'unknown';
}

async function getSafeConnectionState(instanceName) {
  try {
    return await getConnectionState(instanceName);
  } catch (error) {
    if (evolutionErrorIsNotFound(error)) return 'not_found';
    throw error;
  }
}

function extractQrData(data) {
  const result = { base64: null, code: null, pairingCode: null, count: null };

  function walk(value) {
    if (value === null || value === undefined) return;

    if (typeof value === 'string') {
      const text = value.trim();
      if (!result.base64 && text.startsWith('data:image')) result.base64 = text;
      else if (!result.base64 && text.length > 500 && /^[A-Za-z0-9+/=]+$/.test(text)) result.base64 = `data:image/png;base64,${text}`;
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => {
        const clean = String(key).toLowerCase();
        if (clean === 'base64' && typeof child === 'string' && child.trim()) {
          result.base64 = child.startsWith('data:image') ? child : `data:image/png;base64,${child}`;
        }
        if ((clean === 'code' || clean === 'qrcode' || clean === 'qr') && typeof child === 'string' && child.trim()) {
          result.code = child;
        }
        if (clean === 'pairingcode' && typeof child === 'string' && child.trim()) {
          result.pairingCode = child;
        }
        if (clean === 'count' && child !== null && child !== undefined) result.count = child;
        walk(child);
      });
    }
  }

  walk(data);
  return result;
}

async function createEvolutionInstance(instanceName, number) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_CREATE_INSTANCE_PATH || '/instance/create', instanceName);
  const payload = {
    instanceName,
    qrcode: true,
    integration: process.env.EVOLUTION_INSTANCE_INTEGRATION || 'WHATSAPP-BAILEYS'
  };

  const cleanNumber = normalizePhone(number);
  if (cleanNumber) payload.number = cleanNumber;

  if (process.env.ONBOARDING_WEBHOOK_URL) {
    payload.webhook = {
      enabled: true,
      url: process.env.ONBOARDING_WEBHOOK_URL,
      events: String(process.env.ONBOARDING_WEBHOOK_EVENTS || 'CONNECTION,QRCODE')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    };
  }

  const response = await axios.post(url, payload, { headers: evolutionHeaders(), timeout: 30000 });
  return response.data;
}

async function connectEvolutionInstance(instanceName) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_CONNECT_PATH || '/instance/connect/:instanceName', instanceName);
  const response = await axios.get(url, { headers: evolutionHeaders(), timeout: 30000 });
  return response.data;
}

async function prepareConnection(client, number) {
  const instanceName = cleanInstanceName(client.instanceName);
  if (!instanceName) throw appError('Cliente sem instanceName configurado.', 500);

  let createResponse = null;
  let state = await getSafeConnectionState(instanceName);

  if (state === 'not_found') {
    try {
      createResponse = await createEvolutionInstance(instanceName, number || client.whatsapp || client.number);
    } catch (error) {
      if (error?.response?.status !== 409 && !evolutionErrorIsNotFound(error)) throw error;
    }
    state = await getSafeConnectionState(instanceName);
  }

  if (isConnectedState(state)) {
    return { instanceName, state, connected: true, qr: extractQrData(createResponse) };
  }

  const connectResponse = await connectEvolutionInstance(instanceName);
  const qr = extractQrData(connectResponse) || extractQrData(createResponse);
  const updatedState = await getSafeConnectionState(instanceName);

  return { instanceName, state: updatedState, connected: isConnectedState(updatedState), qr };
}

function sendRouteError(res, error, label = 'ERROR') {
  console.error(`[${label}]`, error.response?.data || error.message || error);
  res.status(error.statusCode || error.response?.status || 500).json({
    ok: false,
    error: error.message || 'Erro interno no servidor.',
    details: error.details || error.response?.data || null
  });
}

function registerOnboardingRoutes(app) {
  app.post('/api/onboarding/check-token', (req, res) => {
    try {
      const client = findClientByToken(req.body.token);
      if (!client) return res.status(403).json({ ok: false, error: 'Token inválido ou inativo.' });
      res.json({ ok: true, client: publicClient(client) });
    } catch (error) {
      sendRouteError(res, error, 'ONBOARDING ERROR');
    }
  });

  app.post('/api/onboarding/connect', async (req, res) => {
    try {
      const client = findClientByToken(req.body.token);
      if (!client) return res.status(403).json({ ok: false, error: 'Token inválido ou inativo.' });

      const result = await prepareConnection(client, req.body.number);
      res.json({
        ok: true,
        client: publicClient(client),
        instanceName: result.instanceName,
        state: result.state,
        connected: result.connected,
        qrCodeBase64: result.qr?.base64 || null,
        qrCode: result.qr?.code || null,
        pairingCode: result.qr?.pairingCode || null,
        count: result.qr?.count ?? null
      });
    } catch (error) {
      sendRouteError(res, error, 'ONBOARDING ERROR');
    }
  });

  app.post('/api/onboarding/status', async (req, res) => {
    try {
      const client = findClientByToken(req.body.token);
      if (!client) return res.status(403).json({ ok: false, error: 'Token inválido ou inativo.' });

      const state = await getSafeConnectionState(client.instanceName);
      res.json({
        ok: true,
        client: publicClient(client),
        instanceName: client.instanceName,
        state,
        connected: isConnectedState(state)
      });
    } catch (error) {
      sendRouteError(res, error, 'ONBOARDING ERROR');
    }
  });

  app.get('/api/onboarding/health', (req, res) => {
    res.json({ ok: true, status: 'online', version: VERSION, module: 'onboarding', time: new Date().toISOString() });
  });
}

function registerCrmRoutes(app) {
  app.get('/api/crm/health', (req, res) => {
    res.json({ ok: true, status: 'online', version: VERSION, module: 'crm', time: new Date().toISOString() });
  });

  app.get('/api/crm/statuses', (req, res) => {
    res.json({
      ok: true,
      statuses: Object.entries(CRM_STATUS_LABELS).map(([value, label]) => ({ value, label }))
    });
  });

  app.get('/api/crm/leads', (req, res) => {
    try {
      const client = requireClientByToken(req);
      const instanceName = cleanInstanceName(client.instanceName);
      const statusFilter = req.query?.status ? normalizeLeadStatus(req.query.status) : '';
      const query = String(req.query?.q || req.query?.search || '').trim().toLowerCase();

      let leads = loadLeads().filter((lead) => cleanInstanceName(lead.instanceName) === instanceName);

      if (statusFilter) leads = leads.filter((lead) => normalizeLeadStatus(lead.status) === statusFilter);
      if (query) leads = leads.filter((lead) => leadSearchText(lead).includes(query));

      const sorted = leads.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
      res.json({ ok: true, client: publicClient(client), leads: sorted.map(publicLead), summary: summarizeLeads(leads) });
    } catch (error) {
      sendRouteError(res, error, 'CRM ERROR');
    }
  });

  app.post('/api/crm/leads', (req, res) => {
    try {
      const client = requireClientByToken(req);
      const leads = loadLeads();
      const lead = buildLeadPayload(req.body || {}, client);
      leads.push(lead);
      saveLeads(leads);
      res.status(201).json({ ok: true, lead: publicLead(lead), summary: summarizeLeads(leads.filter((item) => cleanInstanceName(item.instanceName) === cleanInstanceName(client.instanceName))) });
    } catch (error) {
      sendRouteError(res, error, 'CRM ERROR');
    }
  });

  const updateLeadHandler = (req, res) => {
    try {
      const client = requireClientByToken(req);
      const leads = loadLeads();
      const id = String(req.params.id || '').trim();
      const index = leads.findIndex((lead) => lead.id === id && cleanInstanceName(lead.instanceName) === cleanInstanceName(client.instanceName));
      if (index < 0) throw appError('Lead não encontrado para este cliente.', 404);

      leads[index] = buildLeadPayload(req.body || {}, client, leads[index]);
      saveLeads(leads);
      res.json({ ok: true, lead: publicLead(leads[index]), summary: summarizeLeads(leads.filter((item) => cleanInstanceName(item.instanceName) === cleanInstanceName(client.instanceName))) });
    } catch (error) {
      sendRouteError(res, error, 'CRM ERROR');
    }
  };

  app.put('/api/crm/leads/:id', updateLeadHandler);
  app.patch('/api/crm/leads/:id', updateLeadHandler);

  app.delete('/api/crm/leads/:id', (req, res) => {
    try {
      const client = requireClientByToken(req);
      const id = String(req.params.id || '').trim();
      const leads = loadLeads();
      const filtered = leads.filter((lead) => !(lead.id === id && cleanInstanceName(lead.instanceName) === cleanInstanceName(client.instanceName)));
      if (filtered.length === leads.length) throw appError('Lead não encontrado para este cliente.', 404);
      saveLeads(filtered);
      res.json({ ok: true, removed: true, summary: summarizeLeads(filtered.filter((item) => cleanInstanceName(item.instanceName) === cleanInstanceName(client.instanceName))) });
    } catch (error) {
      sendRouteError(res, error, 'CRM ERROR');
    }
  });
}

function registerAdminRoutes(app) {
  app.get('/api/admin/health', (req, res) => {
    res.json({ ok: true, status: 'online', version: VERSION, module: 'admin', adminConfigured: Boolean(getAdminSecret()), time: new Date().toISOString() });
  });

  app.get('/api/admin/clients', (req, res) => {
    try {
      requireAdmin(req);
      const clients = loadClients().map((client) => publicClient(client, true));
      res.json({ ok: true, clients, count: clients.length });
    } catch (error) {
      sendRouteError(res, error, 'ADMIN ERROR');
    }
  });

  app.post('/api/admin/clients/list', (req, res) => {
    try {
      requireAdmin(req);
      const clients = loadClients().map((client) => publicClient(client, true));
      res.json({ ok: true, clients, count: clients.length });
    } catch (error) {
      sendRouteError(res, error, 'ADMIN ERROR');
    }
  });

  app.post('/api/admin/clients', (req, res) => {
    try {
      requireAdmin(req);
      const nome = String(req.body.nome || '').trim();
      const whatsapp = normalizePhone(req.body.whatsapp || '');
      const requestedToken = cleanToken(req.body.token || '');
      const requestedInstance = cleanInstanceName(req.body.instanceName || '');

      if (nome.length < 2) throw appError('Informe o nome do cliente.', 400);

      const clients = loadClients();
      const token = requestedToken || generateToken(nome, clients);
      const instanceName = requestedInstance || generateInstanceName(nome, clients);

      if (clients.some((item) => cleanToken(item.token) === cleanToken(token))) {
        throw appError('Já existe um cliente com esse token.', 409);
      }

      if (clients.some((item) => String(item.instanceName || '').toLowerCase() === instanceName.toLowerCase())) {
        throw appError('Já existe um cliente com esse ID/instância.', 409);
      }

      const now = new Date().toISOString();
      const client = { nome, token, instanceName, ativo: true, whatsapp, createdAt: now, updatedAt: now };
      clients.push(client);
      saveClients(clients);

      res.status(201).json({ ok: true, client: publicClient(client, true) });
    } catch (error) {
      sendRouteError(res, error, 'ADMIN ERROR');
    }
  });

  app.patch('/api/admin/clients/:token', (req, res) => {
    try {
      requireAdmin(req);
      const token = cleanToken(req.params.token);
      const clients = loadClients();
      const index = clients.findIndex((item) => cleanToken(item.token) === token);
      if (index < 0) throw appError('Cliente não encontrado.', 404);

      if (req.body.nome !== undefined) clients[index].nome = String(req.body.nome || '').trim();
      if (req.body.whatsapp !== undefined) clients[index].whatsapp = normalizePhone(req.body.whatsapp || '');
      if (req.body.ativo !== undefined) clients[index].ativo = Boolean(req.body.ativo);
      clients[index].updatedAt = new Date().toISOString();

      saveClients(clients);
      res.json({ ok: true, client: publicClient(clients[index], true) });
    } catch (error) {
      sendRouteError(res, error, 'ADMIN ERROR');
    }
  });

  app.delete('/api/admin/clients/:token', (req, res) => {
    try {
      requireAdmin(req);
      const token = cleanToken(req.params.token);
      const clients = loadClients();
      const filtered = clients.filter((item) => cleanToken(item.token) !== token);
      if (filtered.length === clients.length) throw appError('Cliente não encontrado.', 404);
      saveClients(filtered);
      res.json({ ok: true, removed: true });
    } catch (error) {
      sendRouteError(res, error, 'ADMIN ERROR');
    }
  });
}

function registerExtraRoutes(app) {
  if (extraRoutesRegistered) return;
  extraRoutesRegistered = true;
  registerOnboardingRoutes(app);
  registerCrmRoutes(app);
  registerAdminRoutes(app);
}

function wrapApp(app) {
  const originalUse = app.use.bind(app);
  const originalGet = app.get.bind(app);

  app.get = function patchedGet(routePath, ...handlers) {
    if (routePath === '/health') {
      return originalGet(routePath, (req, res) => {
        res.json({ ok: true, status: 'online', version: VERSION, onboarding: true, admin: true, crm: true, time: new Date().toISOString() });
      });
    }

    if (routePath === '/') {
      return originalGet(routePath, (req, res) => {
        res.json({ ok: true, name: 'Lungo Broadcast API', version: VERSION, onboarding: true, admin: true, crm: true });
      });
    }

    return originalGet(routePath, ...handlers);
  };

  app.use = function patchedUse(...args) {
    const first = args[0];
    if (!extraRoutesRegistered && typeof first === 'function' && (first.length === 2 || first.length === 4)) {
      registerExtraRoutes(app);
    }
    return originalUse(...args);
  };

  return app;
}

function patchedExpress(...args) {
  return wrapApp(realExpress(...args));
}

Object.keys(realExpress).forEach((key) => {
  patchedExpress[key] = realExpress[key];
});

require.cache[require.resolve('express')].exports = patchedExpress;
require('./server');
