const crypto = require('crypto');
const supabase = require('../database/supabase');
const asaas = require('./asaas');
const tokenVault = require('./access-token-vault');
const { generateToken, hashToken, releaseArchivedEmail } = require('./admin-accesses');
const { sendAccessEmail } = require('./access-email');

const PUBLIC_PLANS = new Set(['individual', 'equipe', 'corretora10']);
const checkoutHash = (token) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');

async function create(input) {
  await releaseArchivedEmail(input.email);
  const checkoutToken = crypto.randomBytes(32).toString('base64url');
  const { data, error } = await supabase.rpc('create_public_checkout', {
    p_organization_name: input.organizationName,
    p_responsible_name: input.responsibleName,
    p_document_number: input.documentNumber,
    p_email: input.email.toLowerCase(),
    p_phone: input.phone,
    p_organization_type: input.planCode === 'individual' ? 'individual' : 'brokerage',
    p_plan_code: input.planCode,
    p_extra_accesses: input.extraAccesses,
    p_checkout_token_hash: checkoutHash(checkoutToken)
  });
  if (error) throw error;
  const billing = await asaas.provisionSubscription(data, { ...input, firstPaymentDate: new Date().toISOString().slice(0, 10) });
  return { checkoutId: data.subscription.id, checkoutToken, billing,
    plan: { code: input.planCode, name: data.subscription.plan_name || input.planCode,
      basePrice: Number(data.subscription.base_price), extraAccesses: Number(data.subscription.extra_accesses),
      totalPrice: Number(data.subscription.total_price) } };
}

async function status(checkoutId, token) {
  const { data } = await supabase.from('subscriptions')
    .select('id,activation_status,activation_error,total_price,asaas_sync_status,asaas_last_error,plans(code,name),payments(status,invoice_url)')
    .eq('id', checkoutId).eq('checkout_source', 'public').eq('checkout_token_hash', checkoutHash(token)).maybeSingle();
  if (!data) return null;
  const payment = (data.payments || []).find((item) => item.status === 'paid') || data.payments?.[0] || null;
  return { checkoutId: data.id, activationStatus: data.activation_status, paymentStatus: payment?.status || 'pending',
    invoiceUrl: payment?.invoice_url || null, totalPrice: Number(data.total_price), planName: data.plans?.name || null,
    ready: data.activation_status === 'email_sent', error: data.activation_error || data.asaas_last_error || null };
}

async function activate(subscriptionId) {
  const { data: existing } = await supabase.from('subscriptions')
    .select('id,activation_status,organizations(id,name,responsible_name,email)')
    .eq('id', subscriptionId).eq('checkout_source', 'public').maybeSingle();
  if (!existing || existing.activation_status === 'email_sent') return { skipped: true };

  let token = null;
  if (['access_created', 'email_failed'].includes(existing.activation_status)) {
    const { data: user } = await supabase.from('users').select('id').eq('organization_id', existing.organizations.id).eq('email', existing.organizations.email.toLowerCase()).maybeSingle();
    if (user) token = await tokenVault.get(user.id);
  }
  token ||= generateToken();
  const { data, error } = await supabase.rpc('activate_public_checkout_access', { p_subscription_id: subscriptionId, p_token_hash: hashToken(token) });
  if (error) throw error;
  if (!data?.user_id) return { skipped: true };
  await tokenVault.set(data.user_id, token);
  try {
    await sendAccessEmail({ email: existing.organizations.email, name: existing.organizations.responsible_name,
      organizationName: existing.organizations.name, planName: data.plan_name, token });
    await supabase.from('subscriptions').update({ activation_status: 'email_sent', activation_error: null }).eq('id', subscriptionId);
    return { activated: true, userId: data.user_id };
  } catch (errorEmail) {
    await supabase.from('subscriptions').update({ activation_status: 'email_failed', activation_error: String(errorEmail.message || errorEmail).slice(0, 500) }).eq('id', subscriptionId);
    throw errorEmail;
  }
}

module.exports = { PUBLIC_PLANS, create, status, activate };
