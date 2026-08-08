const fs = require('fs/promises');
const path = require('path');

const filePath = process.env.ACCESS_TOKENS_FILE_PATH
  || path.join(path.dirname(process.env.CLIENTS_FILE_PATH || path.join(process.cwd(), 'data', 'clientes.json')), 'access-tokens.json');

let writeQueue = Promise.resolve();

async function read() {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function mutate(change) {
  writeQueue = writeQueue.then(async () => {
    const values = await read();
    change(values);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(values, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, filePath);
  });
  return writeQueue;
}

async function all() { return read(); }
async function get(userId) { return (await read())[userId] || null; }
async function set(userId, token) { return mutate((values) => { values[userId] = token; }); }
async function remove(userId) { return mutate((values) => { delete values[userId]; }); }

module.exports = { all, get, set, remove };
