const supabase = require('../database/supabase');

const DUPLICATE_CODE = '23505';
const PLAN_NOT_FOUND_CODE = 'P0002';

class AdminSubscriptionError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'AdminSubscriptionError';
    this.statusCode = statusCode;
  }
}

async function createAdminSubscription(input) {
  const { data, error } = await supabase.rpc('create_admin_subscription', {
    p_organization_name: input.organizationName,
    p_responsible_name: input.responsibleName,
    p_document_number: input.documentNumber || null,
    p_email: input.email,
    p_phone: input.phone,
    p_organization_type: input.organizationType,
    p_plan_code: input.planCode,
    p_extra_accesses: input.extraAccesses,
    p_legacy: input.legacy,
    p_sale_date: input.saleDate,
    p_first_payment_date: input.firstPaymentDate,
    p_first_payment_status: input.firstPaymentStatus,
    p_due_mode: input.dueMode,
    p_fixed_due_day: input.fixedDueDay
  });

  if (error) {
    if (error.code === DUPLICATE_CODE) {
      throw new AdminSubscriptionError('Já existe uma organização com esse documento.', 409);
    }

    if (error.code === PLAN_NOT_FOUND_CODE) {
      throw new AdminSubscriptionError('Plano não encontrado ou inativo.', 400);
    }

    // Do not pass database details to the HTTP layer.
    console.error('[ADMIN SUBSCRIPTION DATABASE ERROR]', {
      code: error.code,
      message: error.message
    });
    throw new AdminSubscriptionError('Não foi possível registrar a venda.', 500);
  }

  return data;
}

module.exports = { AdminSubscriptionError, createAdminSubscription };
