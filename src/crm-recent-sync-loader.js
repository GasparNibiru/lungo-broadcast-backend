// Safe loader for crm-recent-sync.js.
// Keeps deleted/ignored leads in the Lixeira so sync does not bring them back.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const target = path.join(__dirname, 'crm-recent-sync.js');
let source = fs.readFileSync(target, 'utf8');

source = source.replace("const VERSION = '2.2.0-clean-recent-sync';", "const VERSION = '2.3.0-clean-recent-sync-trash';");
source = source.replace("  arquivado: 'Arquivado'\n};", "  arquivado: 'Arquivado',\n  lixeira: 'Lixeira'\n};");
source = source.replace("    arquivado: 'arquivado'\n  };", "    arquivado: 'arquivado',\n    lixeira: 'lixeira',\n    excluido: 'lixeira',\n    ignorado: 'lixeira',\n    deletado: 'lixeira'\n  };");
source = source.replace(
  "    archivedAt: lead.archivedAt || null,\n    createdAt: lead.createdAt || null,",
  "    archivedAt: lead.archivedAt || null,\n    trashedAt: lead.trashedAt || null,\n    restoredAt: lead.restoredAt || null,\n    mensagemProgramada: lead.mensagemProgramada || null,\n    createdAt: lead.createdAt || null,"
);
source = source.replace(
  "  if (index >= 0) {\n    const current = leads[index];",
  "  if (index >= 0) {\n    const current = leads[index];\n    if (normalizeStatus(current.status || '') === 'lixeira') {\n      return { skipped: true, reason: 'trashed_lead_ignored', remoteJid };\n    }"
);
source = source.replace(
  "    const summary = {\n      ok: true,",
  "    const activeClientLeads = clientLeads.filter((lead) => normalizeStatus(lead.status) !== 'lixeira');\n    const summary = {\n      ok: true,"
);
source = source.replace(
  "      leadCount: clientLeads.length,\n      sample: clientLeads",
  "      leadCount: activeClientLeads.length,\n      ignoredCount: clientLeads.length - activeClientLeads.length,\n      sample: activeClientLeads"
);

const patchedModule = new Module(target, module.parent || module);
patchedModule.filename = target;
patchedModule.paths = Module._nodeModulePaths(path.dirname(target));
require.cache[target] = patchedModule;
patchedModule._compile(source, target);

module.exports = patchedModule.exports;
