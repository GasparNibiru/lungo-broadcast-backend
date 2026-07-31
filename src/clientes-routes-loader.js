// Safe loader for clientes-routes.js.
// It corrects a serialized newline typo and adds post-sale hour support before compiling the Clientes module.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const target = path.join(__dirname, 'clientes-routes.js');
let source = fs.readFileSync(target, 'utf8');
source = source.replace('}\\nfunction normalizeStatus', '}\nfunction normalizeStatus');
source = source.replace(
  "recorrencia: clean(body.recorrencia || 'unica'), mensagem: clean(body.mensagem || ''), ativo:",
  "recorrencia: clean(body.recorrencia || 'unica'), hora: clean(body.hora || body.hour || '09:00'), mensagem: clean(body.mensagem || ''), ativo:"
);

const patchedModule = new Module(target, module.parent || module);
patchedModule.filename = target;
patchedModule.paths = Module._nodeModulePaths(path.dirname(target));
require.cache[target] = patchedModule;
patchedModule._compile(source, target);

module.exports = patchedModule.exports;
