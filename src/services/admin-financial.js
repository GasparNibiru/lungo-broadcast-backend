const supabase = require('../database/supabase');

const PAGE_SIZE = 1000;

const PAYMENTS_SELECT = `
  id,
  competence,
  due_date,
  expected_amount,
  paid_amount,
  status,
  paid_at,
  subscriptions (
    organizations (name),
    plans (name)
  )
`;

const CALENDAR_PAYMENTS_SELECT = `
  id,
  due_date,
  expected_amount,
  paid_amount,
  paid_at,
  status,
  subscriptions (
    organization_id,
    next_due_date,
    organizations (name),
    plans (name)
  )
`;

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function getFinancialDateRange(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nextSevenDays = new Date(today);
  nextSevenDays.setUTCDate(nextSevenDays.getUTCDate() + 7);

  return {
    today: toIsoDate(today),
    nextSevenDays: toIsoDate(nextSevenDays),
    monthStart: monthStart.toISOString(),
    nextMonthStart: nextMonthStart.toISOString()
  };
}

function relation(value) {
  return Array.isArray(value) ? value[0] : value;
}

function toCents(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function mapPayment(payment) {
  const subscription = relation(payment.subscriptions);
  const organization = relation(subscription?.organizations);
  const plan = relation(subscription?.plans);

  return {
    payment_id: payment.id || '',
    organization_name: organization?.name || '',
    plan_name: plan?.name || '',
    competence: payment.competence || '',
    due_date: payment.due_date || '',
    expected_amount: Number(payment.expected_amount || 0),
    paid_amount: Number(payment.paid_amount || 0),
    status: payment.status || '',
    paid_at: payment.paid_at || ''
  };
}

function mapCalendarPayment(payment) {
  const subscription = relation(payment.subscriptions);
  const organization = relation(subscription?.organizations);
  const plan = relation(subscription?.plans);

  return {
    payment_id: payment.id || '',
    organization_id: subscription?.organization_id || '',
    organization_name: organization?.name || '',
    plan_name: plan?.name || '',
    due_date: payment.due_date || '',
    expected_amount: Number(payment.expected_amount || 0),
    paid_amount: Number(payment.paid_amount || 0),
    paid_at: payment.paid_at || '',
    status: payment.status || '',
    next_due_date: subscription?.next_due_date || ''
  };
}

function getCurrentMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getCalendarMonthRange(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = monthNumber === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(monthNumber + 1).padStart(2, '0')}-01`;

  return {
    start: `${month}-01`,
    end: nextMonth
  };
}

async function loadPayments() {
  const payments = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('payments')
      .select(PAYMENTS_SELECT)
      .order('due_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('[ADMIN FINANCIAL DATABASE ERROR]', {
        code: error.code,
        message: error.message
      });
      throw new Error('Failed to load financial data.');
    }

    payments.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return payments;
}

async function loadCalendarPayments(month) {
  const payments = [];
  const range = getCalendarMonthRange(month);

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('payments')
      .select(CALENDAR_PAYMENTS_SELECT)
      .gte('due_date', range.start)
      .lt('due_date', range.end)
      .order('due_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('[ADMIN FINANCIAL CALENDAR DATABASE ERROR]', {
        code: error.code,
        message: error.message
      });
      throw new Error('Failed to load financial calendar data.');
    }

    payments.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }

  return payments;
}

async function getAdminFinancialCalendar(month) {
  const rows = await loadCalendarPayments(month);
  let expectedAmount = 0;
  let receivedAmount = 0;
  let pendingAmount = 0;
  let overdueAmount = 0;

  rows.forEach((payment) => {
    expectedAmount += toCents(payment.expected_amount);

    if (payment.status === 'paid') {
      receivedAmount += toCents(payment.paid_amount);
    } else if (payment.status === 'pending') {
      pendingAmount += toCents(payment.expected_amount);
    } else if (payment.status === 'overdue') {
      overdueAmount += toCents(payment.expected_amount);
    }
  });

  return {
    month,
    summary: {
      expectedAmount: expectedAmount / 100,
      receivedAmount: receivedAmount / 100,
      pendingAmount: pendingAmount / 100,
      overdueAmount: overdueAmount / 100
    },
    events: rows.map(mapCalendarPayment)
  };
}

async function getAdminFinancial(now = new Date()) {
  const rows = await loadPayments();
  const range = getFinancialDateRange(now);
  let receivedMonth = 0;
  let pendingAmount = 0;
  let overdueAmount = 0;
  let nextDueAmount = 0;

  rows.forEach((payment) => {
    if (
      payment.status === 'paid'
      && payment.paid_at >= range.monthStart
      && payment.paid_at < range.nextMonthStart
    ) {
      receivedMonth += toCents(payment.paid_amount);
    }

    if (payment.status === 'pending') {
      pendingAmount += toCents(payment.expected_amount);

      if (payment.due_date >= range.today && payment.due_date <= range.nextSevenDays) {
        nextDueAmount += toCents(payment.expected_amount);
      }
    }

    if (payment.status === 'overdue') {
      overdueAmount += toCents(payment.expected_amount);
    }
  });

  return {
    summary: {
      receivedMonth: receivedMonth / 100,
      pendingAmount: pendingAmount / 100,
      overdueAmount: overdueAmount / 100,
      nextDueAmount: nextDueAmount / 100
    },
    payments: rows.map(mapPayment)
  };
}

module.exports = {
  getAdminFinancial,
  getAdminFinancialCalendar,
  getCurrentMonth,
  getFinancialDateRange,
  mapPayment,
  mapCalendarPayment
};
