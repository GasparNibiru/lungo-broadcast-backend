// Admin Master Panel v4 for Lungo Corretores.
// Stable module for dashboard, token generation with Evolution creation, deactivate/reactivate and full instance removal from admin list.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '4.0.0-admin-master-evolution-fixed';
const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const CUSTOMER_CLIENTS_FILE = process.env.CUSTOMER_CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'customer_clients.json');
const ADMIN_ACCESS_KEY = process.env.ADMIN_ACCESS_KEY || process.env.ADMIN_KEY || '';
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
function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  return digits;
}
function normalizeStatus(value) {
  const raw = slug(value || 'novo');
  const aliases = {
    novo: 'novo', novos: 'novo',
    em_atendimento: 'em_atendimento', atendimento: 'em_atendimento',
    cotacao: 'cotacao_enviada', cotacao_enviada: 'cotacao_enviada',
    documentacao: 'documentacao_recebida', documentacao_recebida: 'documentacao_recebida',
    venda_cadastrada: 'venda_cadastrada',
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
  const possibleTokens = [item.token, item.clientToken, item.clienteToken, item.customerToken, item.userToken, item.userId];
  const possibleInstances = [item.instanceName, item.instance, item.whatsappInstance];
  return Boolean(
    (token && possibleTokens.some((value) => cleanToken(value) === token)) ||
    (instance && possibleInstances.some((value) => clean(value) === instance))
  );
}
function buildAccessMessage(nome, token, linkAcesso = DEFAULT_CORRETOR_APP_URL) {
  const safeName = clean(nome) || 'corretor';
  const safeToken = clean(token) || 'SEU-TOKEN';
  const safeUrl = clean(linkAcesso) || DEFAULT_CORRETOR_APP_URL;
  return `Olá, ${safeName}! Seu acesso ao Lungo Corretores está pronto.\n\nAcesse: ${safeUrl}\nToken: ${safeToken}\n\nDepois de entrar, conecte seu WhatsApp pelo QR Code para usar Meus Leads, Clientes e Disparos.`;
}
function publicClient(item) {
  const token = item.token || '';
  const linkAcesso = item.linkAcesso || item.accessUrl || item.urlAcesso || DEFAULT_CORRETOR_APP_URL;
  return {
    id: item.id || '',
    nome: item.nome || item.name || item.instanceName || 'Corretor',
    token,
    instanceName: item.instanceName || '',
    whatsapp: item.whatsapp || item.telefone || '',
    email: item.email || '',
    plano: item.plano || item.plan || '',
    observacao: item.observacao || item.observacoes || item.notes || '',
    linkAcesso,
    mensagemEnvio: item.mensagemEnvio || item.mensagemDeEnvio || item.accessMessage || buildAccessMessage(item.nome || item.name, token, linkAcesso),
    ativo: item.ativo !== false,
    instanceStatus: item.instanceStatus || '',
    instanceCreatedAt: item.instanceCreatedAt || '',
    instanceCreateError: item.instanceCreateError || '',
    instanceDeletedAt: item.instanceDeletedAt || '',
    instanceDeleteError: item.instanceDeleteError || '',
    createdAt: item.createdAt || '',
    updatedAt: item.updatedAt || '',
    lastAccessAt: item.lastAccessAt || '',
    accessCount: Number(item.accessCount || 0)
  };
}
function productSalesValue(customer) {
  const sales = Array.isArray(customer.vendasBase) ? customer.vendasBase : [];
  return sales.reduce((sum, sale) => sum + moneyNumber(sale.valor || sale.valorFechado || sale.valorVenda), 0);
}
function collectCustomerProducts(customer, bucket) {
  const mainProduct = clean(customer.produto || customer.product || customer.plano || '');
  if (mainProduct) {
    if (!bucket[mainProduct]) bucket[mainProduct] = { produto: mainProduct, quantidade: 0, valor: 0 };
    bucket[mainProduct].quantidade += 1;
    bucket[mainProduct].valor += moneyNumber(customer.valorFechado || customer.valor || 0);
  }
  const sales = Array.isArray(customer.vendasBase) ? customer.vendasBase : [];
  sales.forEach((sale) => {
    const product = clean(sale.produto || sale.product || '');
    if (!product) return;
    if (!bucket[product]) bucket[product] = { produto: product, quantidade: 0, valor: 0 };
    bucket[product].quantidade += 1;
    bucket[product].valor += moneyNumber(sale.valor || sale.valorFechado || sale.valorVenda || 0);
  });
}
function publicCustomer(customer) {
  const status = normalizeClientStatus(customer.status || 'ativo');
  return {
    id: customer.id || '',
    nome: customer.nome || customer.name || 'Cliente',
    telefone: customer.telefone || customer.whatsapp || '',
    email: customer.email || '',
    produto: customer.produto || customer.product || '',
    status,
    statusLabel: status === 'a_renovar' ? 'A renovar' : status.charAt(0).toUpperCase() + status.slice(1),
    qtdVidas: customer.qtdVidas || customer.vidas || '',
    valorFechado: customer.valorFechado || customer.valor || '',
    dataContratacao: customer.dataContratacao || customer.createdAt || '',
    updatedAt: customer.updatedAt || customer.createdAt || ''
  };
}
function buildDashboard() {
  const clientsRaw = loadArray(CLIENTS_FILE);
  const leadsRaw = loadArray(LEADS_FILE);
  const customerRaw = loadArray(CUSTOMER_CLIENTS_FILE);
  const clients = clientsRaw.map(publicClient).filter((client) => client.instanceStatus !== 'deleted');
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
      totalVidas: customers.reduce((sum, customer) => sum + Number(customer.qtdVidas || customer.vidas || 0), 0),
      valorContratos: customers.reduce((sum, customer) => sum + moneyNumber(customer.valorFechado || customer.valor), 0),
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
function evolutionConfigured() {
  return Boolean(evolutionBaseUrl() && process.env.EVOLUTION_API_KEY);
}
function isConnectedState(state) {
  return ['open', 'connected', 'online'].includes(String(state || '').toLowerCase());
}
async function getEvolutionState(instanceName) {
  if (!evolutionConfigured() || !instanceName) return { ok: false, state: 'not_configured' };
  const template = process.env.EVOLUTION_CONNECTION_PATH || '/instance/connectionState/:instanceName';
  const attempt = await callEvolution('get', template, instanceName);
  if (attempt.ok) {
    const body = attempt.data || {};
    const state = body?.instance?.state || body?.state || body?.connectionState || 'unknown';
    return { ok: true, state, attempt };
  }
  const text = JSON.stringify(attempt.data || '').toLowerCase();
  if (attempt.status === 404 || text.includes('not found') || text.includes('not_found') || text.includes('instance not found')) return { ok: false, state: 'not_found', attempt };
  return { ok: false, state: 'unknown', attempt };
}
async function resolveConnectionStatus(client) {
  if (client.ativo === false) return { connectionStatus: 'disconnected', connectionLabel: 'Não conectado', connectionState: 'inactive' };
  if (client.instanceStatus === 'deleted' || client.instanceDeletedAt) return { connectionStatus: 'disconnected', connectionLabel: 'Não conectado', connectionState: 'deleted' };
  if (!client.instanceName) return { connectionStatus: 'disconnected', connectionLabel: 'Não conectado', connectionState: 'missing_instance' };
  try {
    const stateInfo = await getEvolutionState(client.instanceName);
    const state = stateInfo.state || 'unknown';
    if (isConnectedState(state)) return { connectionStatus: 'connected', connectionLabel: 'Conectado', connectionState: state };
    if (state === 'not_found') return { connectionStatus: 'disconnected', connectionLabel: 'Não conectado', connectionState: state };
    if (state === 'not_configured') return { connectionStatus: 'disconnected', connectionLabel: 'Não conectado', connectionState: state };
    return { connectionStatus: 'connecting', connectionLabel: 'Conectando', connectionState: state };
  } catch (error) {
    return { connectionStatus: 'disconnected', connectionLabel: 'Não conectado', connectionState: 'error', connectionError: error.message || 'Erro ao consultar Evolution' };
  }
}
async function buildDashboardLive() {
  const dashboard = buildDashboard();
  dashboard.corretores = await Promise.all((dashboard.corretores || []).map(async (client) => ({ ...client, ...(await resolveConnectionStatus(client)) })));
  dashboard.totals.conectados = dashboard.corretores.filter((item) => item.connectionStatus === 'connected').length;
  dashboard.totals.conectando = dashboard.corretores.filter((item) => item.connectionStatus === 'connecting').length;
  dashboard.totals.desconectados = dashboard.corretores.filter((item) => item.connectionStatus === 'disconnected').length;
  dashboard.version = VERSION;
  return dashboard;
}
async function createEvolutionInstance(instanceName, number) {
  if (!evolutionConfigured()) return { ok: false, skipped: true, reason: 'evolution_not_configured' };
  if (!instanceName) return { ok: false, reason: 'missing_instance_name' };
  const payload = {
    instanceName,
    qrcode: true,
    integration: process.env.EVOLUTION_INSTANCE_INTEGRATION || 'WHATSAPP-BAILEYS'
  };
  const cleanNumber = normalizePhone(number);
  if (cleanNumber) payload.number = cleanNumber;
  const template = process.env.EVOLUTION_CREATE_INSTANCE_PATH || '/instance/create';
  try {
    const url = buildEvolutionUrl(template, instanceName);
    const response = await axios.post(url, payload, { headers: evolutionHeaders(), timeout: 30000, validateStatus: () => true });
    const text = JSON.stringify(response.data || '').toLowerCase();
    const ok = response.status >= 200 && response.status < 300;
    const alreadyExists = response.status === 409 || text.includes('already') || text.includes('existe') || text.includes('duplic');
    if (ok || alreadyExists) return { ok: true, alreadyExists, status: response.status, path: template, data: trimData(response.data) };
    return { ok: false, status: response.status, path: template, data: trimData(response.data), message: response.data?.message || response.data?.error || 'Evolution não criou a instância.' };
  } catch (error) {
    return { ok: false, path: template, error: error.message || 'Erro ao criar instância na Evolution.' };
  }
}
async function cleanupEvolutionInstance(instanceName) {
  if (!evolutionConfigured() || !instanceName) {
    return { ok: false, skipped: true, reason: 'evolution_not_configured_or_missing_instance' };
  }
  const templates = [
    process.env.EVOLUTION_DELETE_INSTANCE_PATH || '/instance/delete/:instanceName',
    '/instance/delete/:instanceName',
    process.env.EVOLUTION_LOGOUT_PATH || '/instance/logout/:instanceName',
    '/instance/logout/:instanceName'
  ].filter(Boolean);
  const methods = ['delete', 'post', 'get'];
  const attempts = [];
  const seen = new Set();
  for (const template of templates) {
    for (const method of methods) {
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
      } catch (error) {
        attempts.push({ method, path: template, ok: false, error: error.message || 'Erro na Evolution' });
      }
    }
  }
  return { ok: false, instanceName, attempts };
}
async function loginRoute(req, res) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    return send(res, 200, { ok: true, role: 'admin_master', version: VERSION, corretorAppUrl: DEFAULT_CORRETOR_APP_URL, time: new Date().toISOString() });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao validar admin.', version: VERSION }); }
}
async function dashboardRoute(req, res) {
  try {
    requireAdmin(req);
    return send(res, 200, { ...(await buildDashboardLive()), time: new Date().toISOString() });
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
    const instanceExists = (value) => clients.some((client) => clean(client.instanceName).toLowerCase() === clean(value).toLowerCase());
    for (let tries = 0; tokenExists(token) && tries < 8 && !body.token; tries += 1) token = generateToken();
    for (let tries = 0; instanceExists(instanceName) && tries < 8; tries += 1) instanceName = generateInstanceName(nome);
    if (tokenExists(token)) throw Object.assign(new Error('Token já existe. Escolha outro token.'), { statusCode: 409 });
    if (instanceExists(instanceName)) throw Object.assign(new Error('Instância já existe. Informe outro nome de instância.'), { statusCode: 409 });
    const mensagemEnvio = clean(body.mensagemEnvio || body.mensagemDeEnvio || body.accessMessage || buildAccessMessage(nome, token, linkAcesso));
    const evolution = await createEvolutionInstance(instanceName, whatsapp);
    if (!evolution.ok && !['1', 'true', 'sim', 'yes'].includes(clean(body.allowWithoutEvolution).toLowerCase())) {
      throw Object.assign(new Error(evolution.message || evolution.error || 'Não foi possível criar a instância na Evolution.'), { statusCode: 502, details: evolution });
    }
    const now = new Date().toISOString();
    const client = {
      id: generateId('cliente'), nome, token, instanceName, whatsapp, email, plano, observacao, linkAcesso, mensagemEnvio,
      ativo: true,
      instanceStatus: evolution.ok ? (evolution.alreadyExists ? 'existing' : 'created') : 'create_error',
      instanceCreatedAt: evolution.ok ? now : '',
      instanceCreateError: evolution.ok ? '' : (evolution.message || evolution.error || evolution.reason || 'create_failed'),
      createdAt: now, updatedAt: now
    };
    clients.push(client);
    saveArray(CLIENTS_FILE, clients);
    return send(res, 201, { ok: true, client: { ...publicClient(client), ...(await resolveConnectionStatus(publicClient(client))) }, evolution, dashboard: await buildDashboardLive(), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao criar corretor.', details: error.details || null, version: VERSION }); }
}
async function setActiveRoute(req, res, active) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    const token = cleanToken(req.params.token || body.token || '');
    if (!token) throw Object.assign(new Error('Token não informado.'), { statusCode: 400 });
    const clients = loadArray(CLIENTS_FILE);
    const index = clients.findIndex((client) => cleanToken(client.token) === token);
    if (index < 0) throw Object.assign(new Error('Corretor não encontrado.'), { statusCode: 404 });
    const now = new Date().toISOString();
    clients[index].ativo = Boolean(active);
    clients[index].updatedAt = now;
    saveArray(CLIENTS_FILE, clients);
    return send(res, 200, { ok: true, client: publicClient(clients[index]), dashboard: await buildDashboardLive(), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao atualizar acesso.', version: VERSION }); }
}
async function deleteInstanceRoute(req, res) {
  try {
    const body = await readBody(req);
    requireAdmin(req, body);
    const token = cleanToken(req.params.token || body.token || '');
    if (!token) throw Object.assign(new Error('Token não informado.'), { statusCode: 400 });
    const clients = loadArray(CLIENTS_FILE);
    const index = clients.findIndex((client) => cleanToken(client.token) === token);
    if (index < 0) throw Object.assign(new Error('Corretor não encontrado.'), { statusCode: 404 });
    const current = clients[index];
    const evolution = await cleanupEvolutionInstance(current.instanceName);
    const removedClient = { ...current, ativo: false, instanceStatus: 'deleted', instanceDeletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    clients.splice(index, 1);
    saveArray(CLIENTS_FILE, clients);
    return send(res, 200, { ok: true, removedFromAdmin: true, evolution, client: publicClient(removedClient), dashboard: await buildDashboardLive(), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao excluir instância.', version: VERSION }); }
}
function register(app) {
  if (registered) return;
  registered = true;
  app.options('/api/admin-master-v4/health', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v4/login', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v4/dashboard', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v4/clients', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v4/clients/:token/deactivate', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v4/clients/:token/reactivate', (req, res) => send(res, 204, {}));
  app.options('/api/admin-master-v4/clients/:token/delete-instance', (req, res) => send(res, 204, {}));
  app.get('/api/admin-master-v4/health', (req, res) => send(res, 200, { ok: true, module: 'admin-master-v4', version: VERSION, corretorAppUrl: DEFAULT_CORRETOR_APP_URL, evolutionConfigured: Boolean(evolutionBaseUrl() && process.env.EVOLUTION_API_KEY), createPath: process.env.EVOLUTION_CREATE_INSTANCE_PATH || '/instance/create', deletePath: process.env.EVOLUTION_DELETE_INSTANCE_PATH || '/instance/delete/:instanceName', connectionPath: process.env.EVOLUTION_CONNECTION_PATH || '/instance/connectionState/:instanceName', clientsFile: CLIENTS_FILE, leadsFile: LEADS_FILE, customerClientsFile: CUSTOMER_CLIENTS_FILE, time: new Date().toISOString() }));
  app.post('/api/admin-master-v4/login', loginRoute);
  app.get('/api/admin-master-v4/dashboard', dashboardRoute);
  app.post('/api/admin-master-v4/clients', createClientRoute);
  app.post('/api/admin-master-v4/clients/:token/deactivate', (req, res) => setActiveRoute(req, res, false));
  app.post('/api/admin-master-v4/clients/:token/reactivate', (req, res) => setActiveRoute(req, res, true));
  app.post('/api/admin-master-v4/clients/:token/delete-instance', deleteInstanceRoute);
}
function patchExpress() {
  const patchedExpress = function patchedExpress(...args) { const app = realExpress(...args); register(app); return app; };
  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}
patchExpress();
module.exports = { register, buildDashboard, buildDashboardLive };
