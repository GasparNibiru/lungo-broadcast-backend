let accessTokenCache = null;
let accountIdCache = null;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing email configuration: ${name}`);
  return value;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
}

async function zohoRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data = null;
    try { data = await response.json(); } catch (_) { /* Empty error bodies are allowed. */ }
    if (!response.ok || data?.status?.code >= 400 || data?.error) {
      const description = data?.status?.description || data?.error_description || data?.error || `HTTP ${response.status}`;
      const error = new Error(`Zoho API: ${description}`);
      error.status = response.status;
      throw error;
    }
    return data;
  } finally { clearTimeout(timeout); }
}

async function getAccessToken(forceRefresh = false) {
  if (!forceRefresh && accessTokenCache?.expiresAt > Date.now() + 60000) return accessTokenCache.value;
  const body = new URLSearchParams({
    refresh_token: required('ZOHO_OAUTH_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
    client_id: required('ZOHO_OAUTH_CLIENT_ID'),
    client_secret: required('ZOHO_OAUTH_CLIENT_SECRET')
  });
  const data = await zohoRequest('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  if (!data?.access_token) throw new Error('Zoho OAuth did not return an access token.');
  accessTokenCache = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return accessTokenCache.value;
}

async function getAccountId(accessToken) {
  if (accountIdCache) return accountIdCache;
  const fromEmail = required('ZOHO_FROM_EMAIL').toLowerCase();
  const data = await zohoRequest('https://mail.zoho.com/api/accounts', {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' }
  });
  const account = (data?.data || []).find((item) => [item.primaryEmailAddress, item.mailboxAddress]
    .some((address) => String(address || '').toLowerCase() === fromEmail));
  if (!account?.accountId) throw new Error(`Zoho Mail account not found for ${fromEmail}.`);
  accountIdCache = String(account.accountId);
  return accountIdCache;
}

function emailHtml({ name, organizationName, planName, token, accessUrl }) {
  const safeName = escapeHtml(name), safeOrganization = escapeHtml(organizationName), safePlan = escapeHtml(planName || 'Lungo Corretores'), safeToken = escapeHtml(token), safeUrl = escapeHtml(accessUrl);
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f3f6f8;font-family:Arial,sans-serif;color:#17212b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #dfe7eb;border-radius:16px;overflow:hidden"><tr><td style="padding:24px;background:#101820;color:#fff"><strong style="font-size:22px">Lungo Corretores</strong><div style="margin-top:5px;color:#a8c6c8;font-size:13px">Seu acesso está pronto</div></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 14px;font-size:22px">Olá, ${safeName}!</h1><p style="margin:0 0 20px;line-height:1.55;color:#52616b">Seu acesso à plataforma Lungo Corretores foi liberado.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;background:#f5f8f9;border-radius:12px"><tr><td style="padding:16px"><div style="font-size:12px;color:#6b7880">Conta</div><strong>${safeOrganization}</strong><div style="margin-top:10px;font-size:12px;color:#6b7880">Plano</div><strong>${safePlan}</strong></td></tr></table><div style="margin-bottom:8px;font-size:12px;color:#6b7880">Seu token de acesso</div><div style="padding:15px;border:1px solid #33b6ad;border-radius:10px;background:#eefaf8;font-family:Consolas,monospace;font-size:18px;font-weight:bold;letter-spacing:.04em;text-align:center">${safeToken}</div><div style="padding:22px 0;text-align:center"><a href="${safeUrl}" style="display:inline-block;padding:13px 22px;border-radius:9px;background:#14a89e;color:#fff;text-decoration:none;font-weight:bold">Acessar plataforma</a></div><p style="margin:0;font-size:12px;line-height:1.5;color:#77838a">Por segurança, não compartilhe este token com outras pessoas.</p></td></tr></table></td></tr></table></body></html>`;
}

async function sendAccessEmail({ email, name, organizationName, planName, token }) {
  const fromEmail = required('ZOHO_FROM_EMAIL');
  required('ZOHO_FROM_NAME');
  const accessUrl = String(process.env.LUNGO_ACCESS_URL || 'https://staging-crm.lungocorretores.com.br/').trim();
  const payload = { fromAddress: fromEmail, toAddress: email, subject: 'Seu acesso à plataforma Lungo Corretores', content: emailHtml({ name, organizationName, planName, token, accessUrl }), mailFormat: 'html', encoding: 'UTF-8' };
  let accessToken = await getAccessToken(), accountId = await getAccountId(accessToken), data;
  const send = () => zohoRequest(`https://mail.zoho.com/api/accounts/${encodeURIComponent(accountId)}/messages`, {
    method: 'POST', headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  try { data = await send(); }
  catch (error) {
    if (error.status !== 401) throw error;
    accessToken = await getAccessToken(true); accountIdCache = null; accountId = await getAccountId(accessToken); data = await send();
  }
  return { sent: true, recipient: email, messageId: data?.data?.messageId || null, provider: 'zoho-oauth' };
}

module.exports = { sendAccessEmail };
