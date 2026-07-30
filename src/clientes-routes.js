// Clientes module for Lungo Corretores.
// Stores post-sale clients, base repurchases and renewal alerts by client token.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const realExpress = require('express');

let registered = false;
const VERSION = '1.1.0-clientes-base-sales';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const CUSTOMER_CLIENTS_FILE = process.env.CUSTOMER_CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'customer_clients.json');
const RENEWAL_ALERT_DAYS = Number(process.env.CLIENT_RENEWAL_ALERT_DAYS || 40);

const STATUS_LABELS = { ativo: 'Ativo', a_renovar: 'A renovar', renovado: 'Renovado', cancelado: 'Cancelado', inativo: 'Inativo' };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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
function publicClient(client) {
  return { nome: client.nome || client.instanceName, instanceName: client.instanceName, ativo: client.ativo !== false, whatsapp: client.whatsapp || '' };
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
function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  return digits;
}
function moneyNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = clean(value);
  if (!raw) return 0;
  const normalized = raw.replace(/[^0-9,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}
function dateOnly(value) {
  const raw = clean(value);
  if (!raw) return '';
  const date = new Date(raw.length === 10 ? `${raw}T00:00:00` : raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
function todayZero() { const today = new Date(); today.setHours(0, 0, 0, 0); return today; }
function addYears(date, years) { const copy = new Date(date.getTime()); copy.setFullYear(copy.getFullYear() + years); return copy; }
function daysBetween(a, b) { return Math.ceil((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)); }
function nextRenewalDate(item) {
  const explicit = dateOnly(item.dataRenovacao);
  if (explicit) return new Date(`${explicit}T00:00:00`);
  const startRaw = dateOnly(item.dataContratacao);
  if (!startRaw) return null;
  const start = new Date(`${startRaw}T00:00:00`);
  const today = todayZero();
  let renewal = addYears(start, 1);
  while (renewal < new Date(today.getTime() - RENEWAL_ALERT_DAYS * 24 * 60 * 60 * 1000)) renewal = addYears(renewal, 1);
  return renewal;
}
function normalizeStatus(value) {
  const raw = clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const aliases = { ativo: 'ativo', cliente_ativo: 'ativo', a_renovar: 'a_renovar', renovar: 'a_renovar', renovacao: 'a_renovar', renovado: 'renovado', cancelado: 'cancelado', inativo: 'inativo' };
  return aliases[raw] || (STATUS_LABELS[raw] ? raw : 'ativo');
}
function effectiveStatus(item) {
  const base = normalizeStatus(item.status || 'ativo');
  if (['cancelado', 'inativo'].includes(base)) return base;
  const renewal = nextRenewalDate(item);
  if (renewal) {
    const days = daysBetween(todayZero(), renewal);
    if (days >= 0 && days <= RENEWAL_ALERT_DAYS) return 'a_renovar';
  }
  return base;
}
function normalizeSale(item = {}) {
  return {
    id: clean(item.id) || generateId('venda'),
    produto: clean(item.produto),
    qtdVidas: clean(item.qtdVidas),
    valor: clean(item.valor || item.valorFechado || item.valorVenda),
    dataVenda: dateOnly(item.dataVenda || item.data || item.createdAt) || new Date().toISOString().slice(0, 10),
    observacao: clean(item.observacao),
    createdAt: item.createdAt || new Date().toISOString()
  };
}
function normalizedSales(item) {
  const sales = Array.isArray(item.vendasBase) ? item.vendasBase : [];
  return sales.map(normalizeSale).filter((sale) => sale.produto || sale.valor || sale.qtdVidas);
}
function publicCustomer(item) {
  const status = effectiveStatus(item);
  const renewal = nextRenewalDate(item);
  const vendasBase = normalizedSales(item);
  return {
    id: item.id,
    nome: item.nome || '',
    telefone: item.telefone || '',
    email: item.email || '',
    documento: item.documento || item.cpfCnpj || '',
    cpfCnpj: item.cpfCnpj || item.documento || '',
    cidade: item.cidade || '',
    produto: item.produto || '',
    qtdVidas: item.qtdVidas || '',
    valorFechado: item.valorFechado || '',
    status,
    statusBase: normalizeStatus(item.status || 'ativo'),
    statusLabel: STATUS_LABELS[status] || status,
    dataContratacao: item.dataContratacao || '',
    dataRenovacao: item.dataRenovacao || (renewal ? renewal.toISOString().slice(0, 10) : ''),
    diasParaRenovar: renewal ? daysBetween(todayZero(), renewal) : null,
    observacao: item.observacao || '',
    posVenda: item.posVenda || null,
    vendasBase,
    valorVendasBase: vendasBase.reduce((sum, sale) => sum + moneyNumber(sale.valor), 0),
    totalVendasBase: vendasBase.length,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null
  };
}
function searchText(item) {
  return [item.nome, item.telefone, item.email, item.documento, item.cpfCnpj, item.cidade, item.produto, item.status, item.observacao, ...normalizedSales(item).map((sale) => `${sale.produto} ${sale.valor} ${sale.observacao}`)].join(' ').toLowerCase();
}
function periodFilter(item, period, fromRaw, toRaw) {
  if (!period || period === 'all') return true;
  const base = item.dataContratacao || item.createdAt || item.updatedAt || '';
  const date = base ? new Date(base.length === 10 ? `${base}T00:00:00` : base) : null;
  if (!date || Number.isNaN(date.getTime())) return false;
  const today = todayZero();
  if (period === 'today') return date >= today;
  if (period === 'yesterday') {
    const from = new Date(today); from.setDate(from.getDate() - 1);
    const to = new Date(today); to.setMilliseconds(-1);
    return date >= from && date <= to;
  }
  if (['7', '15', '30', '90', '365'].includes(period)) {
    const from = new Date(today); from.setDate(from.getDate() - Number(period));
    return date >= from;
  }
  if (period === 'custom') {
    const from = fromRaw ? new Date(`${fromRaw}T00:00:00`) : null;
    const to = toRaw ? new Date(`${toRaw}T23:59:59`) : null;
    if (from && date < from) return false;
    if (to && date > to) return false;
  }
  return true;
}
function monthKey(value) { const date = dateOnly(value); return date ? date.slice(0, 7) : 'Sem data'; }
function metrics(items) {
  const totalVidas = items.reduce((sum, item) => sum + Number(item.qtdVidas || 0), 0);
  const faturamentoTotal = items.reduce((sum, item) => sum + moneyNumber(item.valorFechado), 0);
  const vendasBaseValor = items.reduce((sum, item) => sum + Number(item.valorVendasBase || 0), 0);
  const vendasBaseQtd = items.reduce((sum, item) => sum + Number(item.totalVendasBase || 0), 0);
  const produtos = {};
  const porMes = {};
  const vendasBaseMes = {};
  items.forEach((item) => {
    const produto = clean(item.produto) || 'Não informado';
    produtos[produto] = (produtos[produto] || 0) + 1;
    const key = monthKey(item.dataContratacao || item.createdAt || item.updatedAt);
    porMes[key] = (porMes[key] || 0) + moneyNumber(item.valorFechado);
    normalizedSales(item).forEach((sale) => {
      const saleKey = monthKey(sale.dataVenda || sale.createdAt);
      vendasBaseMes[saleKey] = (vendasBaseMes[saleKey] || 0) + moneyNumber(sale.valor);
    });
  });
  return {
    totalClientes: items.length,
    totalVidas,
    faturamentoTotal,
    aRenovar: items.filter((item) => item.status === 'a_renovar').length,
    vendasBaseValor,
    vendasBaseQtd,
    produtos: Object.entries(produtos).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    faturamentoMensal: Object.entries(porMes).map(([label, value]) => ({ label, value })).sort((a, b) => a.label.localeCompare(b.label)),
    vendasBaseMensal: Object.entries(vendasBaseMes).map(([label, value]) => ({ label, value })).sort((a, b) => a.label.localeCompare(b.label))
  };
}
function buildCustomer(body, client, current = {}) {
  const now = new Date().toISOString();
  const nome = clean(body.nome !== undefined ? body.nome : current.nome);
  const telefone = normalizePhone(body.telefone !== undefined ? body.telefone : current.telefone);
  if (!nome || nome.length < 2) throw Object.assign(new Error('Informe o nome do cliente.'), { statusCode: 400 });
  if (!telefone || telefone.length < 8) throw Object.assign(new Error('Informe um WhatsApp válido.'), { statusCode: 400 });
  const incomingSales = Array.isArray(body.vendasBase) ? body.vendasBase.map(normalizeSale) : normalizedSales(current);
  return {
    ...current,
    id: current.id || generateId('cliente'),
    instanceName: client.instanceName,
    nome,
    telefone,
    email: clean(body.email !== undefined ? body.email : current.email),
    documento: clean(body.documento !== undefined ? body.documento : (current.documento || current.cpfCnpj)),
    cpfCnpj: clean(body.cpfCnpj !== undefined ? body.cpfCnpj : (body.documento !== undefined ? body.documento : (current.cpfCnpj || current.documento))),
    cidade: clean(body.cidade !== undefined ? body.cidade : current.cidade),
    produto: clean(body.produto !== undefined ? body.produto : current.produto),
    qtdVidas: clean(body.qtdVidas !== undefined ? body.qtdVidas : current.qtdVidas),
    valorFechado: clean(body.valorFechado !== undefined ? body.valorFechado : current.valorFechado),
    status: normalizeStatus(body.status !== undefined ? body.status : (current.status || 'ativo')),
    dataContratacao: dateOnly(body.dataContratacao !== undefined ? body.dataContratacao : current.dataContratacao),
    dataRenovacao: dateOnly(body.dataRenovacao !== undefined ? body.dataRenovacao : current.dataRenovacao),
    observacao: clean(body.observacao !== undefined ? body.observacao : current.observacao),
    posVenda: body.posVenda !== undefined ? body.posVenda : (current.posVenda || null),
    vendasBase: incomingSales,
    createdAt: current.createdAt || now,
    updatedAt: now
  };
}
function requireUser(req, body = null) {
  const client = findClientByToken(tokenFromRequest(req, body));
  if (!client) throw Object.assign(new Error('Token inválido ou inativo.'), { statusCode: 403 });
  return client;
}
function listCustomers(req, res) {
  try {
    const client = requireUser(req);
    const q = clean(req.query.q || req.query.search || '').toLowerCase();
    const status = clean(req.query.status || '');
    const period = clean(req.query.period || 'all');
    const from = clean(req.query.from || '');
    const to = clean(req.query.to || '');
    let items = loadArray(CUSTOMER_CLIENTS_FILE).filter((item) => clean(item.instanceName) === clean(client.instanceName)).map(publicCustomer);
    if (status) items = items.filter((item) => item.status === normalizeStatus(status));
    if (period) items = items.filter((item) => periodFilter(item, period, from, to));
    if (q) items = items.filter((item) => searchText(item).includes(q));
    items.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    return send(res, 200, { ok: true, client: publicClient(client), clientes: items, metrics: metrics(items), statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })), version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao listar clientes.', version: VERSION });
  }
}
async function createOrUpdateCustomer(req, res, existingId = '') {
  try {
    const body = await readBody(req);
    const client = requireUser(req, body);
    const id = clean(existingId || req.params?.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = id ? items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName)) : -1;
    if (id && index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const customer = buildCustomer(body, client, index >= 0 ? items[index] : {});
    if (index >= 0) items[index] = customer;
    else items.push(customer);
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, index >= 0 ? 200 : 201, { ok: true, cliente: publicCustomer(customer), version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao salvar cliente.', version: VERSION });
  }
}
async function importCustomers(req, res) {
  try {
    const body = await readBody(req);
    const client = requireUser(req, body);
    const incoming = Array.isArray(body.clientes) ? body.clientes : [];
    if (!incoming.length) return send(res, 400, { ok: false, error: 'Envie uma lista de clientes para importar.', version: VERSION });
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    let created = 0;
    let updated = 0;
    const errors = [];
    incoming.slice(0, 1000).forEach((row, idx) => {
      try {
        const phone = normalizePhone(row.telefone || row.whatsapp || row.celular || '');
        const index = phone ? items.findIndex((item) => clean(item.instanceName) === clean(client.instanceName) && normalizePhone(item.telefone || '') === phone) : -1;
        const customer = buildCustomer({ ...row, telefone: phone, status: row.status || 'ativo' }, client, index >= 0 ? items[index] : {});
        if (index >= 0) { items[index] = customer; updated += 1; }
        else { items.push(customer); created += 1; }
      } catch (error) { errors.push({ row: idx + 2, error: error.message }); }
    });
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, created, updated, errors, version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao importar clientes.', version: VERSION });
  }
}
async function addBaseSale(req, res) {
  try {
    const body = await readBody(req);
    const client = requireUser(req, body);
    const id = clean(req.params?.id || body.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName));
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const sale = normalizeSale(body);
    if (!sale.produto && !sale.valor) throw Object.assign(new Error('Informe pelo menos produto ou valor da nova venda.'), { statusCode: 400 });
    const current = items[index];
    current.vendasBase = [...normalizedSales(current), sale];
    current.updatedAt = new Date().toISOString();
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, venda: sale, cliente: publicCustomer(current), version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao registrar venda da base.', version: VERSION });
  }
}
async function updatePostSale(req, res) {
  try {
    const body = await readBody(req);
    const client = requireUser(req, body);
    const id = clean(req.params?.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName));
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    items[index].posVenda = { tipo: clean(body.tipo || 'relacionamento'), data: dateOnly(body.data || ''), recorrencia: clean(body.recorrencia || 'unica'), mensagem: clean(body.mensagem || ''), ativo: body.ativo !== false, updatedAt: new Date().toISOString() };
    items[index].updatedAt = new Date().toISOString();
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, cliente: publicCustomer(items[index]), version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao salvar pós-venda.', version: VERSION });
  }
}
function deleteCustomer(req, res) {
  try {
    const client = requireUser(req);
    const id = clean(req.params?.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const filtered = items.filter((item) => !(item.id === id && clean(item.instanceName) === clean(client.instanceName)));
    if (filtered.length === items.length) return send(res, 404, { ok: false, error: 'Cliente não encontrado.', version: VERSION });
    saveArray(CUSTOMER_CLIENTS_FILE, filtered);
    return send(res, 200, { ok: true, removed: true, version: VERSION });
  } catch (error) {
    return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao excluir cliente.', version: VERSION });
  }
}
function register(app) {
  if (registered) return;
  registered = true;
  app.options('/api/clientes', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/import', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/post-sale', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/base-sale', (req, res) => send(res, 204, {}));
  app.get('/api/clientes/health', (req, res) => send(res, 200, { ok: true, module: 'clientes', version: VERSION, clientsFile: CLIENTS_FILE, customerClientsFile: CUSTOMER_CLIENTS_FILE, renewalAlertDays: RENEWAL_ALERT_DAYS, statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })), features: ['vendasBase', 'importacaoClientes', 'filtroPeriodosAvancado'], time: new Date().toISOString() }));
  app.get('/api/clientes', listCustomers);
  app.post('/api/clientes', (req, res) => createOrUpdateCustomer(req, res));
  app.post('/api/clientes/import', importCustomers);
  app.put('/api/clientes/:id', (req, res) => createOrUpdateCustomer(req, res, req.params.id));
  app.patch('/api/clientes/:id', (req, res) => createOrUpdateCustomer(req, res, req.params.id));
  app.post('/api/clientes/:id/post-sale', updatePostSale);
  app.post('/api/clientes/:id/base-sale', addBaseSale);
  app.delete('/api/clientes/:id', deleteCustomer);
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
