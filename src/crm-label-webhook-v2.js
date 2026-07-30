// Mini CRM label webhook receiver v2.
// Handles Evolution label events and enriches @lid contacts with Evolution contacts data.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const realExpress = require('express');

let registered = false;
const VERSION = '1.8.3-contact-enrichment';

const ROOT = path.resolve(__dirname, '..');
const CLIENTS_FILE = process.env.CLIENTS_FILE_PATH || path.join(ROOT, 'data', 'clientes.json');
const LEADS_FILE = process.env.LEADS_FILE_PATH || path.join(ROOT, 'data', 'leads.json');
const LOG_FILE = process.env.CRM_LABEL_WEBHOOK_LOG_FILE || path.join(ROOT, 'data', 'label_webhook_events.json');
const DEFAULT_LABEL = process.env.CRM_WHATSAPP_LABEL || 'MiniCRM';
const PUBLIC_BACKEND_URL = String(process.env.PUBLIC_BACKEND_URL || process.env.API_PUBLIC_URL || 'https://lungo-disparos-app.dzpywk.easypanel.host').replace(/\/+$/, '');
const DEFAULT_CONTACT_LIMIT = Math.min(Math.max(Number(process.env.CRM_CONTACT_LOOKUP_LIMIT || 5000), 100), 10000);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
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
  return clean(value).toUpperCase().replace(/\s+/g, '');
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'item';
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = `55${digits}`;
  return digits;
}

function generateId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function loadArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

function findClientByInstance(instanceName) {
  const wanted = clean(instanceName).toLowerCase();
  if (!wanted) return null;
  return loadArray(CLIENTS_FILE).find((item) => clean(item.instanceName).toLowerCase() === wanted && item.ativo !== false) || null;
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
  return { apikey: process.env.EVOLUTION_API_KEY || '', 'Content-Type': 'application/json' };
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
  if (Array.isArray(data?.labels)) return data.labels;
  if (Array.isArray(data?.contacts)) return data.contacts;
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

async function findEvolutionContacts(instanceName, where = {}, take = DEFAULT_CONTACT_LIMIT) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_FIND_CONTACTS_PATH || '/chat/findContacts/:instanceName', instanceName);
  const response = await axios.post(url, {
    where: where || {},
    take,
    skip: 0,
    orderBy: {}
  }, {
    headers: evolutionHeaders(),
    timeout: 60000,
    validateStatus: () => true
  });

  return {
    status: response.status,
    contacts: response.status >= 200 && response.status < 300 ? extractArray(response.data) : [],
    data: response.data
  };
}

async function setEvolutionWebhookV2(instanceName, webhookUrl) {
  ensureEvolutionConfig();
  const url = buildEvolutionUrl(process.env.EVOLUTION_SET_WEBHOOK_PATH || '/webhook/set/:instanceName', instanceName);
  const events = String(process.env.CRM_LABEL_WEBHOOK_EVENTS || 'LABELS_EDIT,LABELS_ASSOCIATION')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const webhook = {
    enabled: true,
    url: webhookUrl,
    events,
    headers: {},
    base64: false,
    webhookByEvents: false,
    webhook_by_events: false
  };

  const payload = { webhook };
  const response = await axios.post(url, payload, {
    headers: evolutionHeaders(),
    timeout: 30000,
    validateStatus: () => true
  });

  return { status: response.status, data: response.data, payload };
}

function collectStrings(value, output = [], seen = new Set()) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(String(value));
    return output;
  }
  if (typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectStrings(item, output, seen));
    return output;
  }
  Object.values(value).forEach((child) => collectStrings(child, output, seen));
  return output;
}

function collectByKey(value, keyNames, output = [], seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object' || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectByKey(item, keyNames, output, seen));
    return output;
  }
  Object.entries(value).forEach(([key, child]) => {
    const normalized = slugify(key).replace(/_/g, '');
    if (keyNames.includes(normalized)) output.push(child);
    collectByKey(child, keyNames, output, seen);
  });
  return output;
}

