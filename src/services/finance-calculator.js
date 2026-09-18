'use strict';

function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw Object.assign(new Error('Valor financeiro inválido.'), { statusCode: 400 });
  return Math.round((number + Number.EPSILON) * 100);
}

function amount(value) { return cents(value) / 100; }
function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw Object.assign(new Error('Percentual inválido.'), { statusCode: 400 });
  return number;
}
function percentageOf(baseCents, rate) { return Math.round(baseCents * percent(rate) / 100); }
function isoDate(value) {
  const date = new Date(`${String(value || '').slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw Object.assign(new Error('Data financeira inválida.'), { statusCode: 400 });
  return date;
}
function addMonths(value, months) {
  const date = value instanceof Date ? new Date(value) : isoDate(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + Number(months || 0));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

function buildReceivables({ saleAmount, firstDate, installments, taxMode = 'none', taxPercent = 0 }) {
  const base = cents(saleAmount);
  const taxRate = taxMode === 'none' ? 0 : percent(taxPercent);
  return installments.map((item, index) => {
    const gross = percentageOf(base, item.commissionPercent);
    const tax = percentageOf(gross, taxRate);
    const dueDate = addMonths(firstDate, item.monthOffset ?? index);
    return { entryType: 'installment', installmentNumber: item.installmentNumber ?? index + 1, competence: dueDate.slice(0, 7) + '-01', dueDate, grossAmount: gross / 100, taxPercent: taxRate, taxAmount: tax / 100, netAmount: (gross - tax) / 100 };
  });
}

function buildTransfers({ saleAmount, firstDate, installments }) {
  const base = cents(saleAmount);
  return installments.map((item, index) => {
    const dueDate = addMonths(firstDate, item.monthOffset ?? index);
    return { entryType: 'installment', installmentNumber: item.installmentNumber ?? index + 1, commissionPercent: percent(item.commissionPercent), competence: dueDate.slice(0, 7) + '-01', dueDate, expectedAmount: percentageOf(base, item.commissionPercent) / 100 };
  });
}

function firstLifetimeDate(firstDate, installments) {
  const finalOffset = Math.max(0, ...installments.map((item, index) => Number(item.monthOffset ?? index)));
  return addMonths(firstDate, finalOffset + 1);
}

module.exports = { addMonths, amount, buildReceivables, buildTransfers, cents, firstLifetimeDate, percentageOf, percent };
