const supabase = require('../database/supabase');

function enabled() { return String(process.env.ASAAS_ENABLED || '').toLowerCase() === 'true'; }
function required(name) { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`Configuração Asaas ausente: ${name}.`); return value; }
function digits(value) { return String(value || '').replace(/\D/g, ''); }

async function request(path, options = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(`${required('ASAAS_BASE_URL').replace(/\/$/, '')}${path}`, { ...options, signal: controller.signal, headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'LungoCRM/1.0', access_token: required('ASAAS_API_KEY'), ...(options.headers || {}) } });
    let data = {}; try { data = await response.json(); } catch {}
    if (!response.ok) { const message = data?.errors?.map((item) => item.description).filter(Boolean).join(' ') || `Asaas HTTP ${response.status}`; const error = new Error(message); error.statusCode = response.status; throw error; }
    return data;
  } finally { clearTimeout(timeout); }
}

async function findCustomer(externalReference) {
  const result = await request(`/customers?externalReference=${encodeURIComponent(externalReference)}&limit=1`);
  return result.data?.[0] || null;
}

async function ensureCustomer(organization) {
  if (organization.asaas_customer_id) return organization.asaas_customer_id;
  let customer = await findCustomer(organization.id);
  if (!customer) customer = await request('/customers', { method: 'POST', body: JSON.stringify({ name: organization.name, cpfCnpj: digits(organization.document_number), email: organization.email, mobilePhone: digits(organization.phone), externalReference: organization.id, notificationDisabled: false }) });
  const { error } = await supabase.from('organizations').update({ asaas_customer_id: customer.id }).eq('id', organization.id);
  if (error) throw new Error('Não foi possível vincular o cliente Asaas.');
  return customer.id;
}

async function findSubscription(externalReference) {
  const result = await request(`/subscriptions?externalReference=${encodeURIComponent(externalReference)}&limit=1&includeDeleted=true`);
  return result.data?.[0] || null;
}

async function firstPayment(subscriptionId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await request(`/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=1`);
    if (result.data?.[0]) return result.data[0];
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return null;
}

async function provisionSubscription(result, input) {
  if (!enabled() || input.planCode === 'free') return { enabled: false };
  if (!digits(input.documentNumber)) throw Object.assign(new Error('CPF/CNPJ é obrigatório para gerar a cobrança.'), { statusCode: 400 });
  const organization = { ...result.organization, document_number: input.documentNumber, email: input.email, phone: input.phone };
  try {
    const customerId = await ensureCustomer(organization);
    let subscription = result.subscription.asaas_subscription_id ? { id: result.subscription.asaas_subscription_id } : await findSubscription(result.subscription.id);
    if (!subscription) subscription = await request('/subscriptions', { method: 'POST', body: JSON.stringify({ customer: customerId, billingType: 'UNDEFINED', value: Number(result.subscription.total_price), nextDueDate: input.firstPaymentDate, cycle: 'MONTHLY', description: `Plano ${result.subscription.plan_name || input.planCode} - Lungo Corretores`, externalReference: result.subscription.id }) });
    const subscriptionUpdate = await supabase.from('subscriptions').update({ asaas_subscription_id: subscription.id, asaas_status: subscription.status || 'ACTIVE', asaas_sync_status: 'synced', asaas_last_error: null, asaas_synced_at: new Date().toISOString() }).eq('id', result.subscription.id);
    if (subscriptionUpdate.error) throw new Error('Não foi possível vincular a assinatura Asaas.');
    const payment = await firstPayment(subscription.id);
    if (!payment?.id || !payment.invoiceUrl) throw new Error('O Asaas ainda não disponibilizou o link da primeira cobrança.');
    const paymentUpdate = await supabase.from('payments').update({ asaas_payment_id: payment.id, invoice_url: payment.invoiceUrl }).eq('id', result.payment.id);
    if (paymentUpdate.error) throw new Error('Não foi possível vincular a cobrança Asaas.');
    return { enabled: true, customerId, subscriptionId: subscription.id, paymentId: payment?.id || null, invoiceUrl: payment?.invoiceUrl || null, status: payment?.status || 'PENDING' };
  } catch (error) {
    await supabase.from('subscriptions').update({ asaas_sync_status: 'failed', asaas_last_error: String(error.message || 'Falha na integração').slice(0, 500), asaas_synced_at: new Date().toISOString() }).eq('id', result.subscription.id);
    return { enabled: true, pending: true, error: error.message };
  }
}