function findTargetLabel(labels, labelName) {
  const wanted = slugify(labelName).replace(/_/g, '');
  return labels.find((item) => {
    const names = [item?.name, item?.label, item?.title, item?.id, item?.value]
      .map((value) => slugify(value).replace(/_/g, ''));
    return names.includes(wanted);
  }) || null;
}

function extractLabelCandidates(body) {
  const values = [
    body?.labelId,
    body?.label_id,
    body?.label?.id,
    body?.label?.name,
    body?.labelName,
    body?.data?.labelId,
    body?.data?.label_id,
    body?.data?.label?.id,
    body?.data?.label?.name,
    body?.data?.labelName,
    ...collectByKey(body, ['labelid', 'label', 'labelname', 'labelids', 'labels'])
  ];
  return Array.from(new Set(values.flatMap((item) => collectStrings(item)).map(clean).filter(Boolean)));
}

function labelMatches(candidates, targetLabel, labelName) {
  const targetId = clean(targetLabel?.id || targetLabel?.labelId || targetLabel?.value || '').toLowerCase();
  const targetNames = [labelName, targetLabel?.name, targetLabel?.label, targetLabel?.title]
    .map((item) => slugify(item).replace(/_/g, ''))
    .filter(Boolean);

  return candidates.some((candidate) => {
    const raw = clean(candidate);
    const rawLower = raw.toLowerCase();
    const rawSlug = slugify(raw).replace(/_/g, '');
    return (!!targetId && rawLower === targetId) || targetNames.includes(rawSlug);
  });
}

function extractInstanceName(body, req) {
  const values = [
    req.query?.instance,
    req.query?.instanceName,
    body?.instance,
    body?.instanceName,
    body?.instanceId,
    body?.data?.instance,
    body?.data?.instanceName,
    body?.data?.instanceId,
    body?.sender,
    ...collectByKey(body, ['instance', 'instancename', 'instanceid'])
  ].map(clean).filter(Boolean);
  return values[0] || '';
}

function extractRemoteJid(body) {
  const values = [
    body?.jid,
    body?.remoteJid,
    body?.chatId,
    body?.chatJid,
    body?.data?.jid,
    body?.data?.remoteJid,
    body?.data?.chatId,
    body?.data?.chatJid,
    body?.data?.key?.remoteJid,
    body?.key?.remoteJid,
    ...collectByKey(body, ['remotejid', 'chatjid', 'jid', 'chatid'])
  ].map(clean).filter(Boolean);

  return values.find((item) => item.includes('@')) || collectStrings(body).find((item) => /@(s\.whatsapp\.net|lid|c\.us|g\.us)/i.test(item)) || values[0] || '';
}

function extractName(body, fallback) {
  const values = [
    body?.name,
    body?.pushName,
    body?.verifiedName,
    body?.data?.name,
    body?.data?.pushName,
    body?.data?.verifiedName,
    body?.contact?.name,
    body?.data?.contact?.name,
    ...collectByKey(body, ['pushname', 'verifiedname', 'profilename', 'name'])
  ].map(clean).filter(Boolean);
  return values.find((item) => !item.includes('@') && item.length > 1 && item.length < 100) || `Contato ${fallback}`;
}

function isRemoveAction(body) {
  const text = [body?.action, body?.operation, body?.type, body?.event, body?.data?.action, body?.data?.operation, body?.data?.type, body?.data?.event, ...collectByKey(body, ['action', 'operation', 'event', 'type'])]
    .flatMap((item) => collectStrings(item))
    .join(' ')
    .toLowerCase();
  return text.includes('remove') || text.includes('delete') || text.includes('detach') || text.includes('unassign');
}

function normalizeJid(value) {
  return clean(value).toLowerCase();
}

function jidLeft(value) {
  return normalizeJid(value).split('@')[0] || '';
}

