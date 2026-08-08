const supabase = require('../database/supabase');
const { createAdminAccess, updateAdminAccess, runUserAction, renewAdminAccessToken } = require('./admin-accesses');
const legacyBrokerAccess = require('./legacy-broker-access');

function databaseError(context, error) {
  console.error(`[SUPERVISOR DATABASE ERROR] ${context}`, error?.message || error);
  const wrapped = new Error('Erro interno no servidor.');
  wrapped.statusCode = 500;
  return wrapped;
}

async function organizationBroker(organizationId, userId) {
  const { data, error } = await supabase.from('users').select('id, organization_id, role').eq('id', userId).maybeSingle();
  if (error) throw databaseError('get broker', error);
  if (!data || data.organization_id !== organizationId || data.role !== 'broker') {
    const notFound = new Error('Corretor não encontrado nesta organização.');
    notFound.statusCode = 404;
    throw notFound;
  }
  return data;
}

async function getSupervisorDashboard(organizationId) {
  const count = (table, configure = (query) => query) => configure(supabase.from(table).select('id', { count: 'exact', head: true }).eq('organization_id', organizationId));
  const [brokers, clients, leads, sales, subscription] = await Promise.all([
    count('users', (query) => query.eq('role', 'broker').eq('status', 'active')),
    count('clients', (query) => query.eq('status', 'active')),
    count('leads'),
    supabase.from('sales').select('amount, sale_date').eq('organization_id', organizationId),
    supabase.from('subscriptions').select('status, total_price, extra_accesses, next_due_date, plans(code, name, included_supervisors, included_brokers)').eq('organization_id', organizationId).eq('status', 'active').order('started_at', { ascending: false }).limit(1).maybeSingle()
  ]);
  for (const result of [brokers, clients, leads, sales, subscription]) if (result.error) throw databaseError('dashboard', result.error);
  const month = new Date().toISOString().slice(0, 7);
  const monthSales = (sales.data || []).filter((sale) => String(sale.sale_date).startsWith(month));
  return {
    brokers: brokers.count || 0, clients: clients.count || 0, leads: leads.count || 0,
    sales: monthSales.length, revenue: monthSales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0),
    subscription: subscription.data || null
  };
}

async function listSupervisorBrokers(organizationId) {
  const { data, error } = await supabase.from('users').select('id, name, email, phone, role, status, last_login_at, created_at, access_tokens(status, expires_at, last_used_at, created_at)').eq('organization_id', organizationId).eq('role', 'broker').order('created_at', { ascending: false });
  if (error) throw databaseError('list brokers', error);
  const now = Date.now();
  return (data || []).map((broker) => ({
    id: broker.id, name: broker.name, email: broker.email, phone: broker.phone, status: broker.status,
    lastLoginAt: broker.last_login_at, createdAt: broker.created_at,
    tokenActive: (broker.access_tokens || []).some((token) => token.status === 'active' && (!token.expires_at || Date.parse(token.expires_at) > now))
  }));
}

async function createSupervisorBroker(organizationId, input) {
  return createAdminAccess({ ...input, organizationId, role: 'broker' });
}

async function updateSupervisorBroker(organizationId, userId, input) {
  await organizationBroker(organizationId, userId);
  return updateAdminAccess(userId, { ...input, role: 'broker' });
}

async function changeSupervisorBroker(organizationId, userId, action) {
  await organizationBroker(organizationId, userId);
  return runUserAction(userId, action);
}

async function renewSupervisorBrokerToken(organizationId, userId, expiresAt) {
  await organizationBroker(organizationId, userId);
  return renewAdminAccessToken(userId, expiresAt);
}

async function listSupervisorClients(organizationId) {
  const { data, error } = await supabase.from('clients').select('id, owner_user_id, name, phone, email, document_number, city, status, created_at, users!clients_owner_user_fk(name)').eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (error) throw databaseError('list clients', error);
  return data || [];
}

async function listSupervisorLeads(organizationId) {
  try { return await legacyBrokerAccess.organizationLeads(organizationId); }
  catch (error) { throw databaseError('list operational leads', error); }
}

async function listSupervisorOperationalCustomers(organizationId) {
  try { return await legacyBrokerAccess.organizationCustomers(organizationId); }
  catch (error) { throw databaseError('list operational customers', error); }
}

module.exports = { getSupervisorDashboard, listSupervisorBrokers, createSupervisorBroker, updateSupervisorBroker, changeSupervisorBroker, renewSupervisorBrokerToken, listSupervisorClients, listSupervisorLeads, listSupervisorOperationalCustomers };
