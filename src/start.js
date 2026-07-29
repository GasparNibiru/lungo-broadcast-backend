// Lungo Broadcast startup wrapper.
// Keeps the existing campaign backend and adds token-based onboarding routes.

process.env.ALLOWED_ORIGINS = '*';

const realExpress = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let onboardingRegistered = false;

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = path.join(ROOT, 'data', 'clientes.json');
const VERSION = '1.4.0';

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

function findClientByToken(token) {
  const clean = cleanToken(token);
  if (!clean) return null;
  return loadClients().find((item) => cleanToken(item.token) === clean && item.ativo !== false) || null;
}

function publicClient(client) {
  return {
    nome: client.nome || client.instanceName,
    instanceName: client.instanceName,
    ativo: client.ativo !== false
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
  if (!evolutionBaseUrl()) throw new Error('EVOLUTION_BASE_URL não configurado.');
  if (!process.env.EVOLUTION_API_KEY) throw new Error('EVOLUTION_API_KEY não configurado.');
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
  if (!instanceName) {
    const error = new Error('Cliente sem instanceName configurado em data/clientes.json.');
    error.statusCode = 500;
    throw error;
  }

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

function sendRouteError(res, error) {
  console.error('[ONBOARDING ERROR]', error.response?.data || error.message || error);
  res.status(error.statusCode || error.response?.status || 500).json({
    ok: false,
    error: error.message || 'Erro interno no servidor.',
    details: error.response?.data || null
  });
}

function registerOnboardingRoutes(app) {
  if (onboardingRegistered) return;
  onboardingRegistered = true;

  app.post('/api/onboarding/check-token', (req, res) => {
    try {
      const client = findClientByToken(req.body.token);
      if (!client) return res.status(403).json({ ok: false, error: 'Token inválido ou inativo.' });
      res.json({ ok: true, client: publicClient(client) });
    } catch (error) {
      sendRouteError(res, error);
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
      sendRouteError(res, error);
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
      sendRouteError(res, error);
    }
  });

  app.get('/api/onboarding/health', (req, res) => {
    res.json({ ok: true, status: 'online', version: VERSION, module: 'onboarding', time: new Date().toISOString() });
  });
}

function wrapApp(app) {
  const originalUse = app.use.bind(app);
  const originalGet = app.get.bind(app);

  app.get = function patchedGet(routePath, ...handlers) {
    if (routePath === '/health') {
      return originalGet(routePath, (req, res) => {
        res.json({ ok: true, status: 'online', version: VERSION, onboarding: true, time: new Date().toISOString() });
      });
    }

    if (routePath === '/') {
      return originalGet(routePath, (req, res) => {
        res.json({ ok: true, name: 'Lungo Broadcast API', version: VERSION, onboarding: true });
      });
    }

    return originalGet(routePath, ...handlers);
  };

  app.use = function patchedUse(...args) {
    const first = args[0];
    if (!onboardingRegistered && typeof first === 'function' && (first.length === 2 || first.length === 4)) {
      registerOnboardingRoutes(app);
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
