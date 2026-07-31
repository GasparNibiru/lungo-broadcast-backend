// Admin Master Panel v2 for Lungo Corretores.
// Compact supervisor dashboard: custom token generation plus read-only production/customer metrics.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const realExpress = require('express');

let registered = false;
const VERSION = '2.0.0-admin-master-compact-dashboard';
const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const CUSTOMER_CLIENTS_FILE = process.env.CUSTOMER_CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'customer_clients.json');
const ADMIN_ACCESS_KEY = process.env.ADMIN_ACCESS_KEY || '';
const DEFAULT_CORRETOR_APP_URL = process.env.CORRETOR_APP_URL || process.env.FRONTEND_CORRETOR_URL || 'https://crm.lungocorretores.com.br';

const STATUS_LABELS = {
  novo: 'Novos',
  em_atendimento: 'Em atendimento',
  cotacao_enviada: 'Cotação enviada',
  documentacao_recebida: 'Documentação recebida',
  venda_cadastrada: 'Venda cadastrada',
  boleto_gerado: 'Boleto gerado',
  fechamento: 'Fechamento',
  venda_perdida: 'Venda perdida',
  arquivado: 'Arquivado',
  lixeira: 'Lixeira'
};
const FUNNEL_ORDER = ['novo', 'em_atendimento', 'cotacao_enviada', 'documentacao_recebida', 'venda_cadastrada', 'boleto_gerado', 'fechamento', 'venda_perdida'];
const CLOSED_STATUSES = new Set(['fechamento', 'fechado', 'venda', 'vendido', 'cliente', 'ganho']);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key, x-client-token');
}
function send(res, status, payload) { setCors(res); return res.status(status).json(payload); }
function clean(value) { return String(value || '').trim(); }
function cleanToken(value) { return clean(value).toUpperCase().replace(/\s+/g, ''); }
function slug(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function normalizeStatus(value) {
  const raw = slug(value || 'novo');
  const aliases = {
    novo: 'novo', novos: 'novo',
    em_atendimento: 'em_atendimento', atendimento: 'em_atendimento',
    cotacao: 'cotacao_enviada', cotacao_enviada: 'cotacao_enviada',
    documentacao: 'documentacao_recebida', documentacao_recebida: 'documentacao_recebida',
    venda_cadastrada: 'venda_cadastrada', venda_cadastrada_no_plano: 'venda_cadastrada',
    boleto: 'boleto_gerado', boleto_gerado: 'boleto_gerado',
    fechamento: 'fechamento', fechado: 'fechamento', venda: 'fechamento', vendido: 'fechamento', cliente: 'fechamento', ganho: 'fechamento',
    venda_perdida: 'venda_perdida', perdido: 'venda_perdida',
    arquivado: 'arquivado', arquivo: 'arquivado',
    lixeira: 'lixeira', excluido: 'lixeira', deletado: 'lixeira', ignorado: 'lixeira'
  };
  return aliases[raw] || (STATUS_LABELS[raw] ? raw : 'novo');
}
function normalizeClientStatus(value) {
  const raw = slug(value || 'ativo');
  const aliases = { ativo: 'ativo', a_renovar: 'a_renovar', renovar: 'a_renovar', renovacao: 'a_renovar', renovado: 'renovado', cancelado: 'cancelado', inativo: 'inativo' };
  return aliases[raw] || 'ativo';
}
function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try { const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function saveArray(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}
function generateId(prefix = 'id') { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }
function generateToken() { return `LNG-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function generateInstanceName(name) {
  const base = slug(name || 'corretor') || 'corretor';
  return `lungo_${base}_${crypto.randomBytes(3).toString('hex')}`;
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
  return true;
}
function moneyNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = clean(value);
  if (!raw) return 0;
  const normalized = raw.replace(/[^0-9,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}
function dateValue(value) {
  const raw = clean(value);
  if (!raw) return 0;
  const date = new Date(raw);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}
function latestDate(items, fields) {
  let best = 0;
  items.forEach((item) => fields.forEach((field) => { best = Math.max(best, dateValue(item[field])); }));
  return best ? new Date(best).toISOString() : '';
}
function tokenMatches(item, client) {
  const token = cleanToken(client.token);
  const instance = clean(client.instanceName);
  return (token && cleanToken(item.token) === token) || (instance && clean(item.instanceName) === instance);
}
function publicClient(item) {
  const token = cleanToken(item.token || '');
  const nome = item.nome || item.name || item.instanceName || 'Corretor';
  const linkAcesso = clean(item.linkAcesso || item.accessUrl || item.urlAcesso || DEFAULT_CORRETOR_APP_URL);
  const mensagemEnvio = clean(item.mensagemEnvio || item.mensagemDeEnvio || item.accessMessage || buildAccessMessage(nome, token, linkAcesso));
  return {
    id: item.id || '', nome, token,
    instanceName: item.instanceName || '', whatsapp: item.whatsapp || item.telefone || '', email: item.email || '', plano: item.plano || item.plan || '',
    observacao: item.observacao || item.observacoes || item.notes || '', linkAcesso, mensagemEnvio,
    ativo: item.ativo !== false, createdAt: item.createdAt || '', updatedAt: item.updatedAt || '', lastAccessAt: item.lastAccessAt || '', accessCount: Number(item.accessCount || 0)
  };
}
function buildAccessMessage(nome, token, link) {
  return `Olá, ${nome || 'corretor'}! Seu acesso ao Lungo Corretores está liberado.\n\nAcesse: ${link || DEFAULT_CORRETOR_APP_URL}\nToken: ${token || ''}\n\nAo entrar, conecte seu WhatsApp pelo QR Code para usar Disparos, Meus Leads e Clientes.`;
}
function productSalesValue(customer) {
  const sales = Array.isArray(customer.vendasBase) ? customer.vendasBase : [];
  return sales.reduce((sum, sale) => sum + moneyNumber(sale.valor || sale.valorFechado || sale.valorVenda), 0);
}
function productSalesCount(customer) {
  return Array.isArray(customer.vendasBase) ? customer.vendasBase.length : 0;
}
function productName(value) { return clean(value) || 'Não informado'; }
function collectCustomerProducts(customer, produtos) {
  const main = productName(customer.produto);
  if (!produtos[main]) produtos[main] = { produto: main, quantidade: 0, valor: 0 };
  produtos[main].quantidade += 1;
  produtos[main].valor += moneyNumber(customer.valorFechado);
  const sales = Array.isArray(customer.vendasBase) ? customer.vendasBase : [];
  sales.forEach((sale) => {
    const name = productName(sale.produto);
    if (!produtos[name]) produtos[name] = { produto: name, quantidade: 0, valor: 0 };
    produtos[name].quantidade += 1;
    produtos[name].valor += moneyNumber(sale.valor || sale.valorFechado || sale.valorVenda);
  });
}
function publicCustomer(customer) {
  return {
    id: customer.id || '', nome: customer.nome || '', telefone: customer.telefone || '', email: customer.email || '', produto: customer.produto || '',
    status: normalizeClientStatus(customer.status), qtdVidas: customer.qtdVidas || '', valorFechado: customer.valorFechado || '', dataContratacao: customer.dataContratacao || '',
    dataRenovacao: customer.dataRenovacao || '', vendasBaseQtd: productSalesCount(customer), vendasBaseValor: productSalesValue(customer), updatedAt: customer.updatedAt || customer.createdAt || ''
  };
}
function buildDashboard() {
  const clientsRaw = loadArray(CLIENTS_FILE);
  const leadsRaw = loadArray(LEADS_FILE);
  const customerRaw = loadArray(CUSTOMER_CLIENTS_FILE);
  const clients = clientsRaw.map(publicClient);
  const rows = clients.map((client) => {
    const leads = leadsRaw.filter((lead) => tokenMatches(lead, client));
    const visibleLeads = leads.filter((lead) => normalizeStatus(lead.status) !== 'lixeira');
    const customers = customerRaw.filter((customer) => tokenMatches(customer, client));
    const funil = {};
    FUNNEL_ORDER.forEach((status) => { funil[status] = 0; });
    visibleLeads.forEach((lead) => {
      const status = normalizeStatus(lead.status);
      if (FUNNEL_ORDER.includes(status)) funil[status] += 1;
    });
    const produtosMap = {};
    customers.forEach((customer) => collectCustomerProducts(customer, produtosMap));
    const clientesResumo = {
      total: customers.length,
      ativos: customers.filter((customer) => normalizeClientStatus(customer.status) === 'ativo').length,
      aRenovar: customers.filter((customer) => normalizeClientStatus(customer.status) === 'a_renovar').length,
      cancelados: customers.filter((customer) => ['cancelado', 'inativo'].includes(normalizeClientStatus(customer.status))).length,
      totalVidas: customers.reduce((sum, customer) => sum + Number(customer.qtdVidas || 0), 0),
      valorContratos: customers.reduce((sum, customer) => sum + moneyNumber(customer.valorFechado), 0),
      valorBase: customers.reduce((sum, customer) => sum + productSalesValue(customer), 0),
      produtos: Object.values(produtosMap).sort((a, b) => b.quantidade - a.quantidade || b.valor - a.valor),
      lista: customers.map(publicCustomer).sort((a, b) => dateValue(b.updatedAt || b.dataContratacao) - dateValue(a.updatedAt || a.dataContratacao)).slice(0, 30)
    };
    clientesResumo.valorTotal = clientesResumo.valorContratos + clientesResumo.valorBase;
    return {
      ...client,
      leadCount: visibleLeads.length,
      trashCount: leads.length - visibleLeads.length,
      funil,
      fechamentos: visibleLeads.filter((lead) => CLOSED_STATUSES.has(normalizeStatus(lead.status))).length,
      clientes: clientesResumo.total,
      valorFechado: clientesResumo.valorTotal,
      clientesResumo,
      lastSyncAt: latestDate(leads, ['lastMessageAt', 'updatedAt', 'createdAt']),
      lastLeadAt: latestDate(visibleLeads, ['lastMessageAt', 'updatedAt', 'createdAt'])
    };
  });
  const totals = rows.reduce((acc, row) => {
    acc.corretores += 1;
    if (row.ativo) acc.ativos += 1; else acc.inativos += 1;
    acc.leads += row.leadCount;
    acc.clientes += row.clientesResumo.total;
    acc.clientesAtivos += row.clientesResumo.ativos;
    acc.aRenovar += row.clientesResumo.aRenovar;
    acc.fechamentos += row.fechamentos;
    acc.valorFechado += row.valorFechado;
    acc.totalVidas += row.clientesResumo.totalVidas;
    FUNNEL_ORDER.forEach((status) => { acc.funil[status] += row.funil[status] || 0; });
    return acc;
  }, { corretores: 0, ativos: 0, inativos: 0, leads: 0, clientes: 0, clientesAtivos: 0, aRenovar: 0, fechamentos: 0, valorFechado: 0, totalVidas: 0, funil: Object.fromEntries(FUNNEL_ORDER.map((status) => [status, 0])) });
  return { ok: true, totals, corretores: rows, funnelOrder: FUNNEL_ORDER, statusLabels: STATUS_LABELS, corretorAppUrl: DEFAULT_CORRETOR_APP_URL, version: VERSION };
}
async function loginRoute(req, res) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    return send(res, 200, { ok: true, role: 'admin_master', version: VERSION, corretorAppUrl: DEFAULT_CORRETOR_APP_URL, time: new Date().toISOString() });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao validar admin.', version: VERSION }); }
}
function dashboardRoute(req, res) {
  try {
    requireAdmin(req);
    return send(res, 200, { ...buildDashboard(), time: new Date().toISOString() });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao carregar painel admin.', version: VERSION }); }
}
async function createClientRoute(req, res) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    const nome = clean(body.nome || body.name || 'Novo corretor');
    let token = cleanToken(body.token) || generateToken();
    let instanceName = clean(body.instanceName) || generateInstanceName(nome);
    const whatsapp = clean(body.whatsapp || body.telefone || '');
    const email = clean(body.email || '');
    const plano = clean(body.plano || body.plan || '');
    const observacao = clean(body.observacao || body.observacoes || body.notes || '');
    const linkAcesso = clean(body.linkAcesso || body.accessUrl || body.urlAcesso || DEFAULT_CORRETOR_APP_URL);
    if (!nome) throw Object.assign(new Error('Informe o nome do corretor.'), { statusCode: 400 });
    if (body.token && !/^[A-Z0-9_-]{4,60}$/.test(token)) throw Object.assign(new Error('Token personalizado deve ter 4 a 60 caracteres e usar letras, números, hífen ou underline.'), { statusCode: 400 });
    const clients = loadArray(CLIENTS_FILE);
    const tokenExists = (value) => clients.some((client) => cleanToken(client.token) === cleanToken(value));
    const instanceExists = (value) => clients.some((client) => clean(client.instanceName) === clean(value));
    for (let tries = 0; tokenExists(token) && tries < 5 && !body.token; tries += 1) token = generateToken();
    for (let tries = 0; instanceExists(instanceName) && tries < 5; tries += 1) instanceName = generateInstanceName(nome);
    if (tokenExists(token)) throw Object.assign(new Error('Token já existe. Escolha outro token.'), { statusCode: 409 });
    if (instanceExists(instanceName)) throw Object.assign(new Error('Instância já existe. Informe outro nome de instância.'), { statusCode: 409 });
    const mensagemEnvio = clean(body.mensagemEnvio || body.mensagemDeEnvio || body.accessMessage || buildAccessMessage(nome, token, linkAcesso));
    const now = new Date().toISOString();
    const client = { id: generateId('cliente'), nome, token, instanceName, whatsapp, email, plano, observacao, linkAcesso, mensagemEnvio, ativo: true, createdAt: now, updatedAt: now };
    clients.push(client);
    saveArray(CLIENTS_FILE, clients);
    return send(res, 201, { ok: true, client: publicClient(client), dashboard: buildDashboard(), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao criar corretor.', version: VERSION }); }
}
function register(app) {
  if (registered) return;
  registered = true;
  app.options('/api/admin-master-v2/health', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v2/login', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v2/dashboard', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v2/clients', (req, res) => send(res, 204, {}));
  app.get('/api/admin-master-v2/health', (req, res) => send(res, 200, { ok: true, module: 'admin-master-v2', version: VERSION, corretorAppUrl: DEFAULT_CORRETOR_APP_URL, clientsFile: CLIENTS_FILE, leadsFile: LEADS_FILE, customerClientsFile: CUSTOMER_CLIENTS_FILE, time: new Date().toISOString() }));
  app.post('/api/admin-master-v2/login', loginRoute);
  app.get('/api/admin-master-v2/dashboard', dashboardRoute);
  app.post('/api/admin-master-v2/clients', createClientRoute);
}
function patchExpress() {
  const patchedExpress = function patchedExpress(...args) { const app = realExpress(...args); register(app); return app; };
  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}
patchExpress();
module.exports = { register, buildDashboard };
