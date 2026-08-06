// Clientes module for Lungo Corretores.
// Stores post-sale clients, base repurchases, PDF documentation and renewal alerts by client token.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const realExpress = require('express');

let registered = false;
const VERSION = '1.2.0-clientes-docs-sync';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const CUSTOMER_CLIENTS_FILE = process.env.CUSTOMER_CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'customer_clients.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const RENEWAL_ALERT_DAYS = Number(process.env.CLIENT_RENEWAL_ALERT_DAYS || 40);
const MAX_PDF_BYTES = Number(process.env.CLIENT_DOC_MAX_BYTES || 6 * 1024 * 1024);

const STATUS_LABELS = { ativo: 'Ativo', a_renovar: 'A renovar', renovado: 'Renovado', cancelado: 'Cancelado', inativo: 'Inativo' };
const CLOSED_LEAD_STATUSES = new Set(['fechamento', 'fechado', 'venda', 'vendido', 'cliente', 'ganho']);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-token');
}
function send(res, status, payload) { setCors(res); return res.status(status).json(payload); }
function clean(value) { return String(value || '').trim(); }
function cleanToken(value) { return clean(value).toUpperCase().replace(/\s+/g, ''); }
function generateId(prefix = 'id') { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }
function todayZero() { const date = new Date(); date.setHours(0, 0, 0, 0); return date; }
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
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
    });
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
function addYears(date, years) { const copy = new Date(date.getTime()); copy.setFullYear(copy.getFullYear() + years); return copy; }
function daysBetween(a, b) { return Math.ceil((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)); }
function nextRenewalDate(item) {
  const explicit = dateOnly(item.dataRenovacao);
  if (explicit) return new Date(`${explicit}T00:00:00`);
  const startRaw = dateOnly(item.dataContratacao);
  if (!startRaw) return null;
  const start = new Date(`${startRaw}T00:00:00`);
  let renewal = addYears(start, 1);
  const minDate = new Date(todayZero().getTime() - RENEWAL_ALERT_DAYS * 24 * 60 * 60 * 1000);
  while (renewal < minDate) renewal = addYears(renewal, 1);
  return renewal;
}
function slug(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function normalizeStatus(value) {
  const raw = slug(value || 'ativo');
  const aliases = { ativo: 'ativo', cliente_ativo: 'ativo', a_renovar: 'a_renovar', renovar: 'a_renovar', renovacao: 'a_renovar', renovado: 'renovado', cancelado: 'cancelado', inativo: 'inativo' };
  return aliases[raw] || (STATUS_LABELS[raw] ? raw : 'ativo');
}
function normalizeLeadStatus(value) {
  const raw = slug(value || 'novo');
  const aliases = { fechamento: 'fechamento', fechado: 'fechamento', venda: 'fechamento', vendido: 'fechamento', ganho: 'fechamento', cliente: 'fechamento' };
  return aliases[raw] || raw;
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
function isBadName(value) {
  const raw = clean(value);
  const normalized = slug(raw);
  if (!raw) return true;
  if (['voce', 'voces', 'eu', 'me', 'you', 'self', 'owner', 'whatsapp', 'unknown', 'desconhecido', 'true', 'false'].includes(normalized)) return true;
  if (raw.includes('@')) return true;
  if (/^https?:\/\//i.test(raw)) return true;
  if (/^\+?\d{8,}$/.test(raw.replace(/[\s().-]/g, ''))) return true;
  return false;
}
function isUsableLead(lead) {
  const phone = normalizePhone(lead.telefone || '');
  const jid = clean(lead.whatsappJid || '');
  if (!phone || phone.length < 10 || phone.length > 15) return false;
  if (jid.includes('@lid') && phone === jid.split('@')[0].replace(/\D/g, '')) return false;
  const name = clean(lead.nome || '');
  if (isBadName(name)) return false;
  if (/^Contato\s+(WhatsApp|\d{10,})$/i.test(name)) return false;
  return true;
}
function publicDocument(doc) {
  if (!doc || typeof doc !== 'object') return null;
  return { fileName: doc.fileName || 'documentacao.pdf', mimeType: doc.mimeType || 'application/pdf', size: Number(doc.size || 0), uploadedAt: doc.uploadedAt || null };
}
function normalizeDocument(input) {
  if (!input || typeof input !== 'object') return null;
  const fileName = clean(input.fileName || input.name || 'documentacao.pdf');
  const mimeType = clean(input.mimeType || input.type || 'application/pdf') || 'application/pdf';
  let dataBase64 = clean(input.dataBase64 || input.base64 || input.data || '');
  if (dataBase64.includes(',')) dataBase64 = dataBase64.split(',').pop();
  const size = Number(input.size || Math.ceil((dataBase64.length || 0) * 0.75));
  if (!dataBase64) throw Object.assign(new Error('Envie o PDF em base64.'), { statusCode: 400 });
  if (mimeType !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) throw Object.assign(new Error('A documentação deve ser PDF.'), { statusCode: 400 });
  if (size > MAX_PDF_BYTES) throw Object.assign(new Error(`PDF acima do limite permitido de ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB.`), { statusCode: 413 });
  return { fileName: fileName.toLowerCase().endsWith('.pdf') ? fileName : `${fileName}.pdf`, mimeType: 'application/pdf', size, dataBase64, uploadedAt: new Date().toISOString() };
}
function normalizeSale(item = {}) {
  const currentDoc = item.documentacaoPdf || item.documentacao || null;
  return {
    id: clean(item.id) || generateId('venda'),
    produto: clean(item.produto),
    qtdVidas: clean(item.qtdVidas),
    valor: clean(item.valor || item.valorFechado || item.valorVenda),
    dataVenda: dateOnly(item.dataVenda || item.data || item.createdAt) || new Date().toISOString().slice(0, 10),
    observacao: clean(item.observacao),
    documentacaoPdf: currentDoc,
    createdAt: item.createdAt || new Date().toISOString()
  };
}
function normalizedSales(item) {
  const sales = Array.isArray(item.vendasBase) ? item.vendasBase : [];
  return sales.map(normalizeSale).filter((sale) => sale.produto || sale.valor || sale.qtdVidas || sale.documentacaoPdf);
}
function publicSale(sale) {
  const normalized = normalizeSale(sale);
  return { ...normalized, documentacaoPdf: publicDocument(normalized.documentacaoPdf) };
}
function publicCustomer(item) {
  const status = effectiveStatus(item);
  const renewal = nextRenewalDate(item);
  const vendasBase = normalizedSales(item).map(publicSale);
  return {
    id: item.id,
    sourceLeadId: item.sourceLeadId || '',
    nome: item.nome || '', telefone: item.telefone || '', email: item.email || '',
    documento: item.documento || item.cpfCnpj || '', cpfCnpj: item.cpfCnpj || item.documento || '', cidade: item.cidade || '',
    produto: item.produto || '', qtdVidas: item.qtdVidas || '', valorFechado: item.valorFechado || '',
    status, statusBase: normalizeStatus(item.status || 'ativo'), statusLabel: STATUS_LABELS[status] || status,
    dataContratacao: item.dataContratacao || '', dataRenovacao: item.dataRenovacao || (renewal ? renewal.toISOString().slice(0, 10) : ''),
    diasParaRenovar: renewal ? daysBetween(todayZero(), renewal) : null,
    observacao: item.observacao || '', posVenda: item.posVenda || null,
    documentacaoPdf: publicDocument(item.documentacaoPdf),
    vendasBase,
    valorVendasBase: normalizedSales(item).reduce((sum, sale) => sum + moneyNumber(sale.valor), 0),
    totalVendasBase: normalizedSales(item).length,
    createdAt: item.createdAt || null, updatedAt: item.updatedAt || null
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
  if (period === 'yesterday') { const from = new Date(today); from.setDate(from.getDate() - 1); const to = new Date(today); to.setMilliseconds(-1); return date >= from && date <= to; }
  if (['7', '15', '30', '90', '365'].includes(period)) { const from = new Date(today); from.setDate(from.getDate() - Number(period)); return date >= from; }
  if (period === 'custom') { const from = fromRaw ? new Date(`${fromRaw}T00:00:00`) : null; const to = toRaw ? new Date(`${toRaw}T23:59:59`) : null; if (from && date < from) return false; if (to && date > to) return false; }
  return true;
}
function monthKey(value) { const date = dateOnly(value); return date ? date.slice(0, 7) : 'Sem data'; }
function metrics(items) {
  const totalVidas = items.reduce((sum, item) => sum + Number(item.qtdVidas || 0), 0);
  const faturamentoTotal = items.reduce((sum, item) => sum + moneyNumber(item.valorFechado), 0);
  const vendasBaseValor = items.reduce((sum, item) => sum + Number(item.valorVendasBase || 0), 0);
  const vendasBaseQtd = items.reduce((sum, item) => sum + Number(item.totalVendasBase || 0), 0);
  const produtos = {}; const porMes = {}; const vendasBaseMes = {};
  items.forEach((item) => {
    const produto = clean(item.produto) || 'Não informado';
    produtos[produto] = (produtos[produto] || 0) + 1;
    const key = monthKey(item.dataContratacao || item.createdAt || item.updatedAt);
    porMes[key] = (porMes[key] || 0) + moneyNumber(item.valorFechado);
    normalizedSales(item).forEach((sale) => {
      const saleProduto = clean(sale.produto) || 'Não informado';
      produtos[saleProduto] = (produtos[saleProduto] || 0) + 1;
      const saleKey = monthKey(sale.dataVenda || sale.createdAt);
      vendasBaseMes[saleKey] = (vendasBaseMes[saleKey] || 0) + moneyNumber(sale.valor);
    });
  });
  return { totalClientes: items.length, totalVidas, faturamentoTotal, aRenovar: items.filter((item) => item.status === 'a_renovar').length, vendasBaseValor, vendasBaseQtd, produtos: Object.entries(produtos).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value), faturamentoMensal: Object.entries(porMes).map(([label, value]) => ({ label, value })).sort((a, b) => a.label.localeCompare(b.label)), vendasBaseMensal: Object.entries(vendasBaseMes).map(([label, value]) => ({ label, value })).sort((a, b) => a.label.localeCompare(b.label)) };
}
function buildCustomer(body, client, current = {}) {
  const now = new Date().toISOString();
  const nome = clean(body.nome !== undefined ? body.nome : current.nome);
  const telefone = normalizePhone(body.telefone !== undefined ? body.telefone : current.telefone);
  if (!nome || nome.length < 2) throw Object.assign(new Error('Informe o nome do cliente.'), { statusCode: 400 });
  if (!telefone || telefone.length < 8) throw Object.assign(new Error('Informe um WhatsApp válido.'), { statusCode: 400 });
  const incomingSales = Array.isArray(body.vendasBase) ? body.vendasBase.map(normalizeSale) : normalizedSales(current);
  const docInput = body.documentacaoPdf || body.documentacao || null;
  return {
    ...current,
    id: current.id || generateId('cliente'), instanceName: client.instanceName,
    sourceLeadId: clean(body.sourceLeadId !== undefined ? body.sourceLeadId : current.sourceLeadId),
    nome, telefone,
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
    documentacaoPdf: docInput ? normalizeDocument(docInput) : (current.documentacaoPdf || null),
    vendasBase: incomingSales,
    createdAt: current.createdAt || now, updatedAt: now
  };
}
function requireUser(req, body = null) {
  const client = findClientByToken(tokenFromRequest(req, body));
  if (!client) throw Object.assign(new Error('Token inválido ou inativo.'), { statusCode: 403 });
  return client;
}
function customerFromLead(lead, client) {
  const date = dateOnly(lead.updatedAt || lead.lastMessageAt || lead.createdAt) || new Date().toISOString().slice(0, 10);
  return buildCustomer({
    sourceLeadId: lead.id,
    nome: clean(lead.nome), telefone: normalizePhone(lead.telefone || ''), email: clean(lead.email || ''),
    documento: clean(lead.cnpjOuPf || lead.cnpj || lead.cpf || ''), cpfCnpj: clean(lead.cnpjOuPf || lead.cnpj || lead.cpf || ''),
    cidade: clean(lead.cidade || ''), produto: clean(lead.planoInteresse || lead.planoAtual || ''), qtdVidas: clean(lead.qtdVidas || lead.quantidadeVidas || ''),
    valorFechado: clean(lead.valorNegocio || lead.valor || ''), status: 'ativo', dataContratacao: date,
    observacao: clean(lead.observacao || lead.lastMessage || '')
  }, client, {});
}
function syncClosedLeadsIntoCustomers(client) {
  const customers = loadArray(CUSTOMER_CLIENTS_FILE);
  const leads = loadArray(LEADS_FILE).filter((lead) => clean(lead.instanceName) === clean(client.instanceName));
  let created = 0; let updated = 0; let skipped = 0;
  leads.forEach((lead) => {
    if (normalizeLeadStatus(lead.status) !== 'fechamento' && !CLOSED_LEAD_STATUSES.has(slug(lead.status))) return;
    if (!isUsableLead(lead)) { skipped += 1; return; }
    const incoming = customerFromLead(lead, client);
    const phone = normalizePhone(incoming.telefone || '');
    const index = customers.findIndex((item) => clean(item.instanceName) === clean(client.instanceName) && ((lead.id && clean(item.sourceLeadId) === clean(lead.id)) || (phone && normalizePhone(item.telefone || '') === phone)));
    if (index >= 0) {
      customers[index] = buildCustomer({
        sourceLeadId: customers[index].sourceLeadId || lead.id,
        nome: customers[index].nome || incoming.nome,
        telefone: customers[index].telefone || incoming.telefone,
        email: customers[index].email || incoming.email,
        documento: customers[index].documento || incoming.documento,
        cpfCnpj: customers[index].cpfCnpj || incoming.cpfCnpj,
        cidade: customers[index].cidade || incoming.cidade,
        produto: customers[index].produto || incoming.produto,
        qtdVidas: customers[index].qtdVidas || incoming.qtdVidas,
        valorFechado: customers[index].valorFechado || incoming.valorFechado,
        status: customers[index].status || 'ativo',
        dataContratacao: customers[index].dataContratacao || incoming.dataContratacao,
        observacao: customers[index].observacao || incoming.observacao
      }, client, customers[index]);
      updated += 1;
    } else {
      customers.push(incoming); created += 1;
    }
  });
  saveArray(CUSTOMER_CLIENTS_FILE, customers);
  return { created, updated, skipped, totalCustomers: customers.filter((item) => clean(item.instanceName) === clean(client.instanceName)).length };
}
function listCustomers(req, res) {
  try {
    const client = requireUser(req);
    let sync = null;
    if (['1', 'true', 'sim', 'yes'].includes(clean(req.query.syncFechamentos || req.query.syncClosed).toLowerCase())) sync = syncClosedLeadsIntoCustomers(client);
    const q = clean(req.query.q || req.query.search || '').toLowerCase(); const status = clean(req.query.status || ''); const period = clean(req.query.period || 'all'); const from = clean(req.query.from || ''); const to = clean(req.query.to || '');
    let items = loadArray(CUSTOMER_CLIENTS_FILE).filter((item) => clean(item.instanceName) === clean(client.instanceName)).map(publicCustomer);
    if (status) items = items.filter((item) => item.status === normalizeStatus(status));
    if (period) items = items.filter((item) => periodFilter(item, period, from, to));
    if (q) items = items.filter((item) => searchText(item).includes(q));
    items.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    return send(res, 200, { ok: true, client: publicClient(client), clientes: items, metrics: metrics(items), statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })), sync, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao listar clientes.', version: VERSION }); }
}
async function syncClosedLeadsRoute(req, res) {
  try { const body = await readBody(req); const client = requireUser(req, body); const sync = syncClosedLeadsIntoCustomers(client); return send(res, 200, { ok: true, sync, version: VERSION }); }
  catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao atualizar fechamentos.', version: VERSION }); }
}
async function createOrUpdateCustomer(req, res, existingId = '') {
  try {
    const body = await readBody(req); const client = requireUser(req, body); const id = clean(existingId || req.params?.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE); const index = id ? items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName)) : -1;
    if (id && index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const customer = buildCustomer(body, client, index >= 0 ? items[index] : {});
    if (index >= 0) items[index] = customer; else items.push(customer);
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, index >= 0 ? 200 : 201, { ok: true, cliente: publicCustomer(customer), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao salvar cliente.', version: VERSION }); }
}
async function importCustomers(req, res) {
  try {
    const body = await readBody(req); const client = requireUser(req, body); const incoming = Array.isArray(body.clientes) ? body.clientes : [];
    if (!incoming.length) return send(res, 400, { ok: false, error: 'Envie uma lista de clientes para importar.', version: VERSION });
    const items = loadArray(CUSTOMER_CLIENTS_FILE); let created = 0; let updated = 0; const errors = [];
    incoming.slice(0, 1000).forEach((row, idx) => {
      try {
        const phone = normalizePhone(row.telefone || row.whatsapp || row.celular || '');
        const index = phone ? items.findIndex((item) => clean(item.instanceName) === clean(client.instanceName) && normalizePhone(item.telefone || '') === phone) : -1;
        const customer = buildCustomer({ ...row, telefone: phone, status: row.status || 'ativo' }, client, index >= 0 ? items[index] : {});
        if (index >= 0) { items[index] = customer; updated += 1; } else { items.push(customer); created += 1; }
      } catch (error) { errors.push({ row: idx + 2, error: error.message }); }
    });
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, created, updated, errors, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao importar clientes.', version: VERSION }); }
}
async function addBaseSale(req, res) {
  try {
    const body = await readBody(req); const client = requireUser(req, body); const id = clean(req.params?.id || body.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE); const index = items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName));
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const sale = normalizeSale({ ...body, documentacaoPdf: body.documentacaoPdf || body.documentacao || null });
    if (!sale.produto && !sale.valor) throw Object.assign(new Error('Informe pelo menos produto ou valor da nova venda.'), { statusCode: 400 });
    if (body.documentacaoPdf || body.documentacao) sale.documentacaoPdf = normalizeDocument(body.documentacaoPdf || body.documentacao);
    const current = items[index]; current.vendasBase = [...normalizedSales(current), sale]; current.updatedAt = new Date().toISOString();
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, venda: publicSale(sale), cliente: publicCustomer(current), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao registrar venda da base.', version: VERSION }); }
}
async function updateCustomerDoc(req, res) {
  try {
    const body = await readBody(req); const client = requireUser(req, body); const id = clean(req.params?.id || ''); const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName)); if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    items[index].documentacaoPdf = normalizeDocument(body.documentacaoPdf || body.documentacao || body); items[index].updatedAt = new Date().toISOString(); saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, documentacaoPdf: publicDocument(items[index].documentacaoPdf), cliente: publicCustomer(items[index]), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao salvar documentação.', version: VERSION }); }
}
function downloadCustomerDoc(req, res) {
  try {
    const client = requireUser(req); const id = clean(req.params?.id || ''); const item = loadArray(CUSTOMER_CLIENTS_FILE).find((row) => row.id === id && clean(row.instanceName) === clean(client.instanceName));
    if (!item || !item.documentacaoPdf?.dataBase64) throw Object.assign(new Error('Documentação não encontrada.'), { statusCode: 404 });
    return send(res, 200, { ok: true, documentacaoPdf: item.documentacaoPdf, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao baixar documentação.', version: VERSION }); }
}
async function updateBaseSaleDoc(req, res) {
  try {
    const body = await readBody(req); const client = requireUser(req, body); const id = clean(req.params?.id || ''); const saleId = clean(req.params?.saleId || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE); const index = items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName)); if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    const sales = normalizedSales(items[index]); const saleIndex = sales.findIndex((sale) => sale.id === saleId); if (saleIndex < 0) throw Object.assign(new Error('Venda não encontrada.'), { statusCode: 404 });
    sales[saleIndex].documentacaoPdf = normalizeDocument(body.documentacaoPdf || body.documentacao || body); items[index].vendasBase = sales; items[index].updatedAt = new Date().toISOString(); saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, venda: publicSale(sales[saleIndex]), cliente: publicCustomer(items[index]), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao salvar documentação da venda.', version: VERSION }); }
}
function downloadBaseSaleDoc(req, res) {
  try {
    const client = requireUser(req); const id = clean(req.params?.id || ''); const saleId = clean(req.params?.saleId || ''); const item = loadArray(CUSTOMER_CLIENTS_FILE).find((row) => row.id === id && clean(row.instanceName) === clean(client.instanceName));
    const sale = normalizedSales(item || {}).find((row) => row.id === saleId); if (!sale?.documentacaoPdf?.dataBase64) throw Object.assign(new Error('Documentação da venda não encontrada.'), { statusCode: 404 });
    return send(res, 200, { ok: true, documentacaoPdf: sale.documentacaoPdf, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao baixar documentação da venda.', version: VERSION }); }
}
async function updatePostSale(req, res) {
  try {
    const body = await readBody(req); const client = requireUser(req, body); const id = clean(req.params?.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE); const index = items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName));
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    items[index].posVenda = { tipo: clean(body.tipo || 'relacionamento'), data: dateOnly(body.data || ''), recorrencia: clean(body.recorrencia || 'unica'), hora: clean(body.hora || body.hour || '09:00'), mensagem: clean(body.mensagem || ''), ativo: body.ativo !== false, updatedAt: new Date().toISOString() };
    items[index].updatedAt = new Date().toISOString(); saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, cliente: publicCustomer(items[index]), version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao salvar pós-venda.', version: VERSION }); }
}
function deleteCustomer(req, res) {
  try {
    const client = requireUser(req); const id = clean(req.params?.id || ''); const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const filtered = items.filter((item) => !(item.id === id && clean(item.instanceName) === clean(client.instanceName)));
    if (filtered.length === items.length) return send(res, 404, { ok: false, error: 'Cliente não encontrado.', version: VERSION });
    saveArray(CUSTOMER_CLIENTS_FILE, filtered); return send(res, 200, { ok: true, removed: true, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao excluir cliente.', version: VERSION }); }
}
function register(app) {
  if (registered) return; registered = true;
  app.options('/api/clientes', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/import', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/sync-fechamentos', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/post-sale', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/base-sale', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/documentacao', (req, res) => send(res, 204, {}));
  app.options('/api/clientes/:id/base-sale/:saleId/documentacao', (req, res) => send(res, 204, {}));
  app.get('/api/clientes/health', (req, res) => send(res, 200, { ok: true, module: 'clientes', version: VERSION, clientsFile: CLIENTS_FILE, customerClientsFile: CUSTOMER_CLIENTS_FILE, leadsFile: LEADS_FILE, renewalAlertDays: RENEWAL_ALERT_DAYS, maxPdfMb: Math.round(MAX_PDF_BYTES / 1024 / 1024), statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })), features: ['vendasBase', 'importacaoClientes', 'filtroPeriodosAvancado', 'documentacaoPdf', 'syncFechamentos'], time: new Date().toISOString() }));
  app.get('/api/clientes', listCustomers);
  app.post('/api/clientes', (req, res) => createOrUpdateCustomer(req, res));
  app.post('/api/clientes/import', importCustomers);
  app.post('/api/clientes/sync-fechamentos', syncClosedLeadsRoute);
  app.put('/api/clientes/:id', (req, res) => createOrUpdateCustomer(req, res, req.params.id));
  app.patch('/api/clientes/:id', (req, res) => createOrUpdateCustomer(req, res, req.params.id));
  app.post('/api/clientes/:id/post-sale', updatePostSale);
  app.post('/api/clientes/:id/base-sale', addBaseSale);
  app.post('/api/clientes/:id/documentacao', updateCustomerDoc);
  app.get('/api/clientes/:id/documentacao', downloadCustomerDoc);
  app.post('/api/clientes/:id/base-sale/:saleId/documentacao', updateBaseSaleDoc);
  app.get('/api/clientes/:id/base-sale/:saleId/documentacao', downloadBaseSaleDoc);
  app.delete('/api/clientes/:id', deleteCustomer);
}
function patchExpress() {
  const patchedExpress = function patchedExpress(...args) { const app = realExpress(...args); register(app); return app; };
  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}
patchExpress();
module.exports = { register };