function contactStrings(contact) {
  return [
    contact?.id,
    contact?.jid,
    contact?.remoteJid,
    contact?.chatId,
    contact?.number,
    contact?.phone,
    contact?.waId,
    contact?.contactId,
    contact?.lid,
    contact?.pushName,
    contact?.name,
    ...collectByKey(contact, ['id', 'jid', 'remotejid', 'chatid', 'number', 'phone', 'waid', 'contactid', 'lid'])
  ].flatMap((item) => collectStrings(item)).map(clean).filter(Boolean);
}

function publicContact(contact) {
  if (!contact) return null;
  return {
    id: clean(contact.id || contact.jid || contact.remoteJid || ''),
    pushName: clean(contact.pushName || contact.name || contact.verifiedName || ''),
    number: normalizePhone(contact.number || contact.phone || contact.waId || ''),
    profilePictureUrl: clean(contact.profilePictureUrl || contact.profilePicUrl || contact.picture || contact.avatar || contact.imgUrl || '')
  };
}

function contactFromPayload(body) {
  const candidates = [
    body?.contact,
    body?.data?.contact,
    body?.data?.Contact,
    body?.Contact,
    body?.data?.message?.contact,
    ...collectByKey(body, ['contact'])
  ].filter((item) => item && typeof item === 'object');

  return candidates.find((item) => {
    const c = publicContact(item);
    return c.id || c.number || c.pushName || c.profilePictureUrl;
  }) || null;
}

function selectContactForJid(contacts, remoteJid) {
  const remote = normalizeJid(remoteJid);
  const left = jidLeft(remoteJid);
  const leftDigits = normalizePhone(left);
  const isLid = remote.includes('@lid');

  return contacts.find((contact) => {
    const values = contactStrings(contact);
    const normalizedValues = values.map((item) => normalizeJid(item));
    const leftValues = normalizedValues.map((item) => item.split('@')[0]);

    if (normalizedValues.includes(remote)) return true;
    if (left && leftValues.includes(left)) return true;

    if (!isLid && leftDigits) {
      return values.some((item) => normalizePhone(item) === leftDigits);
    }

    return false;
  }) || null;
}

async function resolveContact(instanceName, remoteJid, body) {
  const fromPayload = contactFromPayload(body);
  if (fromPayload) {
    const fromPayloadMatch = selectContactForJid([fromPayload], remoteJid) || fromPayload;
    return { contact: publicContact(fromPayloadMatch), source: 'webhook_payload', status: 200, scannedContacts: 1 };
  }

  if (process.env.CRM_CONTACT_LOOKUP_ENABLED === 'false') {
    return { contact: null, source: 'disabled', status: 0, scannedContacts: 0 };
  }

  const directWhereAttempts = [
    { id: remoteJid },
    { jid: remoteJid },
    { remoteJid },
    { lid: jidLeft(remoteJid) }
  ];

  for (const where of directWhereAttempts) {
    const result = await findEvolutionContacts(instanceName, where, 20);
    const matched = selectContactForJid(result.contacts, remoteJid);
    if (matched) {
      return { contact: publicContact(matched), source: `findContacts_where_${Object.keys(where)[0]}`, status: result.status, scannedContacts: result.contacts.length };
    }
  }

  const allContacts = await findEvolutionContacts(instanceName, {}, DEFAULT_CONTACT_LIMIT);
  const matched = selectContactForJid(allContacts.contacts, remoteJid);
  if (matched) {
    return { contact: publicContact(matched), source: 'findContacts_full_scan', status: allContacts.status, scannedContacts: allContacts.contacts.length };
  }

  return { contact: null, source: 'not_found_in_contacts', status: allContacts.status, scannedContacts: allContacts.contacts.length };
}

function shouldReplaceName(currentName, newName) {
  const current = clean(currentName);
  const next = clean(newName);
  if (!next) return false;
  if (!current) return true;
  if (/^contato\s+\d+/i.test(current)) return true;
  if (current.includes('@lid')) return true;
  return false;
}

