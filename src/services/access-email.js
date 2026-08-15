const nodemailer = require('nodemailer');

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

function transporter() {
  return nodemailer.createTransport({
    host: required('ZOHO_SMTP_HOST'),
    port: Number(required('ZOHO_SMTP_PORT')),
    secure: String(process.env.ZOHO_SMTP_SECURE || '').toLowerCase() === 'true',
    auth: { user: required('ZOHO_SMTP_USER'), pass: required('ZOHO_SMTP_PASSWORD') }
  });
}

async function sendAccessEmail({ email, name, organizationName, planName, token }) {
  const fromName = required('ZOHO_FROM_NAME');
  const fromEmail = required('ZOHO_FROM_EMAIL');
  const accessUrl = String(process.env.LUNGO_ACCESS_URL || 'https://staging-crm.lungocorretores.com.br/').trim();
  const safeName = escapeHtml(name);
  const safeOrganization = escapeHtml(organizationName);
  const safePlan = escapeHtml(planName || 'Lungo Corretores');
  const safeToken = escapeHtml(token);
  const safeUrl = escapeHtml(accessUrl);
  const subject = 'Seu acesso à plataforma Lungo Corretores';
  const text = `Olá, ${name}!\n\nSeu acesso à plataforma Lungo Corretores foi liberado.\nConta: ${organizationName}\nPlano: ${planName || 'Lungo Corretores'}\nAcesse: ${accessUrl}\nToken: ${token}\n\nPor segurança, não compartilhe este token.\n\nLungo Corretores`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f3f6f8;font-family:Arial,sans-serif;color:#17212b"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #dfe7eb;border-radius:16px;overflow:hidden"><tr><td style="padding:24px;background:#101820;color:#fff"><strong style="font-size:22px">Lungo Corretores</strong><div style="margin-top:5px;color:#a8c6c8;font-size:13px">Seu acesso está pronto</div></td></tr><tr><td style="padding:28px"><h1 style="margin:0 0 14px;font-size:22px">Olá, ${safeName}!</h1><p style="margin:0 0 20px;line-height:1.55;color:#52616b">Seu acesso à plataforma Lungo Corretores foi liberado.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;background:#f5f8f9;border-radius:12px"><tr><td style="padding:16px"><div style="font-size:12px;color:#6b7880">Conta</div><strong>${safeOrganization}</strong><div style="margin-top:10px;font-size:12px;color:#6b7880">Plano</div><strong>${safePlan}</strong></td></tr></table><div style="margin-bottom:8px;font-size:12px;color:#6b7880">Seu token de acesso</div><div style="padding:15px;border:1px solid #33b6ad;border-radius:10px;background:#eefaf8;font-family:Consolas,monospace;font-size:18px;font-weight:bold;letter-spacing:.04em;text-align:center">${safeToken}</div><div style="padding:22px 0;text-align:center"><a href="${safeUrl}" style="display:inline-block;padding:13px 22px;border-radius:9px;background:#14a89e;color:#fff;text-decoration:none;font-weight:bold">Acessar plataforma</a></div><p style="margin:0;font-size:12px;line-height:1.5;color:#77838a">Por segurança, não compartilhe este token com outras pessoas.</p></td></tr></table></td></tr></table></body></html>`;

  const info = await transporter().sendMail({
    from: { name: fromName, address: fromEmail }, to: email, subject, text, html
  });
  return { sent: true, recipient: email, messageId: info.messageId || null };
}

module.exports = { sendAccessEmail };
