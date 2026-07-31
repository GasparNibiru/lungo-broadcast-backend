// Delete PDF documents from product folders.
// Complements clientes-products-routes.js with document removal per product.

const fs = require('fs');
const path = require('path');
const realExpress = require('express');

let registered = false;
const VERSION = '1.0.0-client-product-doc-delete';
const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const CUSTOMER_CLIENTS_FILE = process.env.CUSTOMER_CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'customer_clients.json');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-token');
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
function tokenFromRequest(req) {
  const auth = req.headers.authorization || '';
  if (req.query?.token) return String(req.query.token);
  if (req.query?.t) return String(req.query.t);
  if (req.headers['x-client-token']) return String(req.headers['x-client-token']);
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7);
  return '';
}
function findClientByToken(token) {
  const wanted = cleanToken(token);
  if (!wanted) return null;
  return loadArray(CLIENTS_FILE).find((item) => cleanToken(item.token) === wanted && item.ativo !== false) || null;
}
function requireClient(req) {
  const client = findClientByToken(tokenFromRequest(req));
  if (!client) throw Object.assign(new Error('Token inválido ou inativo.'), { statusCode: 403 });
  return client;
}
function docKey(doc) { return clean(doc?.id || doc?.fileName || doc?.name || ''); }
function normalizeDocs(item) {
  const docs = [];
  if (Array.isArray(item?.documentosPdf)) docs.push(...item.documentosPdf);
  if (Array.isArray(item?.documentos)) docs.push(...item.documentos);
  if (item?.documentacaoPdf && typeof item.documentacaoPdf === 'object') docs.push(item.documentacaoPdf);
  const seen = new Set();
  return docs.filter((doc) => {
    const key = docKey(doc);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function deleteDocFromItem(item, docId) {
  const before = normalizeDocs(item);
  const after = before.filter((doc) => docKey(doc) !== docId);
  if (before.length === after.length) return false;
  item.documentosPdf = after;
  item.documentos = after;
  item.documentacaoPdf = after[0] || null;
  item.updatedAt = new Date().toISOString();
  return true;
}
function deleteProductDoc(req, res) {
  try {
    const client = requireClient(req);
    const customerId = clean(req.params?.id || '');
    const productId = clean(req.params?.productId || 'principal');
    const docId = clean(req.params?.docId || '');
    if (!docId) return send(res, 400, { ok: false, error: 'Documento não informado.', version: VERSION });
    const customers = loadArray(CUSTOMER_CLIENTS_FILE);
    const customerIndex = customers.findIndex((item) => item.id === customerId && clean(item.instanceName) === clean(client.instanceName));
    if (customerIndex < 0) return send(res, 404, { ok: false, error: 'Cliente não encontrado.', version: VERSION });
    const customer = customers[customerIndex];
    let removed = false;
    if (productId === 'principal') {
      removed = deleteDocFromItem(customer, docId);
    } else {
      const sales = Array.isArray(customer.vendasBase) ? customer.vendasBase : [];
      const sale = sales.find((item) => clean(item.id) === productId);
      if (!sale) return send(res, 404, { ok: false, error: 'Produto não encontrado.', version: VERSION });
      removed = deleteDocFromItem(sale, docId);
      customer.vendasBase = sales;
      customer.updatedAt = new Date().toISOString();
    }
    if (!removed) return send(res, 404, { ok: false, error: 'Documento não encontrado.', version: VERSION });
    customers[customerIndex] = customer;
    saveArray(CUSTOMER_CLIENTS_FILE, customers);
    return send(res, 200, { ok: true, removed: true, version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao excluir documento.', version: VERSION });
  }
}
function register(app) {
  if (registered) return;
  registered = true;
  app.options('/api/clientes/products-doc-delete/health', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/products/:productId/documents/:docId', (req, res) => send(res, 204, {}));
  app.get('/api/clientes/products-doc-delete/health', (req, res) => send(res, 200, { ok: true, module: 'clientes-products-doc-delete', version: VERSION, customerClientsFile: CUSTOMER_CLIENTS_FILE, time: new Date().toISOString() }));
  app.delete('/api/clientes/:id/products/:productId/documents/:docId', deleteProductDoc);
}
function patchExpress() {
  const patchedExpress = function patchedExpress(...args) { const app = realExpress(...args); register(app); return app; };
  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}
patchExpress();
module.exports = { register };