function shouldReplacePhone(currentPhone, newPhone, currentJid = '') {
  const current = normalizePhone(currentPhone);
  const next = normalizePhone(newPhone);
  if (!next || next.length < 10) return false;
  if (!current) return true;
  if (normalizeJid(currentJid).includes('@lid')) return true;
  if (!current.startsWith('55') && current.length > 12) return true;
  if (current.length > 13 && !current.startsWith('55')) return true;
  return false;
}

function buildLead(body, client, labelName, remoteJid, resolved = {}) {
  const contact = resolved.contact || {};
  const phonePart = remoteJid.includes('@') ? remoteJid.split('@')[0] : remoteJid;
  const fallbackPhone = normalizePhone(phonePart);
  const contactPhone = normalizePhone(contact.number || '');
  const telefone = contactPhone || (fallbackPhone && fallbackPhone.length >= 10 ? fallbackPhone : remoteJid);
  const nameFromContact = clean(contact.pushName || contact.name || '');
  const now = new Date().toISOString();

  return {
    id: generateId('lead'),
    instanceName: client.instanceName,
    externalId: `whatsapp:${remoteJid}`,
    whatsappJid: remoteJid,
    nome: nameFromContact || extractName(body, telefone),
    telefone,
    profilePictureUrl: clean(contact.profilePictureUrl || ''),
    status: 'novo_lead',
    origem: `WhatsApp etiqueta ${labelName}`,
    observacao: resolved.contact
      ? `Sincronizado pelo webhook da etiqueta ${labelName}. Contato enriquecido via ${resolved.source}.`
      : `Sincronizado pelo webhook da etiqueta ${labelName}.`,
    proximoRetorno: '',
    cidade: '',
    planoAtual: '',
    valor: '',
    tags: [labelName, 'WhatsApp'],
    createdAt: now,
    updatedAt: now,
    lastWhatsappSyncAt: now,
    contactLookupSource: resolved.source || '',
    contactLookupStatus: resolved.status || 0
  };
}

function upsertLead(lead) {
  const leads = loadArray(LEADS_FILE);
  const index = leads.findIndex((item) => clean(item.instanceName) === clean(lead.instanceName) && (
    (lead.externalId && item.externalId === lead.externalId) ||
    (lead.whatsappJid && item.whatsappJid === lead.whatsappJid) ||
    (lead.telefone && normalizePhone(item.telefone) === normalizePhone(lead.telefone))
  ));

  if (index >= 0) {
    const current = leads[index];
    leads[index] = {
      ...current,
      nome: shouldReplaceName(current.nome, lead.nome) ? lead.nome : current.nome,
      telefone: shouldReplacePhone(current.telefone, lead.telefone, current.whatsappJid || lead.whatsappJid) ? lead.telefone : current.telefone,
      externalId: current.externalId || lead.externalId,
      whatsappJid: current.whatsappJid || lead.whatsappJid,
      origem: current.origem || lead.origem,
      profilePictureUrl: current.profilePictureUrl || lead.profilePictureUrl || '',
      tags: Array.from(new Set([...(Array.isArray(current.tags) ? current.tags : []), ...lead.tags])).slice(0, 8),
      lastWhatsappSyncAt: lead.lastWhatsappSyncAt,
      contactLookupSource: lead.contactLookupSource || current.contactLookupSource || '',
      contactLookupStatus: lead.contactLookupStatus || current.contactLookupStatus || 0,
      updatedAt: lead.updatedAt
    };
    saveArray(LEADS_FILE, leads);
    return { created: 0, updated: 1, lead: leads[index] };
  }

  leads.push(lead);
  saveArray(LEADS_FILE, leads);
  return { created: 1, updated: 0, lead };
}

