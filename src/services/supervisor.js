const supabase = require('../database/supabase');
const { createAdminAccess, updateAdminAccess, runUserAction, archiveAdminAccess, renewAdminAccessToken, resendAdminAccessEmail } = require('./admin-accesses');
const legacyBrokerAccess = require('./legacy-broker-access');
const tokenVault = require('./access-token-vault');

function databaseError(context, error) {
  console.error(`[SUPERVISOR DATABASE ERROR] ${context}`, error?.message || error);
  const wrapped = new Error('Erro interno no servidor.');
  wrapped.statusCode = 500;
  return wrapped;
}

async function organizationBroker(organizationId, userId) {
  const { data, error } = await supabase.from('users').select('id, organization_id, name, email, phone, role, status').eq('id', userId).maybeSingle();
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
  const [brokers, activeBrokerUsers, clients, leads, sales, subscription] = await Promise.all([
    count('users', (query) => query.eq('role', 'broker').eq('status', 'active')),
    supabase.from('users').select('id').eq('organization_id', organizationId).eq('role', 'broker').eq('status', 'active'),
    count('clients', (query) => query.eq('status', 'active')),
    count('leads'),
    supabase.from('sales').select('seller_user_id, amount, sale_date').eq('organization_id', organizationId),
    supabase.from('subscriptions').select('status, total_price, extra_accesses, next_due_date, plans(code, name, included_supervisors, included_brokers)').eq('organization_id', organizationId).eq('status', 'active').order('started_at', { ascending: false }).limit(1).maybeSingle()
  ]);
  for (const result of [brokers, activeBrokerUsers, clients, leads, sales, subscription]) if (result.error) throw databaseError('dashboard', result.error);
  const month = new Date().toISOString().slice(0, 7);
  const activeBrokerIds = new Set((activeBrokerUsers.data || []).map((user) => user.id));
  const monthSales = (sales.data || []).filter((sale) => activeBrokerIds.has(sale.seller_user_id) && String(sale.sale_date).startsWith(month));
  return {
    brokers: brokers.count || 0, clients: clients.count || 0, leads: leads.count || 0,
    sales: monthSales.length, revenue: monthSales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0),
    subscription: subscription.data || null
  };
}

async function listSupervisorBrokers(organizationId) {
  const [usersResult, salesResult] = await Promise.all([
    supabase.from('users').select('id, name, email, phone, role, status, last_login_at, created_at, access_tokens(status, expires_at, last_used_at, created_at)').eq('organization_id', organizationId).eq('role', 'broker').neq('status', 'inactive').order('created_at', { ascending: false }),
    supabase.from('sales').select('seller_user_id, amount, sale_date').eq('organization_id', organizationId)
  ]);
  if (usersResult.error || salesResult.error) throw databaseError('list brokers', usersResult.error || salesResult.error);
  const data = usersResult.data;
  const now = Date.now();
  const month = new Date().toISOString().slice(0, 7);
  const storedTokens = await tokenVault.all();
  return (data || []).map((broker) => {
    const tokenActive = (broker.access_tokens || []).some((token) => token.status === 'active' && (!token.expires_at || Date.parse(token.expires_at) > now));
    const brokerSales = (salesResult.data || []).filter((sale) => sale.seller_user_id === broker.id && String(sale.sale_date || '').startsWith(month));
    return {
      id: broker.id, name: broker.name, email: broker.email, phone: broker.phone, status: broker.status,
      lastLoginAt: broker.last_login_at, createdAt: broker.created_at, tokenActive,
      token: tokenActive ? storedTokens[broker.id] || null : null,
      sales: brokerSales.length,
      revenue: brokerSales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0)
    };
  });
}

async function createSupervisorBroker(organizationId, input) {
  const result = await createAdminAccess({ ...input, organizationId, role: 'broker' });
  try {
    return { ...result, emailDelivery: await resendAdminAccessEmail(result.user.user_id) };
  } catch (error) {
    // The access is already committed. An email failure must not create a duplicate on retry.
    console.error('[SUPERVISOR BROKER ACCESS EMAIL ERROR]', error.message || error);
    return { ...result, emailDelivery: { sent: false, recipient: input.email } };
  }
}

async function resendSupervisorBrokerEmail(organizationId, userId) {
  await organizationBroker(organizationId, userId);
  return resendAdminAccessEmail(userId);
}

async function updateSupervisorBroker(organizationId, userId, input) {
  await organizationBroker(organizationId, userId);
  return updateAdminAccess(userId, { ...input, role: 'broker' });
}

