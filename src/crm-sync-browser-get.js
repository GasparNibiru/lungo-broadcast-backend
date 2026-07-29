// Browser-friendly MiniCRM sync proxy.
// Adds GET /api/crm/sync-whatsapp-label-browser for direct browser tests.

const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '1.7.1-browser-proxy';

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

function localBaseUrl(req) {
  if (process.env.CRM_SYNC_INTERNAL_URL) return process.env.CRM_SYNC_INTERNAL_URL.replace(/\/+$/, '');
  const port = process.env.PORT || 80;
  return `http://127.0.0.1:${port}`;
}

async function syncByBrowser(req, res) {
  try {
    const token = clean(req.query.token || req.headers['x-client-token'] || '');
    const labelName = clean(req.query.labelName || req.query.label || process.env.CRM_WHATSAPP_LABEL || 'MiniCRM');
    const limit = Number(req.query.limit || process.env.CRM_SYNC_LIMIT || 500);

    if (!token) return send(res, 400, { ok: false, error: 'Informe o token na URL.' });

    const response = await axios.post(`${localBaseUrl(req)}/api/crm/sync-whatsapp-label`, {
      token,
      labelName,
      limit
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000,
      validateStatus: () => true
    });

    return send(res, response.status || 200, {
      ...response.data,
      via: 'browser-get-proxy',
      proxyVersion: VERSION
    });
  } catch (error) {
    return send(res, error.response?.status || 500, {
      ok: false,
      error: error.message || 'Erro ao sincronizar MiniCRM pelo navegador.',
      details: error.response?.data || null,
      via: 'browser-get-proxy',
      proxyVersion: VERSION
    });
  }
}

function register(app) {
  if (registered) return;
  registered = true;

  app.options('/api/crm/sync-whatsapp-label-browser', (req, res) => send(res, 204, {}));
  app.get('/api/crm/sync-whatsapp-label-browser', syncByBrowser);
}

function patchExpress() {
  const patchedExpress = function patchedExpress(...args) {
    const app = realExpress(...args);
    register(app);
    return app;
  };

  Object.keys(realExpress).forEach((key) => {
    patchedExpress[key] = realExpress[key];
  });

  require.cache[require.resolve('express')].exports = patchedExpress;
}

patchExpress();

module.exports = { register };
