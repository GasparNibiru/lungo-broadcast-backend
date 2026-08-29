'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { STAGING_FILES, assertEnvironmentIsolation } = require('../src/environment-guard');

function stagingEnv(overrides = {}) {
  return {
    APP_ENV: 'staging',
    NODE_ENV: 'staging',
    SUPABASE_URL: 'https://hgqtanlzajogxrfbchrl.supabase.co',
    DATA_DIR: path.resolve('tmp', 'data-staging'),
    ...overrides
  };
}

test('allows non-staging environments without changing their configuration', () => {
  const env = { APP_ENV: 'production' };
  assert.deepEqual(assertEnvironmentIsolation(env), { environment: 'production', protected: false });
  assert.equal(env.DATA_DIR, undefined);
});

test('sets every staging persistent file inside DATA_DIR', () => {
  const env = stagingEnv();
  const result = assertEnvironmentIsolation(env);
  assert.equal(result.protected, true);
  for (const name of Object.keys(STAGING_FILES)) {
    assert.equal(path.dirname(env[name]), env.DATA_DIR);
  }
});

test('blocks the production Supabase project in staging', () => {
  const env = stagingEnv({ SUPABASE_URL: 'https://bnceclhjhgjfirubudwi.supabase.co' });
  assert.throws(() => assertEnvironmentIsolation(env), /production Supabase project/);
});

test('blocks an unexpected Supabase project in staging', () => {
  const env = stagingEnv({ SUPABASE_URL: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co' });
  assert.throws(() => assertEnvironmentIsolation(env), /expected staging Supabase project/);
});

test('blocks a staging file configured outside DATA_DIR', () => {
  const env = stagingEnv({ LEADS_FILE_PATH: path.resolve('tmp', 'production', 'leads.json') });
  assert.throws(() => assertEnvironmentIsolation(env), /LEADS_FILE_PATH must be inside DATA_DIR/);
});

test('blocks conflicting APP_ENV and NODE_ENV values', () => {
  const env = stagingEnv({ APP_ENV: 'production' });
  assert.throws(() => assertEnvironmentIsolation(env), /APP_ENV .* and NODE_ENV .* must match/);
});
