// Safe loader for crm-auto-conversations.js.
// Tightens automatic lead capture, exposes scheduled messages and adds Lixeira/restore behavior.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const target = path.join(__dirname, 'crm-auto-conversations.js');
let source = fs.readFileSync(target, 'utf8');

source = source.replace("const VERSION = '2.0.0-auto-crm-pipeline';", "const VERSION = '2.0.3-auto-crm-trash-unread';");
source = source.replace("  arquivado: 'Arquivado'\n};", "  arquivado: 'Arquivado',\n  lixeira: 'Lixeira'\n};");
source = source.replace('const phoneFallback = phoneFromJid || normalizePhone(jidLeft(normalizedJid));', 'const phoneFallback = phoneFromJid;');
source = source.replace('telefone: base.telefone || phoneFromJid || phoneFallback || jidLeft(normalizedJid),', "telefone: base.telefone || phoneFromJid || phoneFallback || '',");
source = source.replace('archivedAt: lead.archivedAt || null,', 'archivedAt: lead.archivedAt || null,\n    trashedAt: lead.trashedAt || null,\n    restoredAt: lead.restoredAt || null,\n    mensagemProgramada: lead.mensagemProgramada || null,');
source = source.replace(
  "    arquivado: 'arquivado',\n    arquivo: 'arquivado',\n    oculto: 'arquivado'\n  };",
  "    arquivado: 'arquivado',\n    arquivo: 'arquivado',\n    oculto: 'arquivado',\n    lixeira: 'lixeira',\n    excluido: 'lixeira',\n    deletado: 'lixeira',\n    ignorado: 'lixeira'\n  };"
);

const helper = `
function isBadAutoName(value) {
  const raw = clean(value);
  const normalized = slugify(raw);
  if (!raw) return true;
  if (['voce', 'voces', 'eu', 'me', 'you', 'self', 'owner', 'whatsapp', 'unknown', 'desconhecido', 'true', 'false'].includes(normalized)) return true;
  if (raw.includes('@')) return true;
  if (/^https?:\\/\\//i.test(raw)) return true;
  if (/^\\+?\\d{8,}$/.test(raw.replace(/[\\s().-]/g, ''))) return true;
  if (/^Contato\\s+(WhatsApp|\\d{10,})$/i.test(raw)) return true;
  return false;
}
function isValidNewIncomingLead(body, remoteJid) {
  const normalizedJid = normalizeJid(remoteJid);
  if (!normalizedJid.includes('@s.whatsapp.net')) return false;
  const phone = normalizePhone(jidLeft(normalizedJid));
  if (!phone || phone.length < 10 || phone.length > 15) return false;
  const name = extractName(body);
  if (isBadAutoName(name)) return false;
  return true;
}
`;
source = source.replace('function buildAutoLead({ client, remoteJid, body, eventName, existing = null }) {', `${helper}\nfunction buildAutoLead({ client, remoteJid, body, eventName, existing = null }) {`);

source = source.replace(`    let created = 0;\n    let updated = 0;\n    let lead;`, `    if (index < 0 && !isValidNewIncomingLead(body, remoteJid)) {\n      const summary = { accepted: false, reason: 'invalid_new_contact_ignored', instanceName: client.instanceName, eventName, route: req.path, remoteJid };\n      logAuto(summary);\n      return send(res, 200, { ok: true, client: publicClient(client), ...summary, version: VERSION });\n    }\n\n    let created = 0;\n    let updated = 0;\n    let lead;`);

source = source.replace(
  "    const includeArchived = ['1', 'true', 'sim', 'yes'].includes(clean(req.query.includeArchived).toLowerCase());\n    const query = clean(req.query.q || req.query.search || '').toLowerCase();",
  "    const includeArchived = ['1', 'true', 'sim', 'yes'].includes(clean(req.query.includeArchived).toLowerCase());\n    const trashMode = ['1', 'true', 'sim', 'yes'].includes(clean(req.query.trash || req.query.lixeira || '').toLowerCase());\n    const query = clean(req.query.q || req.query.search || '').toLowerCase();"
);
source = source.replace(
  "    if (statusQuery) {\n      const status = normalizeStatus(statusQuery);\n      leads = leads.filter((lead) => normalizeStatus(lead.status) === status);\n    } else if (!includeArchived) {\n      leads = leads.filter((lead) => normalizeStatus(lead.status) !== 'arquivado');\n    }",
  "    if (trashMode) {\n      leads = leads.filter((lead) => normalizeStatus(lead.status) === 'lixeira');\n    } else if (statusQuery) {\n      const status = normalizeStatus(statusQuery);\n      leads = leads.filter((lead) => normalizeStatus(lead.status) === status);\n    } else if (!includeArchived) {\n      leads = leads.filter((lead) => !['arquivado', 'lixeira'].includes(normalizeStatus(lead.status)));\n    } else {\n      leads = leads.filter((lead) => normalizeStatus(lead.status) !== 'lixeira');\n    }"
);

