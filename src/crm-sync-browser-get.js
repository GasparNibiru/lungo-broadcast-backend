// Browser-friendly MiniCRM sync route.
// Direct GET /api/crm/sync-whatsapp-label-browser for browser tests.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '1.7.5-labelid-attempts';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const DEFAULT_LABEL = process.env.CRM_WHATSAPP_LABEL || 'MiniCRM';
const DEFAULT_SYNC_LIMIT = Number(process.env.CRM_SYNC_LIMIT || 500);

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

function cleanToken(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'item';
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

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function loadJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveJsonArray(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function findClientByToken(token) {
  const clean = cleanToken(token);
  if (!clean) return null;
  return loadJsonArray(CLIENTS_FILE).find((item) => cleanToken(item.token) === clean && item.ativo !== false) || null;
}

function publicClient(client) {
  return {
    nome: client.nome || client.instanceName,
    instanceName: client.instanceName,
    ativo: client.ativo !== false,
    whatsapp: client.whatsapp || ''
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

function extractArray(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.response)) return data.response;
  if (Array.isArray(data?.chats)) return data.chats;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function findEvolutionLabels(instanceName) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_FIND_LABELS_PATH || '/label/findLabels/:instanceName', instanceName);
  const response = await axios.get(url, { headers: evolutionHeaders(), timeout: 30000 });
  return extractArray(response.data);
}

async function postFindChatsAttempt(instanceName, body, attemptName) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_FIND_CHATS_PATH || '/chat/findChats/:instanceName', instanceName);
  const response = await axios.post(url, body, {
    headers: evolutionHeaders(),
    timeout: 60000,
    validateStatus: () => true
  });

  const chats = response.status >= 200 && response.status < 300 ? extractArray(response.data) : [];
  return {
    attemptName,
    status: response.status,
    count: chats.length,
    chats,
    error: response.status >= 200 && response.status < 300 ? null : response.data
  };
}

function findTargetLabel(labels, labelName) {
  const targetSlug = slugify(labelName);
  const compactTarget = targetSlug.replace(/_/g, '');
  return labels.find((item) => {
    const names = [item?.name, item?.label, item?.title, item?.id, item?.value].map((value) => slugify(value));
    return names.some((name) => name === targetSlug || name.replace(/_/g, '') === compactTarget);
  }) || null;
}

function labelMatches(value, targetName, targetLabel) {
  if (value === null || value === undefined) return false;
  const targetSlug = slugify(targetName);
  const compactTarget = targetSlug.replace(/_/g, '');
  const targetId = String(targetLabel?.id || '').toLowerCase();

  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value || '').trim();
    const textSlug = slugify(text);
    return textSlug === targetSlug || textSlug.replace(/_/g, '') === compactTarget || (!!targetId && text.toLowerCase() === targetId);
  }

  if (Array.isArray(value)) return value.some((item) => labelMatches(item, targetName, targetLabel));

  if (typeof value === 'object') {
    const possible = [
      value.name,
      value.label,
      value.title,
      value.id,
      value.labelId,
      value.label_id,
      value.value,
      value.chatLabelId,
      value.chat_label_id
    ];
    if (possible.some((item) => labelMatches(item, targetName, targetLabel))) return true;
    if (Array.isArray(value.labels) && labelMatches(value.labels, targetName, targetLabel)) return true;
    if (Array.isArray(value.Labels) && labelMatches(value.Labels, targetName, targetLabel)) return true;
    if (Array.isArray(value.Tags) && labelMatches(value.Tags, targetName, targetLabel)) return true;
  }

  return false;
}

function chatHasLabel(chat, labelName, targetLabel) {
  if (!chat || typeof chat !== 'object') return false;
  const buckets = [
    chat.labels,
    chat.label,
    chat.Label,
    chat.Labels,
    chat.tags,
    chat.Tags,
    chat.labelId,
    chat.labelIds,
    chat.labelsId,
    chat.chatLabelId,
    chat.chatLabelIds,
    chat.whatsappLabels,
    chat.chatLabels,
    chat.metadata?.labels,
    chat.contact?.labels
  ];
  return buckets.some((bucket) => labelMatches(bucket, labelName, targetLabel));
}

function extractRemoteJid(chat) {
  return clean(chat.remoteJid || chat.jid || chat.id || chat.chatId || chat.key?.remoteJid || chat.contact?.remoteJid || chat.contact?.id || '');
}

