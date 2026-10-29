'use strict';
const crypto = require('node:crypto');

// Password hashing with scrypt + per-user salt; opaque session tokens stored only as SHA-256 hashes.
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, test);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function newSession(db, userId) {
  db.purgeSessions(Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  db.createSession(sha256(token), userId, Date.now() + SESSION_DAYS * 86400000);
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, { secure }) {
  const attrs = [`eklni_sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_DAYS * 86400}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
const clearCookie = () => 'eklni_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';

function currentUserId(db, req) {
  const token = parseCookies(req.headers.cookie).eklni_sid;
  if (!token) return null;
  const row = db.sessionUser(sha256(token));
  return row ? row.user_id : null;
}

// In-memory throttle (per key). Bounded: empty keys are dropped and the map is capped, so it cannot grow forever.
// It resets on restart and is per-process — see SECURITY.md.
const attempts = new Map();
const MAX_KEYS = 10000;
function throttled(key, limit = 10, windowMin = 15) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < windowMin * 60000);
  if (a.length) attempts.set(key, a); else attempts.delete(key);
  return a.length >= limit;
}
function recordFailure(key) {
  if (!attempts.has(key) && attempts.size >= MAX_KEYS) attempts.delete(attempts.keys().next().value);
  (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now());
}
const throttleSize = () => attempts.size;

module.exports = { throttleSize, hashPassword, verifyPassword, newSession, sessionCookie, clearCookie, currentUserId, sha256, parseCookies, throttled, recordFailure };
