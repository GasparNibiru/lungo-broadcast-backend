'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = name => fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', name), 'utf8');

test('finance migration applies over the operational schema without changing existing tables', async () => {
  const db = new PGlite();
  try {
    await db.exec(migration('20260804162317_initial_saas_schema.sql').replace(/create extension if not exists pgcrypto;\s*/i, ''));
    await db.exec(migration('20260918010000_supervisor_finance.sql'));
    const result = await db.query("select table_name from information_schema.tables where table_schema='public' and table_name like 'finance_%' order by table_name");
    assert.deepEqual(result.rows.map(row => row.table_name), ['finance_broker_installments','finance_broker_rules','finance_events','finance_product_installments','finance_product_rules','finance_receivables','finance_sales','finance_settings','finance_transfers']);
    const existing = await db.query("select table_name from information_schema.tables where table_schema='public' and table_name in ('clients','leads','sales') order by table_name");
    assert.deepEqual(existing.rows.map(row => row.table_name), ['clients','leads','sales']);
  } finally { await db.close(); }
});