function extractLeadName(chat, phone) {
  const name = clean(chat.name || chat.pushName || chat.verifiedName || chat.contact?.name || chat.contact?.pushName || chat.contact?.verifiedName || chat.profileName || '');
  return name || `Contato ${phone}`;
}

function buildLeadFromChat(chat, client, labelName) {
  const remoteJid = extractRemoteJid(chat);
  if (!remoteJid || remoteJid.includes('@g.us')) return null;
  const phone = normalizePhone(remoteJid.split('@')[0]);
  if (!phone || phone.length < 10) return null;

  const now = new Date().toISOString();
  const lastText = clean(chat.lastMessage?.message?.conversation || chat.lastMessage?.text || chat.lastMessage?.messageText || chat.lastMessage?.message?.extendedTextMessage?.text || chat.messages?.[0]?.message?.conversation || '');

  return {
    id: generateId('lead'),
    instanceName: client.instanceName,
    externalId: `whatsapp:${remoteJid}`,
    whatsappJid: remoteJid,
    nome: extractLeadName(chat, phone),
    telefone: phone,
    status: 'novo_lead',
    origem: `WhatsApp etiqueta ${labelName}`,
    observacao: lastText ? `Sincronizado do WhatsApp. Última mensagem: ${lastText.slice(0, 240)}` : `Sincronizado do WhatsApp pela etiqueta ${labelName}.`,
    proximoRetorno: '',
    cidade: '',
    planoAtual: '',
    valor: '',
    tags: [labelName, 'WhatsApp'],
    createdAt: now,
    updatedAt: now,
    lastWhatsappSyncAt: now
  };
}

function uniqueChats(chats) {
  const seen = new Set();
  const output = [];
  chats.forEach((chat) => {
    const key = extractRemoteJid(chat) || JSON.stringify(chat).slice(0, 120);
    if (!key || seen.has(key)) return;
    seen.add(key);
    output.push(chat);
  });
  return output;
}

function upsertLeadsFromChats(currentLeads, client, chats, labelName) {
  const instanceName = clean(client.instanceName);
  let created = 0;
  let updated = 0;
  let ignored = 0;

  uniqueChats(chats).forEach((chat) => {
    const incoming = buildLeadFromChat(chat, client, labelName);
    if (!incoming) {
      ignored += 1;
      return;
    }

    const index = currentLeads.findIndex((lead) => (
      clean(lead.instanceName) === instanceName &&
      (
        (incoming.externalId && lead.externalId === incoming.externalId) ||
        (incoming.whatsappJid && lead.whatsappJid === incoming.whatsappJid) ||
        (incoming.telefone && normalizePhone(lead.telefone) === incoming.telefone)
      )
    ));

    if (index >= 0) {
      const existing = currentLeads[index];
      const mergedTags = Array.from(new Set([...(Array.isArray(existing.tags) ? existing.tags : []), labelName, 'WhatsApp'])).slice(0, 8);
      currentLeads[index] = {
        ...existing,
        nome: existing.nome || incoming.nome,
        telefone: existing.telefone || incoming.telefone,
        externalId: existing.externalId || incoming.externalId,
        whatsappJid: existing.whatsappJid || incoming.whatsappJid,
        origem: existing.origem || incoming.origem,
        tags: mergedTags,
        lastWhatsappSyncAt: incoming.lastWhatsappSyncAt,
        updatedAt: incoming.updatedAt
      };
      updated += 1;
      return;
    }

    currentLeads.push(incoming);
    created += 1;
  });

  return { created, updated, ignored };
}

function safeAttempt(attempt, allCount) {
  return {
    attemptName: attempt.attemptName,
    status: attempt.status,
    count: attempt.count,
    usedAsMatch: false,
    warning: attempt.count === allCount && allCount > 0 ? 'Retornou a mesma quantidade do total; não será usado para evitar importar todos os chats.' : null
  };
}

