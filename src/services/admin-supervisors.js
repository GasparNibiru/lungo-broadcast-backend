const supabase = require('../database/supabase');

const PAGE_SIZE = 1000;

function throwDatabaseError(operation, error) {
  console.error('[ADMIN SUPERVISORS DATABASE ERROR]', {
    operation,
    code: error.code,
    message: error.message
  });
  throw new Error('Failed to load admin supervisors.');
}

async function loadAll(operation, createQuery) {
  const rows = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await createQuery()
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throwDatabaseError(operation, error);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return rows;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

async function getAdminSupervisors() {
  const [supervisors, brokers, activeClients, activeSubscriptions] = await Promise.all([
    loadAll('load supervisors', () =>
      supabase.from('users').select('id, name, organization_id').eq('role', 'supervisor')
    ),
    loadAll('load brokers', () =>
      supabase.from('users').select('id, organization_id').eq('role', 'broker')
    ),
    loadAll('load active clients', () =>
      supabase.from('clients').select('id, organization_id').eq('status', 'active')
    ),
    loadAll('load active subscriptions', () =>
      supabase
        .from('subscriptions')
        .select('id, organization_id, total_price')
        .eq('status', 'active')
    )
  ]);

  if (!supervisors.length) {
    return {
      summary: { supervisors: 0, brokers: 0, activeClients: 0, monthlyRevenue: 0 },
      ranking: []
    };
  }

  const brokersByOrganization = new Map();
  const clientsByOrganization = new Map();
  const subscriptionsByOrganization = new Map();
  const revenueByOrganization = new Map();

  brokers.forEach((broker) => increment(brokersByOrganization, broker.organization_id));
  activeClients.forEach((client) => increment(clientsByOrganization, client.organization_id));
  activeSubscriptions.forEach((subscription) => {
    increment(subscriptionsByOrganization, subscription.organization_id);
    increment(revenueByOrganization, subscription.organization_id, Number(subscription.total_price || 0));
  });

  const ranking = supervisors.map((supervisor) => ({
    supervisor_id: supervisor.id,
    supervisor_name: supervisor.name,
    brokers: brokersByOrganization.get(supervisor.organization_id) || 0,
    clients: clientsByOrganization.get(supervisor.organization_id) || 0,
    activeSubscriptions: subscriptionsByOrganization.get(supervisor.organization_id) || 0,
    monthlyRevenue: revenueByOrganization.get(supervisor.organization_id) || 0
  })).sort((left, right) =>
    right.monthlyRevenue - left.monthlyRevenue
    || right.clients - left.clients
    || left.supervisor_name.localeCompare(right.supervisor_name)
    || left.supervisor_id.localeCompare(right.supervisor_id)
  );

  return {
    summary: {
      supervisors: supervisors.length,
      brokers: brokers.length,
      activeClients: activeClients.length,
      monthlyRevenue: activeSubscriptions.reduce(
        (total, subscription) => total + Number(subscription.total_price || 0),
        0
      )
    },
    ranking
  };
}

module.exports = { getAdminSupervisors };
