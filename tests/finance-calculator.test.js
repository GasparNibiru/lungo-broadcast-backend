'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addMonths, buildReceivables, buildTransfers, firstLifetimeDate } = require('../src/services/finance-calculator');

test('generates 100/100/40 commission installments over the sale amount', () => {
  const installments = [100, 100, 40].map((commissionPercent, index) => ({ installmentNumber: index + 1, commissionPercent, monthOffset: index }));
  const rows = buildReceivables({ saleAmount: 1000, firstDate: '2026-10-20', installments, taxMode: 'deduct', taxPercent: 6 });
  assert.deepEqual(rows.map(row => [row.grossAmount, row.taxAmount, row.netAmount]), [[1000, 60, 940], [1000, 60, 940], [400, 24, 376]]);
  assert.deepEqual(rows.map(row => row.dueDate), ['2026-10-20', '2026-11-20', '2026-12-20']);
  assert.equal(firstLifetimeDate('2026-10-20', installments), '2027-01-20');
});

test('broker transfers are independent and may precede receivables', () => {
  const rows = buildTransfers({ saleAmount: 1000, firstDate: '2026-09-22', installments: [100, 60, 20].map((commissionPercent, index) => ({ commissionPercent, monthOffset: index })) });
  assert.deepEqual(rows.map(row => row.expectedAmount), [1000, 600, 200]);
  assert.equal(rows[0].dueDate, '2026-09-22');
});

test('records tax withheld by the operator in the net receivable', () => {
  const [row] = buildReceivables({ saleAmount:1000, firstDate:'2026-10-20', installments:[{ commissionPercent:100 }], taxMode:'withheld', taxPercent:6 });
  assert.deepEqual([row.grossAmount,row.taxAmount,row.netAmount],[1000,60,940]);
});

test('month arithmetic keeps dates valid at month end', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
});
