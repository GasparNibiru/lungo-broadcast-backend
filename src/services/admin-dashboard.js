const supabase = require('../database/supabase');

const RECENT_ORGANIZATIONS_LIMIT = 5;
const PAGE_SIZE = 1000;

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function getNextSevenDaysRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);

  return { start: toIsoDate(start), end: toIsoDate(end) };
}

function newestSubscription(subscriptions) {
  return [...(subscriptions || [])].sort((left, right) => {
    const activeDifference = Number(right.status === 'active') - Number(left.status === 'active');
    if (activeDifference) return activeDifference;

    return String(right.started_at || right.created_at || '')
      .localeCompare(String(left.started_at || left.created_at || ''));
  })[0] || null;
}

function mapRecentOrganization(organization) {
  const subscription = newestSubscription(organization.subscriptions);

  return {
    id: organization.id,
    name: organization.name,
    created_at: organization.created_at,
    plan_name: subscription?.plans?.name || null,
    status: subscription?.status || organization.status
  };
}

function throwDatabaseError(operation, error) {
  console.error('[ADMIN DASHBOARD DATABASE ERROR]', {
    operation,
    code: error.code,
    message: error.message
  });
  throw new Error('Failed to load admin dashboard.');
}

async function countRows(table, status) {
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  if (status) query = query.eq('status', status);

  const { count, error } = await query;
  if (error) throwDatabaseError(`count ${table}${status ? ` (${status})` : ''}`, error);
  return count || 0;
}

async function loadActiveSubscriptions() {
  const subscriptions = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('total_price, next_due_date')
      .eq('status', 'active')
      .range(from, from + PAGE_SIZE - 1);

    if (error) throwDatabaseError('load active subscriptions', error);
    subscriptions.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return subscriptions;
}

async function loadRecentOrganizations() {
  const { data, error } = await supabase
    .from('organizations')
    .select(`
      id,
      name,
      status,
      created_at,
      subscriptions (
        status,
        started_at,
        created_at,
        plans (name)
      )
    `)
    .order('created_at', { ascending: false })
    .limit(RECENT_ORGANIZATIONS_LIMIT);

  if (error) throwDatabaseError('load recent organizations', error);
  return (data || []).map(mapRecentOrganization);
}

async function getAdminDashboard() {
  const [
    organizations,
    activeSubscriptions,
    suspendedSubscriptions,
    cancelledSubscriptions,
    activeRows,
    recentOrganizations
  ] = await Promise.all([
    countRows('organizations'),
    countRows('subscriptions', 'active'),
    countRows('subscriptions', 'suspended'),
    countRows('subscriptions', 'cancelled'),
    loadActiveSubscriptions(),
    loadRecentOrganizations()
  ]);

  const { start, end } = getNextSevenDaysRange();
  const monthlyRevenue = activeRows.reduce(
    (total, subscription) => total + Number(subscription.total_price || 0),
    0
  );
  const expiringNext7Days = activeRows.filter((subscription) =>
    subscription.next_due_date >= start && subscription.next_due_date <= end
  ).length;

  return {
    summary: {
      organizations,
      activeSubscriptions,
      suspendedSubscriptions,
      cancelledSubscriptions,
      monthlyRevenue,
      expiringNext7Days
    },
    recentOrganizations
  };
}

module.exports = {
  getAdminDashboard,
  getNextSevenDaysRange,
  mapRecentOrganization
};
