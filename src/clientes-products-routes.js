// Product folder routes for Lungo Corretores clients.
// Adds clickable product folders and multiple PDF documents per product.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const realExpress = require('express');

let registered = false;
const VERSION = '1.0.0-client-product-folders';
const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const CUSTOMER_CLIENTS_FILE = process.env.CUSTOMER_CLIENTS_FILE_PATH || path.join(path.dirname(CLIENTS_FILE), 'customer_clients.json');
const MAX_PDF_BYTES = Number(process.env.CLIENT_DOC_MAX_BYTES || 6 * 1024 * 1024);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-token');
}
function send(res, status, payload) { setCors(res); return res.status(status).json(payload); }
function clean(value) { return String(value || '').trim(); }
function cleanToken(value) { return clean(value).toUpperCase().replace(/\s+/g, ''); }
function generateId(prefix = 'id') { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }
function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try { const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
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
function tokenFromRequest(req, body = null) {
  const auth = req.headers.authorization || '';
  if (body?.token) return String(body.token);
  if (req.query?.token) return String(req.query.token);
  if (req.query?.t) return String(req.query.t);
  if (req.headers['x-client-token']) return String(req.headers['x-client-token']);
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7);
  return '';
}
async function readBody(req) {
  if (req.body && Object.keys(req.body).length) return req.body;
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); } });
    req.on('error', () => resolve({}));
  });
}
function requireUser(req, body = null) {
  const client = findClientByToken(tokenFromRequest(req, body));
  if (!client) throw Object.assign(new Error('Token inválido ou inativo.'), { statusCode: 403 });
  return client;
}
function findCustomer(items, client, id) {
  return items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName));
}
function dateOnly(value) {
  const raw = clean(value);
  if (!raw) return '';
  const date = new Date(raw.length === 10 ? `${raw}T00:00:00` : raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
function money(value) { return clean(value); }
function safeDocumentsFrom(item) {
  const docs = [];
  if (Array.isArray(item?.documentosPdf)) docs.push(...item.documentosPdf);
  if (item?.documentacaoPdf && typeof item.documentacaoPdf === 'object') {
    const exists = docs.some((doc) => doc.id && doc.id === item.documentacaoPdf.id) || docs.some((doc) => doc.fileName === item.documentacaoPdf.fileName && doc.uploadedAt === item.documentacaoPdf.uploadedAt);
    if (!exists) docs.push({ id: item.documentacaoPdf.id || generateId('doc'), ...item.documentacaoPdf });
  }
  return docs.filter(Boolean);
}
function publicDocument(doc) {
  return {
    id: doc.id || '',
    fileName: doc.fileName || 'documentacao.pdf',
    mimeType: doc.mimeType || 'application/pdf',
    size: Number(doc.size || 0),
    uploadedAt: doc.uploadedAt || null
  };
}
function normalizeDocument(input) {
  if (!input || typeof input !== 'object') throw Object.assign(new Error('Envie o PDF.'), { statusCode: 400 });
  const fileName = clean(input.fileName || input.name || 'documentacao.pdf');
  const mimeType = clean(input.mimeType || input.type || 'application/pdf') || 'application/pdf';
  let dataBase64 = clean(input.dataBase64 || input.base64 || input.data || '');
  if (dataBase64.includes(',')) dataBase64 = dataBase64.split(',').pop();
  const size = Number(input.size || Math.ceil((dataBase64.length || 0) * 0.75));
  if (!dataBase64) throw Object.assign(new Error('Envie o PDF em base64.'), { statusCode: 400 });
  if (mimeType !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) throw Object.assign(new Error('A documentação deve ser PDF.'), { statusCode: 400 });
  if (size > MAX_PDF_BYTES) throw Object.assign(new Error(`PDF acima do limite permitido de ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB.`), { statusCode: 413 });
  return { id: generateId('doc'), fileName: fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`, mimeType: 'application/pdf', size, dataBase64, uploadedAt: new Date().toISOString() };
}
function normalizeSaleProduct(body = {}, current = {}) {
  return {
    ...current,
    id: clean(current.id || body.id) || generateId('venda'),
    produto: clean(body.produto !== undefined ? body.produto : current.produto),
    qtdVidas: clean(body.qtdVidas !== undefined ? body.qtdVidas : current.qtdVidas),
    valor: money(body.valor !== undefined ? body.valor : (body.valorFechado !== undefined ? body.valorFechado : current.valor)),
    dataVenda: dateOnly(body.dataVenda || body.data || current.dataVenda || current.createdAt) || new Date().toISOString().slice(0, 10),
    observacao: clean(body.observacao !== undefined ? body.observacao : current.observacao),
    documentosPdf: safeDocumentsFrom(current),
    createdAt: current.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
function publicProduct(customer, product) {
  const isMain = product.kind === 'principal';
  const raw = isMain ? customer : product.raw;
  return {
    id: product.id,
    kind: product.kind,
    produto: isMain ? (customer.produto || '') : (raw.produto || ''),
    qtdVidas: isMain ? (customer.qtdVidas || '') : (raw.qtdVidas || ''),
    valor: isMain ? (customer.valorFechado || '') : (raw.valor || raw.valorFechado || ''),
    data: isMain ? (customer.dataContratacao || '') : (raw.dataVenda || raw.data || ''),
    observacao: isMain ? (customer.observacao || '') : (raw.observacao || ''),
    documentos: safeDocumentsFrom(raw).map(publicDocument)
  };
}
function allProducts(customer) {
  const result = [{ id: 'principal', kind: 'principal', raw: customer }];
  const vendas = Array.isArray(customer.vendasBase) ? customer.vendasBase : [];
  vendas.forEach((sale) => result.push({ id: clean(sale.id) || generateId('venda'), kind: 'venda_base', raw: sale }));
  return result;
}
function listProducts(req, res) {
  try {
    const client = requireUser(req);
    const id = clean(req.params?.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = findCustomer(items, client, id);
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const customer = items[index];
    return send(res, 200, { ok: true, clienteId: id, products: allProducts(customer).map((product) => publicProduct(customer, product)), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao listar produtos.', version: VERSION }); }
}
async function addProduct(req, res) {
  try {
    const body = await readBody(req);
    const client = requireUser(req, body);
    const id = clean(req.params?.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = findCustomer(items, client, id);
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const sale = normalizeSaleProduct(body);
    if (!sale.produto) throw Object.assign(new Error('Informe o produto contratado.'), { statusCode: 400 });
    if (!Array.isArray(items[index].vendasBase)) items[index].vendasBase = [];
    items[index].vendasBase.push(sale);
    items[index].updatedAt = new Date().toISOString();
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 201, { ok: true, product: publicProduct(items[index], { id: sale.id, kind: 'venda_base', raw: sale }), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao cadastrar produto.', version: VERSION }); }
}
async function updateProduct(req, res) {
  try {
    const body = await readBody(req);
    const client = requireUser(req, body);
    const id = clean(req.params?.id || '');
    const productId = clean(req.params?.productId || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = findCustomer(items, client, id);
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const customer = items[index];
    if (productId === 'principal') {
      if (body.produto !== undefined) customer.produto = clean(body.produto);
      if (body.qtdVidas !== undefined) customer.qtdVidas = clean(body.qtdVidas);
      if (body.valor !== undefined || body.valorFechado !== undefined) customer.valorFechado = money(body.valor !== undefined ? body.valor : body.valorFechado);
      if (body.data !== undefined || body.dataContratacao !== undefined) customer.dataContratacao = dateOnly(body.data !== undefined ? body.data : body.dataContratacao);
      if (body.observacao !== undefined) customer.observacao = clean(body.observacao);
      customer.documentosPdf = safeDocumentsFrom(customer);
      customer.updatedAt = new Date().toISOString();
      saveArray(CUSTOMER_CLIENTS_FILE, items);
      return send(res, 200, { ok: true, product: publicProduct(customer, { id: 'principal', kind: 'principal', raw: customer }), version: VERSION });
    }
    const vendas = Array.isArray(customer.vendasBase) ? customer.vendasBase : [];
    const saleIndex = vendas.findIndex((sale) => clean(sale.id) === productId);
    if (saleIndex < 0) throw Object.assign(new Error('Produto não encontrado.'), { statusCode: 404 });
    vendas[saleIndex] = normalizeSaleProduct(body, vendas[saleIndex]);
    customer.vendasBase = vendas;
    customer.updatedAt = new Date().toISOString();
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, product: publicProduct(customer, { id: vendas[saleIndex].id, kind: 'venda_base', raw: vendas[saleIndex] }), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao editar produto.', version: VERSION }); }
}
async function addDocument(req, res) {
  try {
    const body = await readBody(req);
    const client = requireUser(req, body);
    const id = clean(req.params?.id || '');
    const productId = clean(req.params?.productId || '');
    const documentInput = body.documento || body.documentacaoPdf || body;
    const doc = normalizeDocument(documentInput);
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = findCustomer(items, client, id);
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const customer = items[index];
    if (productId === 'principal') {
      customer.documentosPdf = [...safeDocumentsFrom(customer), doc];
      customer.documentacaoPdf = customer.documentosPdf[customer.documentosPdf.length - 1];
      customer.updatedAt = new Date().toISOString();
      saveArray(CUSTOMER_CLIENTS_FILE, items);
      return send(res, 201, { ok: true, document: publicDocument(doc), product: publicProduct(customer, { id: 'principal', kind: 'principal', raw: customer }), version: VERSION });
    }
    const vendas = Array.isArray(customer.vendasBase) ? customer.vendasBase : [];
    const saleIndex = vendas.findIndex((sale) => clean(sale.id) === productId);
    if (saleIndex < 0) throw Object.assign(new Error('Produto não encontrado.'), { statusCode: 404 });
    vendas[saleIndex].documentosPdf = [...safeDocumentsFrom(vendas[saleIndex]), doc];
    vendas[saleIndex].documentacaoPdf = vendas[saleIndex].documentosPdf[vendas[saleIndex].documentosPdf.length - 1];
    vendas[saleIndex].updatedAt = new Date().toISOString();
    customer.vendasBase = vendas;
    customer.updatedAt = new Date().toISOString();
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 201, { ok: true, document: publicDocument(doc), product: publicProduct(customer, { id: productId, kind: 'venda_base', raw: vendas[saleIndex] }), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao salvar PDF.', version: VERSION }); }
}
function downloadDocument(req, res) {
  try {
    const client = requireUser(req);
    const id = clean(req.params?.id || '');
    const productId = clean(req.params?.productId || '');
    const docId = clean(req.params?.docId || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = findCustomer(items, client, id);
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const customer = items[index];
    let productRaw = customer;
    if (productId !== 'principal') {
      productRaw = (Array.isArray(customer.vendasBase) ? customer.vendasBase : []).find((sale) => clean(sale.id) === productId);
    }
    if (!productRaw) throw Object.assign(new Error('Produto não encontrado.'), { statusCode: 404 });
    const docs = safeDocumentsFrom(productRaw);
    const doc = docs.find((item) => clean(item.id) === docId) || docs.find((item) => clean(item.fileName) === docId);
    if (!doc?.dataBase64) throw Object.assign(new Error('PDF não encontrado.'), { statusCode: 404 });
    return send(res, 200, { ok: true, documentacaoPdf: doc, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao baixar PDF.', version: VERSION }); }
}
function register(app) {
  if (registered) return;
  registered = true;
  app.options('/api/clientes/:id/products', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/products/:productId', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/products/:productId/documents', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/products/:productId/documents/:docId', (req, res) => send(res, 204, {}));
  app.get('/api/clientes/products/health', (req, res) => send(res, 200, { ok: true, module: 'clientes-products', version: VERSION, maxPdfMb: Math.round(MAX_PDF_BYTES / 1024 / 1024), customerClientsFile: CUSTOMER_CLIENTS_FILE, time: new Date().toISOString() }));
  app.get('/api/clientes/:id/products', listProducts);
  app.post('/api/clientes/:id/products', addProduct);
  app.patch('/api/clientes/:id/products/:productId', updateProduct);
  app.post('/api/clientes/:id/products/:productId/documents', addDocument);
  app.get('/api/clientes/:id/products/:productId/documents/:docId', downloadDocument);
}
function patchExpress() {
  const patchedExpress = function patchedExpress(...args) { const app = realExpress(...args); register(app); return app; };
  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}
patchExpress();
module.exports = { register };
