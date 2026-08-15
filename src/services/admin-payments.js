const supabase = require('../database/supabase');

const PAGE_SIZE = 1000;
const PAYMENT_SELECT = `
  id,
  subscription_id,
  competence,
  due_date,
  expected_amount,
  paid_amount,
  paid_at,
  status,
  payment_method,
  notes,
  created_at,
  updated_at,
  subscriptions (
    organization_id,
    organizations (name),
    plans (name)
  )
`;

class AdminPaymentError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AdminPaymentError';
    this.statusCode = statusCode;
  }
}

function relation(value) {
  return Array.isArray(value) ? value[0] : value;
}

function mapPayment(row) {
  const subscription = relation(row.subscriptions);
  const organization = relation(subscription?.organizations);
  const plan = relation(subscription?.plans);

  return {
    payment_id: row.id,
    organization_id: subscription?.organization_id || '',
    organization_name: organization?.name || '',
    subscription_id: row.subscription_id,
    plan_name: plan?.name || '',
    competence: row.competence,
    due_date: row.due_date,
    expected_amount: Number(row.expected_amount || 0),
    paid_amount: Number(row.paid_amount || 0),
    paid_at: row.paid_at,
    status: row.status,
    payment_method: row.payment_method,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function mapHistory(row) {
  return {
    history_id: row.id,
    payment_id: row.payment_id,
    action: row.action,
    old_status: row.old_status,
    new_status: row.new_status,
    amount: row.amount === null ? null : Number(row.amount),
    notes: row.notes,
    created_at: row.created_at
  };
}

function databaseFailure(context, error) {
  console.error(`[${context}]`, { code: error.code, message: error.message });
  throw new AdminPaymentError('Erro interno no servidor.', 500);
}

async function getAdminPayment(paymentId) {
  const { data, error } = await supabase
    .from('payments')
    .select(PAYMENT_SELECT)
    .eq('id', paymentId)
    .maybeSingle();

  if (error) databaseFailure('ADMIN PAYMENT DATABASE ERROR', error);
  if (!data) throw new AdminPaymentError('Pagamento não encontrado.', 404);
  return mapPayment(data);
}

function rpcError(error) {
  if (error.code === 'P0002' && error.message === 'payment_not_found') {
    throw new AdminPaymentError('Pagamento não encontrado.', 404);
  }
  if (error.code === 'P0001' && error.message === 'payment_already_confirmed') {
    throw new AdminPaymentError('Este pagamento já foi confirmado com os mesmos dados.', 409);
  }
  if (error.code === '22023' || error.code === '22P02' || error.code === '22007') {
    throw new AdminPaymentError('Dados inválidos.', 400);
  }
  databaseFailure('ADMIN PAYMENT RPC ERROR', error);
}

async function updateAdminPayment(paymentId, input) {
  const has = (field) => Object.prototype.hasOwnProperty.call(input, field);
  const rpcFields = ['dueDate', 'expectedAmount', 'paymentMethod', 'notes'];
  if (rpcFields.some(has)) {
    const { error } = await supabase.rpc('update_admin_payment', {
      p_payment_id: paymentId,
      p_due_date: input.dueDate ?? null,
      p_has_due_date: has('dueDate'),
      p_expected_amount: input.expectedAmount ?? null,
      p_has_expected_amount: has('expectedAmount'),
      p_payment_method: input.paymentMethod ?? null,
      p_has_payment_method: has('paymentMethod'),
      p_notes: input.notes ?? null,
      p_has_notes: has('notes')
    });
    if (error) rpcError(error);
  }
  if (has('paidAt')) {
    const current = await getAdminPayment(paymentId);
    if (current.status !== 'paid') throw new AdminPaymentError('A data de recebimento só pode ser alterada em pagamentos confirmados.', 409);
    const { error } = await supabase.rpc('confirm_admin_payment', {
      p_payment_id: paymentId,
      p_paid_amount: current.paid_amount,
      p_paid_at: input.paidAt,
      p_payment_method: current.payment_method,
      p_has_payment_method: true,
      p_notes: current.notes,
      p_has_notes: true
    });
    if (error) rpcError(error);
  }
  return getAdminPayment(paymentId);
}

async function confirmAdminPayment(paymentId, input) {
  const has = (field) => Object.prototype.hasOwnProperty.call(input, field);
  const { error } = await supabase.rpc('confirm_admin_payment', {
    p_payment_id: paymentId,
    p_paid_amount: input.paidAmount,
    p_paid_at: input.paidAt,
    p_payment_method: input.paymentMethod ?? null,
    p_has_payment_method: has('paymentMethod'),
    p_notes: input.notes ?? null,
    p_has_notes: has('notes')
  });

  if (error) rpcError(error);
  return getAdminPayment(paymentId);
}

async function loadAll(queryFactory) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await queryFactory(from, from + PAGE_SIZE - 1);
    if (error) databaseFailure('ADMIN PAYMENT HISTORY DATABASE ERROR', error);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function getOrganizationPaymentHistory(organizationId) {
  const { data: organization, error: organizationError } = await supabase
    .from('organizations')
    .select('id, name')
    .eq('id', organizationId)
    .maybeSingle();

  if (organizationError) databaseFailure('ADMIN ORGANIZATION PAYMENT HISTORY ERROR', organizationError);
  if (!organization) throw new AdminPaymentError('Organização não encontrada.', 404);

  const { data: subscriptions, error: subscriptionsError } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('organization_id', organizationId);
  if (subscriptionsError) databaseFailure('ADMIN ORGANIZATION SUBSCRIPTIONS ERROR', subscriptionsError);

  const subscriptionIds = (subscriptions || []).map((item) => item.id);
  const paymentRows = subscriptionIds.length
    ? await loadAll((from, to) => supabase.from('payments').select(PAYMENT_SELECT)
      .in('subscription_id', subscriptionIds).order('due_date', { ascending: false }).range(from, to))
    : [];
  const paymentIds = paymentRows.map((item) => item.id);
  const historyRows = paymentIds.length
    ? await loadAll((from, to) => supabase.from('payment_history').select('*')
      .in('payment_id', paymentIds).order('created_at', { ascending: false }).range(from, to))
    : [];

  let totalExpected = 0;
  let totalPaid = 0;
  let totalPending = 0;
  let totalOverdue = 0;
  paymentRows.forEach((payment) => {
    const expected = Math.round(Number(payment.expected_amount || 0) * 100);
    const paid = Math.round(Number(payment.paid_amount || 0) * 100);
    totalExpected += expected;
    totalPaid += paid;
    if (payment.status === 'pending') totalPending += expected;
    if (payment.status === 'overdue') totalOverdue += expected;
  });

  return {
    organization,
    summary: {
      totalExpected: totalExpected / 100,
      totalPaid: totalPaid / 100,
      totalPending: totalPending / 100,
      totalOverdue: totalOverdue / 100
    },
    payments: paymentRows.map(mapPayment),
    history: historyRows.map(mapHistory)
  };
}

module.exports = {
  AdminPaymentError,
  getAdminPayment,
  updateAdminPayment,
  confirmAdminPayment,
  getOrganizationPaymentHistory,
  mapPayment,
  mapHistory
};
