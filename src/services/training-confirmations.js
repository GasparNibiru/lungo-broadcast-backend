'use strict';
const supabase = require('../database/supabase');
const fields = 'training_id,user_id,organization_id,organization_name,user_name,user_role,confirmed_at';
const fromRow = row => ({ trainingId: row.training_id, userId: row.user_id,
  organizationId: row.organization_id, organizationName: row.organization_name, userName: row.user_name,
  userRole: row.user_role, confirmedAt: row.confirmed_at });

async function list(filters) {
  let query = supabase.from('training_confirmations').select(fields);
  if (filters.trainingId) query = query.eq('training_id', filters.trainingId);
  if (filters.userId) query = query.eq('user_id', filters.userId);
  if (filters.organizationId) query = query.eq('organization_id', filters.organizationId);
  if (filters.userRole) query = query.eq('user_role', filters.userRole);
  const { data, error } = await query.order('confirmed_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(fromRow);
}

async function confirm(trainingId, user) {
  // ON CONFLICT DO NOTHING preserves the first server-generated timestamp,
  // including concurrent clicks and retries after an ambiguous network failure.
  const { error } = await supabase.from('training_confirmations').upsert({
    training_id: trainingId, user_id: user.id, organization_id: user.organizationId,
    organization_name: user.organization?.name || null,
    user_name: user.name || 'Usuário', user_role: user.role
  }, { onConflict: 'training_id,user_id,organization_id', ignoreDuplicates: true });
  if (error) throw error;
  const rows = await list({ trainingId, userId: user.id, organizationId: user.organizationId });
  if (!rows[0]) throw new Error('Confirmação não encontrada para esta organização.');
  return rows[0];
}

module.exports = { list, confirm };
