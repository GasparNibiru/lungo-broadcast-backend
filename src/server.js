const express = require('express');
const cors = require('cors');
const multer = require('multer');
const XLSX = require('xlsx');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

const databaseHealthRouter = require('./routes/database-health');
const adminSubscriptionsRouter = require('./routes/admin-subscriptions');
const adminAuthRouter = require('./routes/admin-auth');
const adminOrganizationsRouter = require('./routes/admin-organizations');
const adminDashboardRouter = require('./routes/admin-dashboard');
const adminFinancialRouter = require('./routes/admin-financial');
const adminSupervisorsRouter = require('./routes/admin-supervisors');
const adminAccessesRouter = require('./routes/admin-accesses');
const adminPaymentsRouter = require('./routes/admin-payments');
const supervisorRouter = require('./routes/supervisor');
const trainingsRouter = require('./routes/trainings');

const app = express();
const PORT = Number(process.env.PORT || 80);
const VERSION = '1.3.0';
const ROOT = path.resolve(__dirname, '..');
const UPLOAD_DIR = path.join(ROOT, 'storage', 'uploads');
const INSTANCES_FILE = path.join(ROOT, 'data', 'instances.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey, x-api-key, x-admin-key, x-access-token');
  res.header('Access-Control-Allow-Credentials', 'false');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(databaseHealthRouter);
app.use(adminSubscriptionsRouter);
app.use(adminAuthRouter);
app.use(adminOrganizationsRouter);
app.use(adminDashboardRouter);
app.use(adminFinancialRouter);
app.use(adminSupervisorsRouter);
app.use(adminAccessesRouter);
app.use(adminPaymentsRouter);
app.use(supervisorRouter);
app.use(trainingsRouter);

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, UPLOAD_DIR);
    },
    filename(req, file, cb) {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    }
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 10) * 1024 * 1024 }
});

const campaigns = new Map();