function checkoutReturnUrl(state) {
  const base = String(process.env.PUBLIC_CHECKOUT_RETURN_URL || 'https://staging-crm.lungocorretores.com.br/').trim();
  const url = new URL(base);
  url.searchParams.set('checkout', state);
  return url.toString();
}

async function createCheckout(result, input) {
  if (!enabled() || input.planCode === 'free') return { enabled: false };
  if (!digits(input.documentNumber)) throw Object.assign(new Error('CPF/CNPJ é obrigatório para gerar o checkout.'), { statusCode: 400 });
  const organization = { ...result.organization, document_number: input.documentNumber, email: input.email, phone: input.phone };
  try {
    const customerId = await ensureCustomer(organization);
    const checkout = await request('/checkouts', {
      method: 'POST',
      body: JSON.stringify({
        billingTypes: ['PIX', 'CREDIT_CARD'],
        chargeTypes: ['RECURRENT'],
        minutesToExpire: 60,
        callback: {
          successUrl: checkoutReturnUrl('success'),
          cancelUrl: checkoutReturnUrl('cancelled'),
          expiredUrl: checkoutReturnUrl('expired')
        },
        items: [{
          name: `Plano ${result.subscription.plan_name || input.planCode}`,
          description: `${Number(result.subscription.extra_accesses || 0)} acesso(s) adicional(is)`,
          quantity: 1,
          value: Number(result.subscription.total_price)
        }],
        customer: customerId,
        subscription: {
          cycle: 'MONTHLY',
          nextDueDate: `${input.firstPaymentDate} 00:00:00`
        },
        externalReference: result.subscription.id
      })
    });
    const checkoutHost = required('ASAAS_BASE_URL').includes('sandbox') ? 'https://sandbox.asaas.com' : 'https://www.asaas.com';
    const invoiceUrl = checkout.link || `${checkoutHost}/checkoutSession/show?id=${encodeURIComponent(checkout.id)}`;
    const subscriptionUpdate = await supabase.from('subscriptions').update({
      asaas_checkout_id: checkout.id,
      asaas_checkout_status: checkout.status || 'PENDING',
      asaas_checkout_url: invoiceUrl,
      asaas_sync_status: 'checkout_created',
      asaas_last_error: null,
      asaas_synced_at: new Date().toISOString()
    }).eq('id', result.subscription.id);
    if (subscriptionUpdate.error) throw new Error('Não foi possível vincular o checkout Asaas.');
    const paymentUpdate = await supabase.from('payments').update({ invoice_url: invoiceUrl }).eq('id', result.payment.id);
    if (paymentUpdate.error) throw new Error('Não foi possível vincular o endereço do checkout.');
    return { enabled: true, customerId, checkoutId: checkout.id, invoiceUrl, status: checkout.status || 'PENDING' };
  } catch (error) {
    await supabase.from('subscriptions').update({ asaas_sync_status: 'failed', asaas_last_error: String(error.message || 'Falha na integração').slice(0, 500), asaas_synced_at: new Date().toISOString() }).eq('id', result.subscription.id);
    return { enabled: true, pending: true, error: error.message };
  }
}

async function retrySubscription(subscriptionId) {
  const { data: subscription, error } = await supabase.from('subscriptions').select('*, plans(code,name), organizations(*)').eq('id', subscriptionId).single();
  if (error || !subscription) throw Object.assign(new Error('Assinatura não encontrada.'), { statusCode: 404 });
  const { data: payment } = await supabase.from('payments').select('*').eq('subscription_id', subscription.id).order('due_date', { ascending: true }).limit(1).single();
  if (!payment) throw Object.assign(new Error('Primeira cobrança interna não encontrada.'), { statusCode: 404 });
  return provisionSubscription({ organization: subscription.organizations, subscription: { ...subscription, plan_name: subscription.plans?.name }, payment }, { planCode: subscription.plans?.code, documentNumber: subscription.organizations.document_number, email: subscription.organizations.email, phone: subscription.organizations.phone, firstPaymentDate: payment.due_date });
}

module.exports = { enabled, createCheckout, provisionSubscription, retrySubscription, request };