source = source.replace(
  `function deleteAutoLead(req, res) {\n  try {\n    const token = tokenFromRequest(req);\n    const client = findClientByToken(token);\n    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });\n\n    const id = clean(req.params?.id || '');\n    const leads = loadArray(LEADS_FILE);\n    const filtered = leads.filter((lead) => !(lead.id === id && clean(lead.instanceName) === clean(client.instanceName)));\n    if (filtered.length === leads.length) return send(res, 404, { ok: false, error: 'Lead não encontrado para este cliente.', version: VERSION });\n    saveArray(LEADS_FILE, filtered);\n    return send(res, 200, { ok: true, removed: true, version: VERSION });\n  } catch (error) {\n    return send(res, 500, { ok: false, error: error.message || 'Erro ao excluir lead.', version: VERSION });\n  }\n}`,
  `function deleteAutoLead(req, res) {\n  try {\n    const token = tokenFromRequest(req);\n    const client = findClientByToken(token);\n    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });\n\n    const id = clean(req.params?.id || '');\n    const leads = loadArray(LEADS_FILE);\n    const index = leads.findIndex((lead) => lead.id === id && clean(lead.instanceName) === clean(client.instanceName));\n    if (index < 0) return send(res, 404, { ok: false, error: 'Lead não encontrado para este cliente.', version: VERSION });\n    const now = new Date().toISOString();\n    leads[index] = { ...leads[index], status: 'lixeira', trashedAt: now, updatedAt: now };\n    saveArray(LEADS_FILE, leads);\n    return send(res, 200, { ok: true, removed: true, movedToTrash: true, lead: publicLead(leads[index]), version: VERSION });\n  } catch (error) {\n    return send(res, 500, { ok: false, error: error.message || 'Erro ao excluir lead.', version: VERSION });\n  }\n}\n\nfunction restoreAutoLead(req, res) {\n  try {\n    const token = tokenFromRequest(req);\n    const client = findClientByToken(token);\n    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });\n    const id = clean(req.params?.id || '');\n    const leads = loadArray(LEADS_FILE);\n    const index = leads.findIndex((lead) => lead.id === id && clean(lead.instanceName) === clean(client.instanceName));\n    if (index < 0) return send(res, 404, { ok: false, error: 'Lead não encontrado para este cliente.', version: VERSION });\n    const now = new Date().toISOString();\n    leads[index] = { ...leads[index], status: 'novo', trashedAt: null, restoredAt: now, updatedAt: now };\n    saveArray(LEADS_FILE, leads);\n    return send(res, 200, { ok: true, restored: true, lead: publicLead(leads[index]), version: VERSION });\n  } catch (error) {\n    return send(res, 500, { ok: false, error: error.message || 'Erro ao restaurar lead.', version: VERSION });\n  }\n}\n\nfunction restoreAllTrash(req, res) {\n  try {\n    const token = tokenFromRequest(req);\n    const client = findClientByToken(token);\n    if (!client) return send(res, 403, { ok: false, error: 'Token inválido ou inativo.', version: VERSION });\n    const leads = loadArray(LEADS_FILE);\n    const now = new Date().toISOString();\n    let restored = 0;\n    leads.forEach((lead) => {\n      if (clean(lead.instanceName) === clean(client.instanceName) && normalizeStatus(lead.status) === 'lixeira') {\n        lead.status = 'novo';\n        lead.trashedAt = null;\n        lead.restoredAt = now;\n        lead.updatedAt = now;\n        restored += 1;\n      }\n    });\n    if (restored) saveArray(LEADS_FILE, leads);\n    return send(res, 200, { ok: true, restored, version: VERSION });\n  } catch (error) {\n    return send(res, 500, { ok: false, error: error.message || 'Erro ao restaurar lixeira.', version: VERSION });\n  }\n}`
);
source = source.replace("  app.options('/api/crm/auto-leads/:id/status', (req, res) => send(res, 204, {}));", "  app.options('/api/crm/auto-leads/:id/status', (req, res) => send(res, 204, {}));\n  app.options('/api/crm/auto-leads/:id/restore', (req, res) => send(res, 204, {}));\n  app.options('/api/crm/auto-leads/restore-all', (req, res) => send(res, 204, {}));");
source = source.replace("  app.post('/api/crm/auto-leads/:id/unarchive', (req, res) => setLeadStatus(req, res, 'novo', { archivedAt: null }));\n  app.delete('/api/crm/auto-leads/:id', deleteAutoLead);", "  app.post('/api/crm/auto-leads/:id/unarchive', (req, res) => setLeadStatus(req, res, 'novo', { archivedAt: null }));\n  app.post('/api/crm/auto-leads/:id/restore', restoreAutoLead);\n  app.post('/api/crm/auto-leads/restore-all', restoreAllTrash);\n  app.delete('/api/crm/auto-leads/:id', deleteAutoLead);");

const patchedModule = new Module(target, module.parent || module);
patchedModule.filename = target;
patchedModule.paths = Module._nodeModulePaths(path.dirname(target));
require.cache[target] = patchedModule;
patchedModule._compile(source, target);

module.exports = patchedModule.exports;
