// Safe loader for crm-auto-conversations.js.
// Tightens automatic lead capture so invalid @lid-only or junk contacts are ignored and exposes scheduled messages.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const target = path.join(__dirname, 'crm-auto-conversations.js');
let source = fs.readFileSync(target, 'utf8');

source = source.replace("const VERSION = '2.0.0-auto-crm-pipeline';", "const VERSION = '2.0.2-auto-crm-clean-leads-schedule';");
source = source.replace('const phoneFallback = phoneFromJid || normalizePhone(jidLeft(normalizedJid));', 'const phoneFallback = phoneFromJid;');
source = source.replace('telefone: base.telefone || phoneFromJid || phoneFallback || jidLeft(normalizedJid),', "telefone: base.telefone || phoneFromJid || phoneFallback || '',");
source = source.replace('archivedAt: lead.archivedAt || null,', 'archivedAt: lead.archivedAt || null,\n    mensagemProgramada: lead.mensagemProgramada || null,');

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

const patchedModule = new Module(target, module.parent || module);
patchedModule.filename = target;
patchedModule.paths = Module._nodeModulePaths(path.dirname(target));
require.cache[target] = patchedModule;
patchedModule._compile(source, target);

module.exports = patchedModule.exports;