function appError(message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cleanInstanceName(value) {
  return String(value || '').trim();
}

function loadInstances() {
  if (!fs.existsSync(INSTANCES_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function allowDynamicInstances() {
  return String(process.env.ALLOW_DYNAMIC_INSTANCES || 'true').toLowerCase() === 'true';
}

function resolveInstance(userId) {
  const id = cleanInstanceName(userId);
  if (!id) return null;

  if (allowDynamicInstances()) {
    return {
      userId: id,
      instanceName: id,
      clientName: id,
      enabled: true,
      maxContactsPerCampaign: Number(process.env.DEFAULT_MAX_CONTACTS_PER_CAMPAIGN || 5000),
      minDelayMs: Number(process.env.DEFAULT_MIN_DELAY_MS || 8000),
      maxDelayMs: Number(process.env.DEFAULT_MAX_DELAY_MS || 25000)
    };
  }

  return loadInstances().find((item) =>
    String(item.userId || '').trim().toLowerCase() === id.toLowerCase() && item.enabled === true
  );
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
  const encoded = encodeURIComponent(instanceName);
  const endpoint = String(template || '')
    .replace(':instanceName', encoded)
    .replace('{instanceName}', encoded)
    .replace(':instance', encoded)
    .replace('{instance}', encoded);
  return `${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

function checkEvolutionConfig() {
  if (!evolutionBaseUrl()) throw appError('EVOLUTION_BASE_URL não configurado.', 500);
  if (!process.env.EVOLUTION_API_KEY) throw appError('EVOLUTION_API_KEY não configurado.', 500);
}

async function getConnectionState(instanceName) {
  checkEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_CONNECTION_PATH || '/instance/connectionState/:instanceName', instanceName);
  const response = await axios.get(url, { headers: evolutionHeaders(), timeout: 20000 });
  const body = response.data || {};
  return body?.instance?.state || body?.state || body?.connectionState || 'unknown';
}

async function ensureInstanceConnected(instanceName) {
  if (String(process.env.SKIP_CONNECTION_CHECK || '').toLowerCase() === 'true') return 'skipped';
  const state = await getConnectionState(instanceName);
  const connected = ['open', 'connected', 'online'].includes(String(state).toLowerCase());
  if (!connected) throw appError(`A instância não está conectada. Estado atual: ${state}.`, 409);
  return state;
}

async function sendText(instanceName, number, text) {
  checkEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_SEND_TEXT_PATH || '/message/sendText/:instanceName', instanceName);

  // Evolution API neste servidor exige a propriedade raiz "text".
  const payload = {
    number: String(number),
    text: String(text),
    delay: Number(process.env.EVOLUTION_MESSAGE_DELAY_MS || 0),
    linkPreview: false
  };

  const response = await axios.post(url, payload, { headers: evolutionHeaders(), timeout: 30000 });
  return response.data;
}

function cellToPlainText(value) {
  if (value === null || value === undefined) return '';

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }

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
  let text = cellToPlainText(value);
  let digits = text.replace(/\D/g, '');

  if (digits.startsWith('00')) digits = digits.slice(2);

  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    digits = `55${digits}`;
  }

  return digits;
}

function isValidPhone(phone) {
  return /^\d{10,15}$/.test(phone);
}

function getCell(sheet, rowIndex, colIndex) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
  return sheet[address] || null;
}

function getCellValue(sheet, rowIndex, colIndex) {
  const cell = getCell(sheet, rowIndex, colIndex);
  if (!cell) return '';
  if (cell.v !== undefined && cell.v !== null && cell.v !== '') return cell.v;
  if (cell.w !== undefined && cell.w !== null) return cell.w;
  return '';
}

function getHeaders(sheet, range) {
  const headers = [];
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const header = cellToPlainText(getCellValue(sheet, range.s.r, col));
    headers[col] = header || `col_${col + 1}`;
  }
  return headers;
}

function findPhoneColumn(headers, range) {
  const aliases = ['telefone', 'whatsapp', 'celular', 'fone', 'numero', 'número', 'phone', 'contato'];

  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const key = normalizeKey(headers[col]);
    if (aliases.some((alias) => key.includes(normalizeKey(alias)))) return col;
  }

  if (range.e.c >= 1) return 1;
  return range.s.c;
}

function parseContacts(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  if (!sheet || !sheet['!ref']) {
    return {
      contacts: [],
      rejected: [],
      headers: [],
      phoneColumn: null,
      stats: { total: 0, valid: 0, duplicate: 0, invalid: 0 }
    };
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headers = getHeaders(sheet, range);
  const phoneColumnIndex = findPhoneColumn(headers, range);
  const phoneColumn = headers[phoneColumnIndex] || `col_${phoneColumnIndex + 1}`;
  const seen = new Set();
  const contacts = [];
  const rejected = [];

  for (let rowIndex = range.s.r + 1; rowIndex <= range.e.r; rowIndex += 1) {
    const row = {};
    let hasRelevantData = false;

    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const key = headers[col] || `col_${col + 1}`;
      const value = getCellValue(sheet, rowIndex, col);
      const clean = cellToPlainText(value);
      row[key] = clean;
      row[normalizeKey(key)] = clean;

      if (clean && col <= Math.max(1, phoneColumnIndex)) {
        hasRelevantData = true;
      }
    }

    const rawPhone = getCellValue(sheet, rowIndex, phoneColumnIndex);
    const rawPhoneText = cellToPlainText(rawPhone);
    const number = normalizePhone(rawPhone);
    const line = rowIndex + 1;

    if (!rawPhoneText && !hasRelevantData) continue;

    if (!isValidPhone(number)) {
      rejected.push({
        line,
        reason: 'invalid_phone',
        rawPhone: rawPhoneText,
        parsedPhone: number,
        phoneColumn
      });
      continue;
    }

    if (seen.has(number)) {
      rejected.push({
        line,
        reason: 'duplicate_phone',
        rawPhone: rawPhoneText,
        parsedPhone: number,
        phoneColumn
      });
      continue;
    }

    seen.add(number);
    contacts.push({ line, number, row, status: 'pending', sentAt: null, error: null });
  }

  const total = contacts.length + rejected.length;
  return {
    contacts,
    rejected,
    headers: headers.filter(Boolean),
    phoneColumn,
    stats: {
      total,
      valid: contacts.length,
      duplicate: rejected.filter((item) => item.reason === 'duplicate_phone').length,
      invalid: rejected.filter((item) => item.reason === 'invalid_phone').length,
      phoneColumn,
      headers: headers.filter(Boolean),
      rejectedSamples: rejected.slice(0, 5)
    }
  };
}

function renderMessage(template, row, number) {
  const values = { telefone: number, whatsapp: number, numero: number };
  Object.entries(row || {}).forEach(([key, value]) => {
    const clean = cellToPlainText(value);
    values[key] = clean;
    values[normalizeKey(key)] = clean;
  });

  return String(template || '').replace(/\{([^}]+)\}/g, (match, key) => {
    const normalized = normalizeKey(key);
    return values[key] ?? values[normalized] ?? '';
  }).trim();
}

function randomDelay(min, max) {
  const minDelay = Number(min || process.env.DEFAULT_MIN_DELAY_MS || 8000);
  const maxDelay = Number(max || process.env.DEFAULT_MAX_DELAY_MS || 25000);
  if (maxDelay <= minDelay) return minDelay;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

function addActivity(campaign, message, level = 'info') {
  campaign.activity.push({ at: new Date().toISOString(), level, message });
}

function publicCampaign(campaign) {
  return {
    id: campaign.id,
    userId: campaign.userId,
    clientName: campaign.clientName,
    status: campaign.status,
    createdAt: campaign.createdAt,
    startedAt: campaign.startedAt,
    finishedAt: campaign.finishedAt,
    stoppedAt: campaign.stoppedAt,
    stats: campaign.stats,
    progress: campaign.progress,
    activity: campaign.activity.slice(-50).reverse()
  };
}

async function processNext(campaign) {
  if (campaign.status !== 'running') return;

  const contact = campaign.contacts.find((item) => item.status === 'pending');
  if (!contact) {
    campaign.status = 'completed';
    campaign.finishedAt = new Date().toISOString();
    campaign.progress.pending = 0;
    addActivity(campaign, 'Campanha concluída.');
    return;
  }

  contact.status = 'sending';

  try {
    const text = renderMessage(campaign.message, contact.row, contact.number);
    if (!text) throw new Error('Mensagem vazia após aplicar variáveis.');

    await sendText(campaign.instanceName, contact.number, text);

    contact.status = 'sent';
    contact.sentAt = new Date().toISOString();
    campaign.progress.sent += 1;
    addActivity(campaign, `Mensagem enviada para ${contact.number}.`);
  } catch (error) {
    contact.status = 'error';
    contact.error = error.response?.data || error.message || 'Erro desconhecido';
    campaign.progress.errors += 1;
    addActivity(campaign, `Erro ao enviar para ${contact.number}: ${JSON.stringify(contact.error)}`, 'error');
  }

  campaign.progress.pending = Math.max(campaign.stats.valid - campaign.progress.sent - campaign.progress.errors, 0);

  if (!campaign.contacts.some((item) => item.status === 'pending')) {
    campaign.status = 'completed';
    campaign.finishedAt = new Date().toISOString();
    addActivity(campaign, 'Campanha concluída.');
    return;
  }

  campaign.timer = setTimeout(() => processNext(campaign), randomDelay(campaign.minDelayMs, campaign.maxDelayMs));
}

app.get('/', (req, res) => {
  res.json({ ok: true, name: 'Lungo Broadcast API', version: VERSION });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'online', version: VERSION, time: new Date().toISOString() });
});

app.post('/api/instances/validate', async (req, res, next) => {
  try {
    const userId = cleanInstanceName(req.body.userId);
    if (!userId) throw appError('Informe o ID de usuário.', 400);

    const instance = resolveInstance(userId);
    if (!instance) throw appError('ID de usuário não autorizado.', 403);

    const state = await getConnectionState(instance.instanceName);
    res.json({
      ok: true,
      userId: instance.userId,
      instanceName: instance.instanceName,
      clientName: instance.clientName,
      state,
      connected: ['open', 'connected', 'online'].includes(String(state).toLowerCase())
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/campaigns/start', upload.single('file'), async (req, res, next) => {
  try {
    const userId = cleanInstanceName(req.body.userId);
    const message = String(req.body.message || '').trim();

    if (!userId) throw appError('Informe o ID de usuário.', 400);
    if (!message) throw appError('Informe a mensagem de envio.', 400);
    if (!req.file) throw appError('Envie uma planilha de contatos.', 400);

    const instance = resolveInstance(userId);
    if (!instance) throw appError('ID de usuário não autorizado.', 403);

    await ensureInstanceConnected(instance.instanceName);

    const parsed = parseContacts(req.file.path);
    if (!parsed.contacts.length) throw appError('Nenhum contato válido encontrado na planilha.', 400, parsed.stats);

    const maxContacts = Number(instance.maxContactsPerCampaign || process.env.DEFAULT_MAX_CONTACTS_PER_CAMPAIGN || 5000);
    if (parsed.contacts.length > maxContacts) {
      throw appError(`Campanha acima do limite de ${maxContacts} contatos válidos.`, 413);
    }

    const campaign = {
      id: crypto.randomUUID(),
      userId: instance.userId,
      instanceName: instance.instanceName,
      clientName: instance.clientName || instance.userId,
      status: 'running',
      message,
      contacts: parsed.contacts,
      rejected: parsed.rejected,
      stats: parsed.stats,
      progress: { sent: 0, pending: parsed.stats.valid, errors: 0 },
      activity: [],
      timer: null,
      minDelayMs: instance.minDelayMs,
      maxDelayMs: instance.maxDelayMs,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      stoppedAt: null
    };

    addActivity(campaign, `Campanha criada com ${parsed.stats.valid} contatos válidos.`);
    addActivity(campaign, 'Instância autorizada e conectada.');
    campaigns.set(campaign.id, campaign);
    processNext(campaign);

    res.status(201).json({ ok: true, campaign: publicCampaign(campaign) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/campaigns/:id/status', (req, res, next) => {
  try {
    const campaign = campaigns.get(req.params.id);
    if (!campaign) throw appError('Campanha não encontrada.', 404);
    res.json({ ok: true, campaign: publicCampaign(campaign) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/campaigns/:id/stop', (req, res, next) => {
  try {
    const campaign = campaigns.get(req.params.id);
    if (!campaign) throw appError('Campanha não encontrada.', 404);

    if (campaign.timer) clearTimeout(campaign.timer);
    campaign.status = 'stopped';
    campaign.stoppedAt = new Date().toISOString();
    campaign.progress.pending = campaign.contacts.filter((item) => item.status === 'pending').length;
    addActivity(campaign, 'Campanha interrompida pelo usuário.');

    res.json({ ok: true, campaign: publicCampaign(campaign) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/campaigns/:id/report.csv', (req, res, next) => {
  try {
    const campaign = campaigns.get(req.params.id);
    if (!campaign) throw appError('Campanha não encontrada.', 404);

    const rows = [['campaign_id', 'client_name', 'user_id', 'instance_name', 'number', 'status', 'sent_at', 'error', 'line']];
    campaign.contacts.forEach((contact) => rows.push([
      campaign.id, campaign.clientName, campaign.userId, campaign.instanceName,
      contact.number, contact.status, contact.sentAt || '', JSON.stringify(contact.error || ''), contact.line || ''
    ]));
    campaign.rejected.forEach((item) => rows.push([
      campaign.id, campaign.clientName, campaign.userId, campaign.instanceName,
      item.parsedPhone || item.rawPhone || '', item.reason, '', item.reason, item.line || ''
    ]));

    const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campanha-${campaign.id}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Rota não encontrada.' });
});

app.use((error, req, res, next) => {
  console.error('[ERROR]', error.response?.data || error.message || error);
  res.status(error.statusCode || error.response?.status || 500).json({
    ok: false,
    error: error.message || 'Erro interno no servidor.',
    details: error.details || error.response?.data || null
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lungo Broadcast API ${VERSION} online na porta ${PORT}`);
});
