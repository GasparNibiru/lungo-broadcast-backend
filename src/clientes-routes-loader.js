// Safe loader for clientes-routes.js.
// It corrects a serialized newline typo before compiling the Clientes module.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const target = path.join(__dirname, 'clientes-routes.js');
let source = fs.readFileSync(target, 'utf8');
source = source.replace('}\\nfunction normalizeStatus', '}\nfunction normalizeStatus');

const patchedModule = new Module(target, module.parent || module);
patchedModule.filename = target;
patchedModule.paths = Module._nodeModulePaths(path.dirname(target));
require.cache[target] = patchedModule;
patchedModule._compile(source, target);

module.exports = patchedModule.exports;