function logEvent(summary) {
  const logs = loadArray(LOG_FILE);
  logs.unshift({ time: new Date().toISOString(), ...summary });
  saveArray(LOG_FILE, logs.slice(0, 50));
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

async function handleWebhook(req, res) {
  try {
    const body = await readBody(req);
    const instanceName = extractInstanceName(body, req);
    const client = findClientByInstance(instanceName);
    const eventName = clean(req.params?.eventName || body.event || body.type || '');
    const labelName = clean(req.query.label || DEFAULT_LABEL) || DEFAULT_LABEL;

    if (!client) {
      const summary = { accepted: false, reason: 'instance_not_registered', instanceName, eventName, route: req.path };
      logEvent(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    const labels = await findEvolutionLabels(client.instanceName);
    const targetLabel = findTargetLabel(labels, labelName);
    const labelCandidates = extractLabelCandidates(body);
    const remoteJid = extractRemoteJid(body);

    if (!targetLabel) {
      const summary = { accepted: false, reason: 'target_label_not_found', instanceName: client.instanceName, labelName, labelCandidates, eventName, route: req.path };
      logEvent(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    if (isRemoveAction(body)) {
      const summary = { accepted: false, reason: 'remove_action_ignored', instanceName: client.instanceName, labelName, labelId: targetLabel.id || null, remoteJid, eventName, route: req.path };
      logEvent(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    if (!labelMatches(labelCandidates, targetLabel, labelName)) {
      const summary = { accepted: false, reason: 'label_not_matched', instanceName: client.instanceName, labelName, labelId: targetLabel.id || null, labelCandidates, remoteJid, eventName, route: req.path };
      logEvent(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    if (!remoteJid) {
      const summary = { accepted: false, reason: 'jid_not_found', instanceName: client.instanceName, labelName, labelId: targetLabel.id || null, labelCandidates, eventName, route: req.path };
      logEvent(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    if (remoteJid.includes('@g.us')) {
      const summary = { accepted: false, reason: 'group_ignored', instanceName: client.instanceName, labelName, labelId: targetLabel.id || null, remoteJid, eventName, route: req.path };
      logEvent(summary);
      return send(res, 200, { ok: true, ...summary, version: VERSION });
    }

    const resolved = await resolveContact(client.instanceName, remoteJid, body);
    const result = upsertLead(buildLead(body, client, targetLabel.name || labelName, remoteJid, resolved));
    const summary = {
      accepted: true,
      instanceName: client.instanceName,
      labelName: targetLabel.name || labelName,
      labelId: targetLabel.id || null,
      remoteJid,
      eventName,
      route: req.path,
      created: result.created,
      updated: result.updated,
      contactLookupSource: resolved.source,
      contactLookupStatus: resolved.status,
      scannedContacts: resolved.scannedContacts,
      enriched: !!resolved.contact
    };
    logEvent(summary);
    return send(res, 200, { ok: true, client: publicClient(client), ...summary, lead: result.lead, version: VERSION });
  } catch (error) {
    return send(res, error.response?.status || 500, { ok: false, error: error.message || 'Erro no webhook de etiquetas v2.', details: error.response?.data || null, version: VERSION });
  }
}

async function configureWebhook(req, res) {
  try {
    const token = clean(req.query.token || req.query.t || '');
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const query = new URLSearchParams({ instance: client.instanceName });
    const webhookUrl = `${PUBLIC_BACKEND_URL}/api/crm/label-webhook-v2?${query.toString()}`;
    const result = await setEvolutionWebhookV2(client.instanceName, webhookUrl);

    return send(res, result.status >= 200 && result.status < 300 ? 200 : result.status, {
      ok: result.status >= 200 && result.status < 300,
      client: publicClient(client),
      webhookUrl,
      events: result.payload.webhook.events,
      evolutionStatus: result.status,
      evolutionPayloadShape: 'webhook_object_v2_by_events_false',
      evolutionResponse: result.data,
      version: VERSION
    });
  } catch (error) {
    return send(res, error.response?.status || 500, { ok: false, error: error.message || 'Erro ao configurar webhook v2.', details: error.response?.data || null, version: VERSION });
  }
}

async function lookupContact(req, res) {
  try {
    const token = clean(req.query.token || req.query.t || '');
    const jid = clean(req.query.jid || req.query.remoteJid || '');
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });
    if (!jid) return send(res, 400, { ok: false, error: 'Informe jid na URL.', version: VERSION });

    const resolved = await resolveContact(client.instanceName, jid, {});
    return send(res, 200, { ok: true, client: publicClient(client), jid, ...resolved, version: VERSION });
  } catch (error) {
    return send(res, error.response?.status || 500, { ok: false, error: error.message || 'Erro ao buscar contato.', details: error.response?.data || null, version: VERSION });
  }
}

async function enrichExistingLeads(req, res) {
  try {
    const token = clean(req.query.token || req.query.t || '');
    const client = findClientByToken(token);
    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });

    const contactsResult = await findEvolutionContacts(client.instanceName, {}, DEFAULT_CONTACT_LIMIT);
    const leads = loadArray(LEADS_FILE);
    let updated = 0;
    let unresolved = 0;

    const nextLeads = leads.map((lead) => {
      if (clean(lead.instanceName) !== clean(client.instanceName)) return lead;

      const jid = clean(lead.whatsappJid || '').includes('@') ? clean(lead.whatsappJid) : `${clean(lead.telefone)}@lid`;
      const contact = selectContactForJid(contactsResult.contacts, jid);
      if (!contact) {
        unresolved += 1;
        return lead;
      }

      const publicInfo = publicContact(contact);
      const candidate = {
        ...lead,
        nome: shouldReplaceName(lead.nome, publicInfo.pushName) ? publicInfo.pushName : lead.nome,
        telefone: shouldReplacePhone(lead.telefone, publicInfo.number, lead.whatsappJid) ? publicInfo.number : lead.telefone,
        profilePictureUrl: lead.profilePictureUrl || publicInfo.profilePictureUrl || '',
        contactLookupSource: 'manual_enrich_findContacts',
        contactLookupStatus: contactsResult.status,
        updatedAt: new Date().toISOString()
      };

      const changed = JSON.stringify(candidate) !== JSON.stringify(lead);
      if (changed) updated += 1;
      return candidate;
    });

    if (updated > 0) saveArray(LEADS_FILE, nextLeads);

    return send(res, 200, {
      ok: true,
      client: publicClient(client),
      contactsStatus: contactsResult.status,
      scannedContacts: contactsResult.contacts.length,
      totalLeads: leads.filter((lead) => clean(lead.instanceName) === clean(client.instanceName)).length,
      updated,
      unresolved,
      version: VERSION
    });
  } catch (error) {
    return send(res, error.response?.status || 500, { ok: false, error: error.message || 'Erro ao enriquecer leads.', details: error.response?.data || null, version: VERSION });
  }
}

function register(app) {
  if (registered) return;
  registered = true;

  app.options('/api/crm/label-webhook-v2', (req, res) => send(res, 204, {}));
  app.options('/api/crm/label-webhook-v2/:eventName', (req, res) => send(res, 204, {}));
  app.options('/api/crm/label-webhook/:eventName', (req, res) => send(res, 204, {}));
  app.options('/api/crm/contact-lookup-browser', (req, res) => send(res, 204, {}));
  app.options('/api/crm/enrich-lid-leads-browser', (req, res) => send(res, 204, {}));

  app.post('/api/crm/label-webhook-v2', handleWebhook);
  app.post('/api/crm/label-webhook-v2/:eventName', handleWebhook);
  app.post('/api/crm/label-webhook/:eventName', handleWebhook);

  app.get('/api/crm/label-webhook-v2-health', (req, res) => send(res, 200, {
    ok: true,
    module: 'crm-label-webhook-v2',
    version: VERSION,
    defaultLabel: DEFAULT_LABEL,
    publicBackendUrl: PUBLIC_BACKEND_URL,
    contactLookupLimit: DEFAULT_CONTACT_LIMIT,
    time: new Date().toISOString()
  }));
  app.get('/api/crm/configure-label-webhook-v2-browser', configureWebhook);
  app.get('/api/crm/contact-lookup-browser', lookupContact);
  app.get('/api/crm/enrich-lid-leads-browser', enrichExistingLeads);
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
