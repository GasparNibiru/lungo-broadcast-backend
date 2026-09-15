'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertOperationalTarget } = require('../src/modules/prospecting/service');

test('produção aceita só o operacional de produção, nunca staging ou empresarial', () => {
  assert.doesNotThrow(() => assertOperationalTarget({ APP_ENV: 'production', NODE_ENV: 'production', SUPABASE_URL: 'https://bnceclhjhgjfirubudwi.supabase.co' }));
  for (const ref of ['hgqtanlzajogxrfbchrl','fmktrtyahaudefcymrvm'])
    assert.throws(() => assertOperationalTarget({ APP_ENV: 'production', NODE_ENV: 'production', SUPABASE_URL: `https://${ref}.supabase.co` }), /not_authorized/);
});

test('staging continua recusando o operacional de produção', () => {
  assert.doesNotThrow(() => assertOperationalTarget({ APP_ENV: 'staging', NODE_ENV: 'staging', SUPABASE_URL: 'https://hgqtanlzajogxrfbchrl.supabase.co' }));
  assert.throws(() => assertOperationalTarget({ APP_ENV: 'staging', NODE_ENV: 'staging', SUPABASE_URL: 'https://bnceclhjhgjfirubudwi.supabase.co' }), /not_authorized/);
});
