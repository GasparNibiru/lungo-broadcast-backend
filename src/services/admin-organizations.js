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
    .neq('status', 'inactive')
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

class AdminOrganizationError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AdminOrganizationError';
    this.statusCode = statusCode;
  }
}

async function updateAdminOrganization(organizationId, input) {
  const has = (field) => Object.prototype.hasOwnProperty.call(input, field);
  const { data, error } = await supabase.rpc('update_admin_organization', {
    p_organization_id: organizationId,
    p_name: input.name ?? null,
    p_has_name: has('name'),
    p_organization_type: input.organizationType ?? null,
    p_has_organization_type: has('organizationType'),
    p_status: null,
    p_has_status: false,
    p_plan_code: input.planCode ?? null,
    p_has_plan_code: has('planCode'),
    p_extra_accesses: input.extraAccesses ?? null,
    p_has_extra_accesses: has('extraAccesses'),
    p_legacy: input.legacy ?? null,
    p_has_legacy: has('legacy'),
    p_next_due_date: input.nextDueDate ?? null,
    p_has_next_due_date: has('nextDueDate'),
    p_due_mode: input.dueMode ?? null,
    p_has_due_mode: has('dueMode'),
    p_fixed_due_day: input.fixedDueDay ?? null,
    p_has_fixed_due_day: has('fixedDueDay')
  });

  if (error) {
    if (error.code === 'P0002' && error.message === 'organization_not_found') throw new AdminOrganizationError('Organização não encontrada.', 404);
    if (error.code === 'P0002' && error.message === 'plan_not_found') throw new AdminOrganizationError('Plano não encontrado.', 400);
    if (error.code === 'P0002' && error.message === 'active_subscription_not_found') throw new AdminOrganizationError('Assinatura ativa não encontrada.', 404);
    if (error.code === '22023' || error.code === '22P02') throw new AdminOrganizationError('Dados inválidos.', 400);

    console.error('[ADMIN ORGANIZATION UPDATE DATABASE ERROR]', { code: error.code, message: error.message });
    throw new AdminOrganizationError('Não foi possível atualizar a organização.', 500);
  }

  return data;
}

async function changeAdminOrganizationSubscriptionStatus(organizationId, action) {
  const { data, error } = await supabase.rpc('change_admin_organization_subscription_status', {
    p_organization_id: organizationId,
    p_action: action
  });

  if (error) {
    if (error.code === 'P0001' && error.message === 'cancelled_subscription_terminal') {
      throw new AdminOrganizationError('Assinatura cancelada não pode ser reativada.', 409);
    }
    if (error.code === 'P0002' && error.message === 'organization_not_found') {
      throw new AdminOrganizationError('Organização não encontrada.', 404);
    }
    if (error.code === 'P0002' && error.message === 'subscription_not_found') {
      throw new AdminOrganizationError(
        action === 'reactivate'
          ? 'Não é possível reativar uma organização sem assinatura.'
          : 'Organização sem assinatura para esta operação.',
        action === 'reactivate' ? 409 : 400
      );
    }
    if (error.code === '22023' || error.code === '22P02') {
      throw new AdminOrganizationError('Estado inválido para esta operação.', 400);
    }

    console.error('[ADMIN ORGANIZATION STATUS DATABASE ERROR]', { code: error.code, message: error.message });
    throw new AdminOrganizationError('Não foi possível alterar o status.', 500);
  }

  return data;
}

module.exports = {
  AdminOrganizationError,
  listAdminOrganizations,
  updateAdminOrganization,
  changeAdminOrganizationSubscriptionStatus
};
