'use strict';
// Security helpers that need the database or the request: shared throttle, CSRF origin check,
// one-time tokens for password reset and e-mail verification.
const crypto = require('node:crypto');
const { sha256, hashPassword } = require('./auth');

// Throttle backed by the SQLite database: survives restarts and is shared by every process that uses the
// same database file (one host). Several hosts need a network store (Redis) — see SECURITY_PLAN.md.
function dbThrottle(db, nowMs = () => Date.now()) {
  return {
    limited: (key, limit, windowMin) => db.throttleCount(key, nowMs() - windowMin * 60000) >= limit,
    hit: (key) => db.throttleAdd(key, nowMs()),
  };
}

// CSRF defence for state-changing requests (OWASP "verify origin with standard headers"), on top of
// SameSite=Strict cookies and the application/json content-type requirement.
// - Sec-Fetch-Site: cross-site → refused.
// - Origin present → its host must equal the Host header (or be listed in EKLNI_ALLOWED_ORIGINS).
function csrfCheck(req, allowedOrigins = []) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return null;
  const sfs = req.headers['sec-fetch-site'];
  if (sfs === 'cross-site') return 'cross-site request refused';
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return origin === 'null' ? 'opaque origin refused' : null;
  let host;
  try { host = new URL(origin).host; } catch { return 'bad origin'; }
  if (host === req.headers.host || allowedOrigins.includes(origin)) return null;
  return 'origin not allowed';
}

const TTL = { reset: 30 * 60000, verify: 24 * 3600000 };
function issueToken(db, userId, purpose, nowMs = Date.now()) {
  if (purpose === 'reset') db.invalidateAuthTokens(userId, 'reset'); // only the newest reset link works
  const token = crypto.randomBytes(32).toString('base64url');
  db.addAuthToken(sha256(`${purpose}:${token}`), userId, purpose, nowMs + TTL[purpose], nowMs);
  return { token, expiresInMin: Math.round(TTL[purpose] / 60000) };
}
function consumeToken(db, token, purpose, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return db.useAuthToken(sha256(`${purpose}:${token}`), purpose, nowMs);
}
function resetPassword(db, token, password, nowMs = Date.now()) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return { error: 'VALIDATION', status: 400, message: 'كلمة المرور من 8 لـ 200 حرف.' };
  const userId = consumeToken(db, token, 'reset', nowMs);
  if (!userId) return { error: 'INVALID_TOKEN', status: 400, message: 'الرابط غير صحيح أو انتهى أو اتستخدم.' };
  db.setPassword(userId, hashPassword(password));
  db.deleteSessionsFor(userId); // log out everywhere
  return { ok: true, userId };
}

module.exports = { dbThrottle, csrfCheck, issueToken, consumeToken, resetPassword, TTL };
