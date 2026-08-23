const supabase = require('../database/supabase');
const asaas = require('./asaas');

class CancellationError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'CancellationError'; this.statusCode = statusCode; }
}

async function current(organizationId) {
  const { data, error } = await supabase.from('subscriptions')
    .select('id,status,next_due_date,asaas_subscription_id,cancellation_status,cancellation_effective_at,cancellation_requested_at,plans(name,code)')
    .eq('organization_id', organizationId).in('status', ['active', 'suspended'])
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new CancellationError('Não foi possível consultar a assinatura.', 500);
  return data;
}

async function isOrganizationOwner(organizationId, userId) {
  const { data, error } = await supabase.from('organizations').select('owner_user_id').eq('id', organizationId).maybeSingle();
  if (error) throw new CancellationError('Não foi possível validar o titular da assinatura.', 500);
  return data?.owner_user_id === userId;
}

async function requestCancellation({ organizationId, mode, requestedBy, reason }) {
  const subscription = await current(organizationId);
  if (!subscription) throw new CancellationError('Assinatura ativa não encontrada.', 404);
  if (subscription.cancellation_status === 'scheduled' && mode === 'period_end') return subscription;
  if (subscription.asaas_subscription_id) {
    try { await asaas.cancelSubscription(subscription.asaas_subscription_id); }
    catch (error) { if (error.statusCode !== 404) throw new CancellationError(`Não foi possível cancelar a recorrência no Asaas: ${error.message}`, 502); }
  }
  const { data, error } = await supabase.rpc('request_subscription_cancellation', {
    p_organization_id: organizationId, p_mode: mode, p_requested_by: requestedBy, p_reason: reason || null
  });
  if (error) throw new CancellationError(error.message === 'subscription_not_found' ? 'Assinatura ativa não encontrada.' : 'Não foi possível registrar o cancelamento.', error.message === 'subscription_not_found' ? 404 : 500);
  return data;
}

module.exports = { CancellationError, current, isOrganizationOwner, requestCancellation };
