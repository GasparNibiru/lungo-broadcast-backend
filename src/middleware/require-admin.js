const crypto = require('crypto');

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdmin(req, res, next) {
  const expected = String(process.env.ADMIN_ACCESS_KEY || '').trim();
  const provided = String(req.get('x-admin-key') || '').trim();

  if (!expected) {
    return res.status(500).json({ ok: false, error: 'Configuração administrativa ausente.' });
  }
  if (!provided || !safeEqual(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'Não autorizado.' });
  }
  return next();
}

module.exports = requireAdmin;
module.exports.safeEqual = safeEqual;
