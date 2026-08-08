const crypto = require('crypto');
const supabase = require('../database/supabase');

function accessToken(req) {
  const authorization = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-access-token'] || req.body?.token || '').trim();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function requireAccess(roles = []) {
  const allowed = new Set(Array.isArray(roles) ? roles : [roles]);
  return async function accessMiddleware(req, res, next) {
    const token = accessToken(req);
    if (!token) return res.status(401).json({ ok: false, error: 'Token de acesso obrigatório.' });

    const { data, error } = await supabase
      .from('access_tokens')
      .select('id, user_id, status, expires_at, users!inner(id, organization_id, role, name, email, phone, status, organizations!users_organization_id_fkey(id, name, status))')
      .eq('token_hash', hashToken(token))
      .eq('status', 'active')
      .maybeSingle();

    if (error) {
      console.error('[ACCESS AUTH ERROR]', error.message || error);
      return res.status(500).json({ ok: false, error: 'Erro ao validar acesso.' });
    }

    const user = data?.users;
    const expired = data?.expires_at && Date.parse(data.expires_at) <= Date.now();
    if (!user || expired || user.status !== 'active' || user.organizations?.status !== 'active') {
      return res.status(401).json({ ok: false, error: 'Token inválido, expirado ou inativo.' });
    }
    if (allowed.size && !allowed.has(user.role)) return res.status(403).json({ ok: false, error: 'Perfil sem permissão para esta operação.' });

    req.accessUser = { id: user.id, organizationId: user.organization_id, role: user.role, name: user.name, email: user.email, phone: user.phone, organization: user.organizations };
    req.accessToken = token;
    Promise.all([
      supabase.from('access_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id),
      supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id)
    ]).catch(() => {});
    return next();
  };
}

module.exports = { accessToken, hashToken, requireAccess };
