const supabase = require('../database/supabase');

const ORGANIZATIONS_SELECT = `
  id,
  name,
  organization_type,
  status,
  logo_url,
  created_at,
  subscriptions (
    id,
    plan_id,
    base_price,
    extra_accesses,
    extra_access_price,
    total_price,
    status,
    started_at,
    next_due_date,
    due_mode,
    fixed_due_day,
    legacy,
    created_at,
    plans (
      code,
      name
    ),
    payments (
      id,
      competence,
      due_date,
      expected_amount,
      paid_amount,
      paid_at,
      status,
      payment_method,
      created_at
    )
  )
`;

function newestFirst(left, right, field) {
  return String(right[field] || '').localeCompare(String(left[field] || ''));
}

function getCurrentSubscription(subscriptions) {
  const ordered = [...(subscriptions || [])].sort((left, right) => {
    const activeDifference = Number(right.status === 'active') - Number(left.status === 'active');
    return activeDifference || newestFirst(left, right, 'started_at') || newestFirst(left, right, 'created_at');
  });

  return ordered[0] || null;
}

function getLatestPayment(payments) {
  return [...(payments || [])]
    .sort((left, right) => newestFirst(left, right, 'competence')
      || newestFirst(left, right, 'due_date')
      || newestFirst(left, right, 'created_at'))[0] || null;
}

function mapOrganization(organization) {
  const subscription = getCurrentSubscription(organization.subscriptions);
  const payment = getLatestPayment(subscription?.payments);

  return {
    id: organization.id,
    name: organization.name,
    organization_type: organization.organization_type,
    status: organization.status,
    logo_url: organization.logo_url,
    created_at: organization.created_at,
    subscription: subscription ? {
      subscription_id: subscription.id,
      plan_id: subscription.plan_id,
      plan_code: subscription.plans?.code || null,
      plan_name: subscription.plans?.name || null,
      base_price: subscription.base_price,
      extra_accesses: subscription.extra_accesses,
      extra_access_price: subscription.extra_access_price,
      total_price: subscription.total_price,
      status: subscription.status,
      started_at: subscription.started_at,
      next_due_date: subscription.next_due_date,
      due_mode: subscription.due_mode,
      fixed_due_day: subscription.fixed_due_day,
      legacy: subscription.legacy
    } : null,
    latest_payment: payment ? {
      payment_id: payment.id,
      competence: payment.competence,
      due_date: payment.due_date,
      expected_amount: payment.expected_amount,
      paid_amount: payment.paid_amount,
      paid_at: payment.paid_at,
      status: payment.status,
      payment_method: payment.payment_method
    } : null
  };
}

async function listAdminOrganizations() {
  const { data, error } = await supabase
    .from('organizations')
    .select(ORGANIZATIONS_SELECT)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[ADMIN ORGANIZATIONS DATABASE ERROR]', {
      code: error.code,
      message: error.message
    });
    throw new Error('Failed to load organizations.');
  }

  return (data || []).map(mapOrganization);
}

module.exports = { listAdminOrganizations };