async function syncByBrowser(req, res) {
  try {
    const token = clean(req.query.token || req.query.t || req.headers['x-client-token'] || '');
    const labelName = clean(req.query.labelName || req.query.label || DEFAULT_LABEL) || DEFAULT_LABEL;
    const limit = Number(req.query.limit || DEFAULT_SYNC_LIMIT);

    if (!token) return send(res, 400, { ok: false, error: 'Informe o token na URL.', via: 'browser-labelid-attempts', proxyVersion: VERSION });

    const client = findClientByToken(token);
    if (!client) {
      return send(res, 403, {
        ok: false,
        error: 'Token inválido ou inativo nesta rota de sync.',
        hint: 'Copie o token inteiro da página Admin e cole depois de ?token=.',
        via: 'browser-labelid-attempts',
        proxyVersion: VERSION
      });
    }

    const labels = await findEvolutionLabels(client.instanceName);
    const targetLabel = findTargetLabel(labels, labelName);

    if (!targetLabel) {
      return send(res, 404, {
        ok: false,
        error: `Etiqueta "${labelName}" não encontrada no WhatsApp conectado.`,
        labels,
        labelNames: labels.map((item) => item?.name || item?.label || item?.title || item?.id).filter(Boolean),
        via: 'browser-labelid-attempts',
        proxyVersion: VERSION
      });
    }

    const labelId = String(targetLabel.id || targetLabel.labelId || targetLabel.value || '').trim();
    const take = Math.min(Math.max(Number(limit) || DEFAULT_SYNC_LIMIT, 1), 1000);
    const baseOrder = { updatedAt: 'desc' };

    const allAttempt = await postFindChatsAttempt(client.instanceName, { where: {}, take, skip: 0, orderBy: baseOrder }, 'all_chats_then_local_label_check');
    const attempts = [safeAttempt(allAttempt, allAttempt.count)];

    let matchedChats = allAttempt.chats.filter((chat) => chatHasLabel(chat, labelName, targetLabel));
    let matchSource = matchedChats.length > 0 ? 'local_chat_label_fields' : '';

    if (matchedChats.length === 0 && labelId) {
      const filterBodies = [
        { attemptName: 'where_labelId_equals', body: { where: { labelId }, take, skip: 0, orderBy: baseOrder } },
        { attemptName: 'where_labelsId_equals', body: { where: { labelsId: labelId }, take, skip: 0, orderBy: baseOrder } },
        { attemptName: 'where_labelIds_has', body: { where: { labelIds: { has: labelId } }, take, skip: 0, orderBy: baseOrder } },
        { attemptName: 'where_labels_some_id', body: { where: { labels: { some: { id: labelId } } }, take, skip: 0, orderBy: baseOrder } },
        { attemptName: 'where_Labels_some_id', body: { where: { Labels: { some: { id: labelId } } }, take, skip: 0, orderBy: baseOrder } },
        { attemptName: 'where_label_id_object', body: { where: { label: { id: labelId } }, take, skip: 0, orderBy: baseOrder } }
      ];

      for (const item of filterBodies) {
        const attempt = await postFindChatsAttempt(client.instanceName, item.body, item.attemptName);
        const summary = safeAttempt(attempt, allAttempt.count);

        const looksFiltered = attempt.count > 0 && (allAttempt.count === 0 || attempt.count < allAttempt.count);
        if (matchedChats.length === 0 && looksFiltered) {
          matchedChats = uniqueChats(attempt.chats);
          matchSource = item.attemptName;
          summary.usedAsMatch = true;
          summary.warning = null;
        }

        attempts.push(summary);
      }
    }

    const leads = loadJsonArray(LEADS_FILE);
    const result = matchedChats.length > 0
      ? upsertLeadsFromChats(leads, client, matchedChats, targetLabel.name || labelName)
      : { created: 0, updated: 0, ignored: 0 };
    if (matchedChats.length > 0) saveJsonArray(LEADS_FILE, leads);

    return send(res, 200, {
      ok: true,
      client: publicClient(client),
      labelName: targetLabel.name || labelName,
      label: targetLabel,
      labelId,
      scannedChats: allAttempt.count,
      matchedChats: uniqueChats(matchedChats).length,
      matchSource: matchSource || null,
      created: result.created,
      updated: result.updated,
      ignored: result.ignored,
      attempts,
      warning: matchedChats.length === 0
        ? 'A etiqueta existe, mas nenhuma forma de busca retornou claramente os chats marcados. Veja attempts para saber se algum filtro por labelId retornou quantidade diferente do total.'
        : null,
      via: 'browser-labelid-attempts',
      proxyVersion: VERSION
    });
  } catch (error) {
    return send(res, error.response?.status || 500, {
      ok: false,
      error: error.message || 'Erro ao sincronizar MiniCRM pelo navegador.',
      details: error.response?.data || null,
      via: 'browser-labelid-attempts',
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
