const crypto = require('crypto');
const supabase = require('../database/supabase');
const tokenVault = require('./access-token-vault');

const ACCESS_SELECT = `
  id,
  organization_id,
  name,
  email,
  phone,
  role,
  status,
  last_login_at,
  created_at,
  organizations!users_organization_id_fkey (name),
  access_tokens (status, expires_at, last_used_at, created_at)
`;

class AdminAccessError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AdminAccessError';
    this.statusCode = statusCode;
  }
}

function generateToken() {
  // 72 bits of entropy in a compact, human-friendly 16-character token.
  return `LNG-${crypto.randomBytes(9).toString('base64url')}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function currentToken(tokens) {
  const now = Date.now();
  return [...(tokens || [])]
    .filter((token) => token.status === 'active' && (!token.expires_at || Date.parse(token.expires_at) > now))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}

function mapAccess(user, storedToken = null) {
  const token = currentToken(user.access_tokens);
  return {
    user_id: user.id,
    organization_id: user.organization_id,
    organization_name: user.organizations?.name || null,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
    active_token: Boolean(token),
    token: token ? storedToken : null,
    token_expires_at: token?.expires_at || null,
    token_last_used_at: token?.last_used_at || null
  };
}

function databaseError(context, error) {
  console.error(`[ADMIN ACCESSES DATABASE ERROR] ${context}`, {
    code: error.code,
    message: error.message
  });
  return new AdminAccessError('Erro interno no servidor.', 500);
}

function rpcError(error) {
  const known = {
    organization_not_found: ['Organização não encontrada.', 404],
    user_not_found: ['Usuário não encontrado.', 404],
    active_subscription_not_found: ['Organização sem assinatura ativa.', 409],
    access_limit_reached: ['Limite de acessos da assinatura atingido.', 409],
    email_already_exists: ['E-mail já cadastrado.', 409],
    invalid_role: ['Role inválida.', 400]
  };
  const mapped = known[error.message];
  if (mapped) return new AdminAccessError(mapped[0], mapped[1]);
  if (error.code === '23505') return new AdminAccessError('Acesso duplicado.', 409);
  if (error.code === '22P02' || error.code === '22023') return new AdminAccessError('Dados inválidos.', 400);
  return databaseError('rpc', error);
}

async function getAccess(userId) {
  const { data, error } = await supabase.from('users').select(ACCESS_SELECT).eq('id', userId).maybeSingle();
  if (error) throw databaseError('get access', error);
  if (!data) throw new AdminAccessError('Usuário não encontrado.', 404);
  return mapAccess(data, await tokenVault.get(userId));
}

async function listAdminAccesses() {
  const { data, error } = await supabase.from('users').select(ACCESS_SELECT).neq('status', 'inactive').order('created_at', { ascending: false });
  if (error) throw databaseError('list accesses', error);
  const storedTokens = await tokenVault.all();
  return (data || []).map((user) => mapAccess(user, storedTokens[user.id] || null));
}

async function createAdminAccess(input) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const { data, error } = await supabase.rpc('create_admin_access', {
    p_organization_id: input.organizationId,
    p_name: input.name,
    p_email: input.email,
    p_phone: input.phone,
    p_role: input.role,
    p_expires_at: input.expiresAt,
    p_token_hash: tokenHash
  });
  if (error) throw rpcError(error);
  await tokenVault.set(data.user_id, token);
  return { user: await getAccess(data.user_id), token };
}

async function updateAdminAccess(userId, input) {
  const has = (field) => Object.prototype.hasOwnProperty.call(input, field);
  const { error } = await supabase.rpc('update_admin_access', {
    p_user_id: userId,
    p_name: input.name ?? null,
    p_has_name: has('name'),
    p_email: input.email ?? null,
    p_has_email: has('email'),
    p_phone: input.phone ?? null,
    p_has_phone: has('phone'),
    p_role: input.role ?? null,
    p_has_role: has('role')
  });
  if (error) throw rpcError(error);
  return getAccess(userId);
}

async function runUserAction(userId, action) {
  const { error } = await supabase.rpc('change_admin_access', { p_user_id: userId, p_action: action });
  if (error) throw rpcError(error);
  if (action === 'invalidate_token') await tokenVault.remove(userId);
  return getAccess(userId);
}

async function archiveAdminAccess(userId) {
  const { data, error } = await supabase.from('users').update({ status: 'inactive' }).eq('id', userId).select('id').maybeSingle();
  if (error) throw databaseError('archive access', error);
  if (!data) throw new AdminAccessError('Usuário não encontrado.', 404);
  const { error: tokenError } = await supabase.from('access_tokens').update({ status: 'revoked', revoked_at: new Date().toISOString() }).eq('user_id', userId).eq('status', 'active');
  if (tokenError) throw databaseError('archive access tokens', tokenError);
  await tokenVault.remove(userId);
  return { id: userId, archived: true };
}

async function renewAdminAccessToken(userId, expiresAt) {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const { error } = await supabase.rpc('renew_admin_access_token', {
    p_user_id: userId,
    p_expires_at: expiresAt,
    p_token_hash: tokenHash
  });
  if (error) throw rpcError(error);
  await tokenVault.set(userId, token);
  return { user: await getAccess(userId), token };
}

module.exports = {
  AdminAccessError,
  generateToken,
  hashToken,
  listAdminAccesses,
  createAdminAccess,
  updateAdminAccess,
  runUserAction,
  archiveAdminAccess,
  renewAdminAccessToken
};
