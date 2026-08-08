// Scheduled follow-up sender for Lungo Corretores.
// Handles authorized one-to-one WhatsApp follow-ups for Leads and Clientes.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
let workerStarted = false;
const VERSION = '1.0.0-scheduled-followups';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const CUSTOMER_CLIENTS_FILE = process.env.CUSTOMER_CLIENTS_FILE_PATH || path.join(path.dirname(CLIENTS_FILE), 'customer_clients.json');
const INTERVAL_MS = Math.max(Number(process.env.SCHEDULED_FOLLOWUPS_INTERVAL_MS || 60000), 30000);
const MAX_PER_TICK = Math.max(Number(process.env.SCHEDULED_FOLLOWUPS_MAX_PER_TICK || 20), 1);

function clean(value) { return String(value || '').trim(); }
function cleanToken(value) { return clean(value).toUpperCase().replace(/\s+/g, ''); }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-client-token');
}
function send(res, status, payload) { setCors(res); return res.status(status).json(payload); }
function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try { const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
function saveArray(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}
function normalizePhone(value) {
  let digits = clean(value).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  return digits;
}
function tokenFromRequest(req, body = null) {
  const auth = req.headers.authorization || '';
  if (body?.token) return String(body.token);
  if (req.query?.token) return String(req.query.token);
  if (req.headers['x-client-token']) return String(req.headers['x-client-token']);
  if (String(auth).toLowerCase().startsWith('bearer ')) return String(auth).slice(7);
  return '';
}
function findClientByToken(token) {
  const wanted = cleanToken(token);
  if (!wanted) return null;
  return loadArray(CLIENTS_FILE).find((item) => cleanToken(item.token) === wanted && item.ativo !== false) || null;
}
function requireClient(req, body = null) {
  const client = findClientByToken(tokenFromRequest(req, body));
  if (!client) throw Object.assign(new Error('Token inválido ou inativo.'), { statusCode: 403 });
  return client;
}
function publicClient(client) {
  return { nome: client.nome || client.instanceName, instanceName: client.instanceName, ativo: client.ativo !== false, whatsapp: client.whatsapp || '' };
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
function dateOnly(value) {
  const raw = clean(value);
  if (!raw) return '';
  const date = new Date(raw.length === 10 ? `${raw}T00:00:00` : raw);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
function normalizeTime(value) {
  const raw = clean(value || '09:00');
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '09:00';
  const h = Math.min(Math.max(Number(match[1]), 0), 23);
  const m = Math.min(Math.max(Number(match[2]), 0), 59);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function buildSchedule(body, current = {}) {
  const data = dateOnly(body.data || body.date || current.data || '');
  const hora = normalizeTime(body.hora || body.hour || current.hora || '09:00');
  const mensagem = clean(body.mensagem || body.message || current.mensagem || '');
  if (!data) throw Object.assign(new Error('Informe a data da programação.'), { statusCode: 400 });
  if (!hora) throw Object.assign(new Error('Informe a hora da programação.'), { statusCode: 400 });
  if (!mensagem) throw Object.assign(new Error('Informe a mensagem programada.'), { statusCode: 400 });
  const now = new Date().toISOString();
  return {
    ...current,
    tipo: clean(body.tipo || body.type || current.tipo || 'retorno'),
    data,
    hora,
    recorrencia: clean(body.recorrencia || body.recurrence || current.recorrencia || 'unica'),
    mensagem,
    ativo: body.ativo !== false,
    status: 'scheduled',
    createdAt: current.createdAt || now,
    updatedAt: now
  };
}
function scheduleDate(schedule) {
  if (!schedule?.data) return null;
  const date = new Date(`${schedule.data}T${normalizeTime(schedule.hora || '09:00')}:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}
function isRecurring(recorrencia) {
  const value = clean(recorrencia).toLowerCase();
  return value && !['unica', 'única', 'uma_vez', 'once'].includes(value);
}
function advanceSchedule(schedule) {
  const date = scheduleDate(schedule) || new Date();
  const value = clean(schedule.recorrencia).toLowerCase();
  if (value.includes('15')) date.setDate(date.getDate() + 15);
  else if (value.includes('trimes')) date.setMonth(date.getMonth() + 3);
  else if (value.includes('anual') || value.includes('ano')) date.setFullYear(date.getFullYear() + 1);
  else date.setMonth(date.getMonth() + 1);
  schedule.data = date.toISOString().slice(0, 10);
  schedule.status = 'scheduled';
  schedule.updatedAt = new Date().toISOString();
}
function evolutionBaseUrl() { return clean(process.env.EVOLUTION_BASE_URL).replace(/\/+$/, ''); }
function evolutionHeaders() { return { apikey: process.env.EVOLUTION_API_KEY || '', 'Content-Type': 'application/json' }; }
function buildEvolutionUrl(template, instanceName) {
  const base = evolutionBaseUrl();
  const encoded = encodeURIComponent(instanceName || '');
  const endpoint = clean(template || '/message/sendText/:instanceName')
    .replace(':instanceName', encoded)
    .replace('{instanceName}', encoded)
    .replace(':instance', encoded)
    .replace('{instance}', encoded);
  return `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}
function renderMessage(template, item) {
  return clean(template)
    .replace(/\{nome\}/gi, clean(item.nome || ''))
    .replace(/\{telefone\}/gi, clean(item.telefone || ''));
}
async function sendWhatsapp(instanceName, phone, text) {
  if (!evolutionBaseUrl() || !process.env.EVOLUTION_API_KEY) throw new Error('Evolution não configurada para mensagens programadas.');
  const number = normalizePhone(phone);
  if (!number || number.length < 10) throw new Error('Telefone inválido para mensagem programada.');
  const url = buildEvolutionUrl(process.env.EVOLUTION_SEND_TEXT_PATH || '/message/sendText/:instanceName', instanceName);
  const payload = { number, text: clean(text) };
  const response = await axios.post(url, payload, { headers: evolutionHeaders(), timeout: 30000, validateStatus: () => true });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error('Evolution recusou a mensagem programada.');
    error.details = response.data;
    error.statusCode = response.status;
    throw error;
  }
  return { status: response.status, data: response.data };
}
function markSuccess(schedule) {
  const now = new Date().toISOString();
  schedule.lastSentAt = now;
  schedule.lastError = '';
  if (isRecurring(schedule.recorrencia)) advanceSchedule(schedule);
  else { schedule.ativo = false; schedule.status = 'sent'; schedule.deliveredAt = now; }
  schedule.updatedAt = now;
}
function markError(schedule, error) {
  schedule.status = 'error';
  schedule.lastError = error.message || 'Erro no envio.';
  schedule.lastErrorAt = new Date().toISOString();
  schedule.updatedAt = schedule.lastErrorAt;
}
async function processLeadSchedules(limit) {
  const leads = loadArray(LEADS_FILE);
  let changed = false;
  let sent = 0;
  const now = new Date();
  for (const lead of leads) {
    if (sent >= limit) break;
    const schedule = lead.mensagemProgramada;
    const when = scheduleDate(schedule);
    if (!schedule || schedule.ativo === false || !when || when > now || !schedule.mensagem) continue;
    try {
      await sendWhatsapp(lead.instanceName, lead.telefone, renderMessage(schedule.mensagem, lead));
      markSuccess(schedule); sent += 1; changed = true;
    } catch (error) {
      markError(schedule, error); changed = true;
    }
  }
  if (changed) saveArray(LEADS_FILE, leads);
  return sent;
}
async function processClientSchedules(limit) {
  const clients = loadArray(CUSTOMER_CLIENTS_FILE);
  let changed = false;
  let sent = 0;
  const now = new Date();
  for (const item of clients) {
    if (sent >= limit) break;
    const schedule = item.posVenda;
    const when = scheduleDate(schedule);
    if (!schedule || schedule.ativo === false || !when || when > now || !schedule.mensagem) continue;
    try {
      await sendWhatsapp(item.instanceName, item.telefone, renderMessage(schedule.mensagem, item));
      markSuccess(schedule); sent += 1; changed = true;
    } catch (error) {
      markError(schedule, error); changed = true;
    }
  }
  if (changed) saveArray(CUSTOMER_CLIENTS_FILE, clients);
  return sent;
}
async function processDueSchedules() {
  if (String(process.env.SCHEDULED_FOLLOWUPS_DISABLED || '').toLowerCase() === 'true') return;
  try {
    const leadSent = await processLeadSchedules(MAX_PER_TICK);
    await processClientSchedules(Math.max(MAX_PER_TICK - leadSent, 1));
  } catch (error) {
    console.error('[SCHEDULED FOLLOWUPS]', error.message || error);
  }
}
function startWorker() {
  if (workerStarted) return;
  workerStarted = true;
  setTimeout(processDueSchedules, 15000).unref?.();
  setInterval(processDueSchedules, INTERVAL_MS).unref?.();
}
async function scheduleLeadRoute(req, res) {
  try {
    const body = await readBody(req);
    const client = requireClient(req, body);
    const id = clean(req.params?.id || '');
    const leads = loadArray(LEADS_FILE);
    const index = leads.findIndex((lead) => lead.id === id && clean(lead.instanceName) === clean(client.instanceName));
    if (index < 0) throw Object.assign(new Error('Lead não encontrado.'), { statusCode: 404 });
    leads[index].mensagemProgramada = buildSchedule(body, leads[index].mensagemProgramada || {});
    leads[index].proximoRetorno = leads[index].mensagemProgramada.data;
    leads[index].updatedAt = new Date().toISOString();
    saveArray(LEADS_FILE, leads);
    return send(res, 200, { ok: true, client: publicClient(client), leadId: id, mensagemProgramada: leads[index].mensagemProgramada, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao programar mensagem.', version: VERSION }); }
}
function cancelLeadScheduleRoute(req, res) {
  try {
    const client = requireClient(req);
    const id = clean(req.params?.id || '');
    const leads = loadArray(LEADS_FILE);
    const index = leads.findIndex((lead) => lead.id === id && clean(lead.instanceName) === clean(client.instanceName));
    if (index < 0) throw Object.assign(new Error('Lead não encontrado.'), { statusCode: 404 });
    if (leads[index].mensagemProgramada) {
      leads[index].mensagemProgramada.ativo = false;
      leads[index].mensagemProgramada.status = 'cancelled';
      leads[index].mensagemProgramada.updatedAt = new Date().toISOString();
      leads[index].updatedAt = leads[index].mensagemProgramada.updatedAt;
      saveArray(LEADS_FILE, leads);
    }
    return send(res, 200, { ok: true, cancelled: true, leadId: id, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao cancelar programação.', version: VERSION }); }
}
async function scheduleClientRoute(req, res) {
  try {
    const body = await readBody(req);
    const client = requireClient(req, body);
    const id = clean(req.params?.id || '');
    const items = loadArray(CUSTOMER_CLIENTS_FILE);
    const index = items.findIndex((item) => item.id === id && clean(item.instanceName) === clean(client.instanceName));
    if (index < 0) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });
    items[index].posVenda = buildSchedule(body, items[index].posVenda || {});
    items[index].updatedAt = new Date().toISOString();
    saveArray(CUSTOMER_CLIENTS_FILE, items);
    return send(res, 200, { ok: true, client: publicClient(client), clienteId: id, posVenda: items[index].posVenda, version: VERSION });
  } catch (error) { return send(res, error.statusCode || 500, { ok: false, error: error.message || 'Erro ao programar pós-venda.', version: VERSION }); }
}
function register(app) {
  if (registered) return;
  registered = true;
  app.options('/api/scheduled/leads/:id', (req, res) => send(res, 204, {}));
  app.options('/api/scheduled/clientes/:id', (req, res) => send(res, 204, {}));
  app.options('/api/scheduled/health', (req, res) => send(res, 204, {}));
  app.get('/api/scheduled/health', (req, res) => send(res, 200, { ok: true, module: 'scheduled-followups', version: VERSION, intervalMs: INTERVAL_MS, maxPerTick: MAX_PER_TICK, disabled: String(process.env.SCHEDULED_FOLLOWUPS_DISABLED || '').toLowerCase() === 'true', time: new Date().toISOString() }));
  app.post('/api/scheduled/leads/:id', scheduleLeadRoute);
  app.delete('/api/scheduled/leads/:id', cancelLeadScheduleRoute);
  app.post('/api/scheduled/clientes/:id', scheduleClientRoute);
}
function patchExpress() {
  const patchedExpress = function patchedExpress(...args) { const app = realExpress(...args); register(app); return app; };
  Object.keys(realExpress).forEach((key) => { patchedExpress[key] = realExpress[key]; });
  require.cache[require.resolve('express')].exports = patchedExpress;
}
patchExpress();
startWorker();
module.exports = { register };
