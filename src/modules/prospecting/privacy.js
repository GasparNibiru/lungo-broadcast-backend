'use strict';
const crypto = require('node:crypto');
const FIELDS = ['cnpj','trade_name','legal_name','mobile_1','mobile_2','email','category','cnae','opened_year','company_size','city','state'];
function createOpaqueIds(key, now = Date.now) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_opaque_key');
  const aad = Buffer.from('lungo:prospecting:v2');
  return {
    issue(cnpj, userId, version) {
      if (!/^\d{14}$/.test(cnpj)) throw new Error('invalid_catalog_cnpj');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify({ cnpj, userId, version, exp: now() + 900000 })), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    },
    resolve(token, userId) {
      try {
        if (typeof token !== 'string' || token.length > 2048 || !/^[\w-]+$/.test(token)) throw new Error();
        const bytes = Buffer.from(token, 'base64url');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12, 28));
        const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
        if (value.userId !== userId || !Number.isFinite(value.exp) || value.exp <= now() || !/^\d{14}$/.test(value.cnpj)) throw new Error();
        return { cnpj: value.cnpj, version: value.version };
      } catch { throw Object.assign(new Error('Atualize a busca: a seleção expirou ou é inválida.'), { statusCode: 400, code: 'invalid_company_id' }); }
    }
  };
}
function serverOpaque() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error('operational_secret_not_configured');
  // Domain-separated stable server key; never expose or rotate the existing credential.
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('lungo-prospecting'), Buffer.from('opaque-company-id-v1'), 32));
  return createOpaqueIds(key);
}
function pick(row) { return Object.fromEntries(FIELDS.map(field => [field, row[field] ?? null])); }
function maskedPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const local = digits.startsWith('55') && [12, 13].includes(digits.length) ? digits.slice(2) : digits;
  const ddd = /^[1-9]\d{9,10}$/.test(local) ? local.slice(0, 2) : '**';
  return `(${ddd}) *****-****`;
}
function masked(row) {
  return { ...pick(row), cnpj: '**.***.***/****-**', mobile_1: maskedPhone(row.mobile_1), mobile_2: row.mobile_2 ? maskedPhone(row.mobile_2) : null, email: row.email ? '***@***' : null };
}
module.exports = { FIELDS, createOpaqueIds, serverOpaque, pick, masked };
