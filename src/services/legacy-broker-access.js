const fs = require('fs/promises');
const path = require('path');

const filePath = process.env.CLIENTS_FILE_PATH || path.join(process.cwd(), 'data', 'clientes.json');
let writeQueue = Promise.resolve();

function slug(value) {
  return String(value || 'corretor').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 26) || 'corretor';
}

async function read() {
  try { const value = JSON.parse(await fs.readFile(filePath, 'utf8')); return Array.isArray(value) ? value : []; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function mutate(change) {
  writeQueue = writeQueue.then(async () => {
    const clients = await read();
    change(clients);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(clients, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filePath);
  });
  return writeQueue;
}

async function ensure(user, token) {
  let result;
  await mutate((clients) => {
    const index = clients.findIndex((item) => item.accessUserId === user.id);
    const previous = index >= 0 ? clients[index] : {};
    result = {
      ...previous,
      nome: user.name || previous.nome || 'Corretor',
      token,
      instanceName: previous.instanceName || `lungo_${slug(user.name)}_${String(user.id).slice(0, 8)}`,
      ativo: true,
      whatsapp: user.phone || previous.whatsapp || '',
      email: user.email || previous.email || '',
      organizationId: user.organizationId,
      accessUserId: user.id,
      updatedAt: new Date().toISOString(),
      createdAt: previous.createdAt || new Date().toISOString()
    };
    if (index >= 0) clients[index] = result; else clients.push(result);
  });
  return result;
}

module.exports = { ensure };