async function changeSupervisorBroker(organizationId, userId, action) {
  await organizationBroker(organizationId, userId);
  return runUserAction(userId, action);
}

async function archiveSupervisorBroker(organizationId, userId) {
  await organizationBroker(organizationId, userId);
  const archived = await archiveAdminAccess(userId);
  await legacyBrokerAccess.deactivate(userId);
  return archived;
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

async function importSupervisorClients(organizationId, rows) {
  const incoming = Array.isArray(rows) ? rows.slice(0, 1000) : [];
  if (!incoming.length) { const error = new Error('Envie uma lista de clientes para importar.'); error.statusCode = 400; throw error; }
  const normalized = incoming.map((row) => ({
    organization_id: organizationId,
    name: String(row.nome || row.name || '').trim(),
    phone: String(row.telefone || row.whatsapp || row.phone || '').replace(/\D/g, ''),
    email: String(row.email || '').trim() || null,
    document_number: String(row.documento || row.cpfCnpj || '').trim() || null,
    city: String(row.cidade || '').trim() || null,
    status: 'active'
  })).filter((row) => row.name && row.phone);
  if (!normalized.length) { const error = new Error('Nenhum cliente valido foi encontrado.'); error.statusCode = 400; throw error; }
  const { data: existing, error: listError } = await supabase.from('clients').select('id, phone').eq('organization_id', organizationId);
  if (listError) throw databaseError('list clients for import', listError);
  const byPhone = new Map((existing || []).map((row) => [String(row.phone || '').replace(/\D/g, ''), row.id]));
  let created = 0; let updated = 0;
  for (const row of normalized) {
    const id = byPhone.get(row.phone);
    const result = id ? await supabase.from('clients').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).eq('organization_id', organizationId) : await supabase.from('clients').insert(row).select('id').single();
    if (result.error) throw databaseError('import client', result.error);
    if (id) updated += 1; else { created += 1; byPhone.set(row.phone, result.data.id); }
  }
  return { created, updated };
}

async function listSupervisorLeads(organizationId) {
  try {
    const { data, error } = await supabase.from('users').select('id').eq('organization_id', organizationId).eq('role', 'broker').eq('status', 'active');
    if (error) throw error;
    const activeBrokerIds = new Set((data || []).map((user) => user.id));
    return (await legacyBrokerAccess.organizationLeads(organizationId)).filter((lead) => activeBrokerIds.has(lead.brokerUserId));
  }
  catch (error) { throw databaseError('list operational leads', error); }
}

async function assignSupervisorLead(organizationId, leadId, brokerUserId, supervisorUserId) {
  const broker = await organizationBroker(organizationId, brokerUserId);
  if (broker.status !== 'active') {
    const error = new Error('Escolha um corretor ativo para receber o lead.');
    error.statusCode = 409;
    throw error;
  }
  const token = await tokenVault.get(broker.id);
  if (!token) {
    const error = new Error('O token do corretor não está disponível. Renove o token antes de enviar o lead.');
    error.statusCode = 409;
    throw error;
  }
  await legacyBrokerAccess.ensure({
    id: broker.id,
    name: broker.name,
    email: broker.email,
    phone: broker.phone,
    organizationId
  }, token);
  return legacyBrokerAccess.assignOrganizationLead(organizationId, leadId, broker.id, supervisorUserId);
}

async function listSupervisorOperationalCustomers(organizationId, supervisorUserId) {
  try {
    const { data, error } = await supabase.from('users').select('id, role').eq('organization_id', organizationId).in('role', ['broker', 'supervisor']).eq('status', 'active');
    if (error) throw error;
    const allowedOwners = new Map((data || []).filter((user) => user.role === 'broker' || user.id === supervisorUserId).map((user) => [user.id, user.role]));
    return (await legacyBrokerAccess.organizationCustomers(organizationId))
      .filter((customer) => allowedOwners.has(customer.brokerUserId))
      .map((customer) => ({ ...customer, ownerRole: allowedOwners.get(customer.brokerUserId) }));
  }
  catch (error) { throw databaseError('list operational customers', error); }
}

module.exports = { getSupervisorDashboard, listSupervisorBrokers, createSupervisorBroker, resendSupervisorBrokerEmail, updateSupervisorBroker, changeSupervisorBroker, archiveSupervisorBroker, renewSupervisorBrokerToken, listSupervisorClients, importSupervisorClients, listSupervisorLeads, assignSupervisorLead, listSupervisorOperationalCustomers };
