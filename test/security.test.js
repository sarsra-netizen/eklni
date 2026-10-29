'use strict';
// Open security items from AUDIT.md §5: CSRF, password reset, e-mail verification, shared throttle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const security = require('../src/security');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-sec-'));
const dbPath = path.join(dir, 's.db');
const apps = [];
async function start(opts = {}) {
  const a = createApp({ dbPath, today: () => '2026-10-21', notifications: false, registerLimitPerHour: 100, ...opts });
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  a.base = `http://127.0.0.1:${a.server.address().port}`;
  apps.push(a);
  return a;
}
async function stop(a) {
  apps.splice(apps.indexOf(a), 1);
  a.server.closeAllConnections();
  await new Promise((r) => a.server.close(r));
}
test.after(async () => { for (const a of [...apps]) await stop(a); fs.rmSync(dir, { recursive: true, force: true }); });

function client(a) {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const res = await fetch(a.base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

test('CSRF: cross-site state changes are refused; same-origin and reads are allowed', async () => {
  process.env.EKLNI_ALLOWED_ORIGINS = 'https://app.eklni.example';
  const a = await start();
  delete process.env.EKLNI_ALLOWED_ORIGINS;
  const c = client(a);
  const host = new URL(a.base).host;
  assert.equal((await c('POST', '/api/auth/register', { email: 'csrf@x.test', password: 'longpass1' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await c('POST', '/api/auth/register', { email: 'csrf@x.test', password: 'longpass1' }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await c('POST', '/api/auth/register', { email: 'csrf@x.test', password: 'longpass1' }, { origin: 'null' })).status, 403);
  assert.equal((await c('POST', '/api/auth/register', { email: 'csrf@x.test', password: 'longpass1' }, { origin: `http://${host}`, 'sec-fetch-site': 'same-origin' })).status, 201);
  assert.equal((await c('GET', '/api/me', undefined, { origin: 'https://evil.example' })).status, 200, 'reads are not state changes');
  assert.equal((await c('PUT', '/api/screening', { consent: true }, { origin: 'https://app.eklni.example' })).status, 200, 'configured extra origin');
  assert.equal(security.csrfCheck({ method: 'POST', headers: { origin: 'not a url' } }), 'bad origin');
});

test('throttle is shared between processes using the same database and survives a restart', async () => {
  const a = apps[0];
  const b = await start();
  const reg = client(a);
  await reg('POST', '/api/auth/register', { email: 'thr@x.test', password: 'longpass1' });
  for (let i = 0; i < 10; i++) await client(i % 2 ? a : b)('POST', '/api/auth/login', { email: 'thr@x.test', password: 'wrong-pass' });
  assert.equal((await client(b)('POST', '/api/auth/login', { email: 'thr@x.test', password: 'longpass1' })).status, 429, 'failures on A count on B');
  await stop(b);
  const c2 = await start(); // "restart"
  assert.equal((await client(c2)('POST', '/api/auth/login', { email: 'thr@x.test', password: 'longpass1' })).status, 429, 'not reset by a restart');
});

test('password reset: one-time, short-lived, newest link only, logs out everywhere, no account enumeration', async () => {
  const a = apps[0];
  const u = client(a);
  const id = (await u('POST', '/api/auth/register', { email: 'reset@x.test', password: 'oldpass11' })).body.user.id;
  assert.equal((await u('GET', '/api/me')).status, 200);
  const known = await client(a)('POST', '/api/auth/reset-request', { email: 'reset@x.test' });
  const unknown = await client(a)('POST', '/api/auth/reset-request', { email: 'nobody@x.test' });
  assert.deepEqual(known.body, unknown.body, 'same answer for unknown e-mails');
  assert.equal(known.body.delivery, 'contact_admin', 'no gateway configured → owner-assisted');
  // owner-assisted link
  const owner = client(a);
  const oid = (await owner('POST', '/api/auth/register', { email: 'own@x.test', password: 'longpass1' })).body.user.id;
  assert.equal((await owner('POST', '/api/owner/reset-link', { email: 'reset@x.test' })).status, 404, 'owners only');
  a.db.grantOwner(oid);
  const first = (await owner('POST', '/api/owner/reset-link', { email: 'reset@x.test' })).body.token;
  const link = (await owner('POST', '/api/owner/reset-link', { email: 'reset@x.test' })).body.token;
  assert.equal((await client(a)('POST', '/api/auth/reset', { token: first, password: 'newpass11' })).status, 400, 'older link invalidated');
  assert.equal((await client(a)('POST', '/api/auth/reset', { token: link, password: 'short' })).status, 400);
  assert.equal((await client(a)('POST', '/api/auth/reset', { token: link, password: 'newpass11' })).status, 200);
  assert.equal((await client(a)('POST', '/api/auth/reset', { token: link, password: 'again1111' })).status, 400, 'one use');
  assert.equal((await u('GET', '/api/me')).status, 401, 'old sessions revoked');
  assert.equal((await client(a)('POST', '/api/auth/login', { email: 'reset@x.test', password: 'oldpass11' })).status, 401);
  assert.equal((await client(a)('POST', '/api/auth/login', { email: 'reset@x.test', password: 'newpass11' })).status, 200);
  // expiry (30 min)
  const { token } = security.issueToken(a.db, id, 'reset', Date.now());
  assert.equal(security.resetPassword(a.db, token, 'whatever1', Date.now() + 31 * 60000).error, 'INVALID_TOKEN');
});

test('e-mail verification: token sets the flag once; without a gateway nothing is sent', async () => {
  const a = apps[0];
  const u = client(a);
  const id = (await u('POST', '/api/auth/register', { email: 'ver@x.test', password: 'longpass1' })).body.user.id;
  assert.equal((await u('GET', '/api/me')).body.emailVerified, false);
  assert.equal((await u('POST', '/api/auth/verify-request', {})).body.sent, false);
  const { token } = security.issueToken(a.db, id, 'verify');
  assert.equal((await client(a)('POST', '/api/auth/verify', { token: 'x'.repeat(30) })).status, 400);
  assert.equal((await client(a)('POST', '/api/auth/verify', { token })).status, 200);
  assert.equal((await client(a)('POST', '/api/auth/verify', { token })).status, 400, 'one use');
  assert.equal((await u('GET', '/api/me')).body.emailVerified, true);
  // reset tokens cannot be used as verification tokens
  const r = security.issueToken(a.db, id, 'reset');
  assert.equal((await client(a)('POST', '/api/auth/verify', { token: r.token })).status, 400);
});

test('config: disk-encryption is an attestation warning, origins must be https hosts', () => {
  const { checkConfig } = require('../src/config');
  const base = { NODE_ENV: 'production', COOKIE_SECURE: '1', EKLNI_DB: '/nonexistent/x.db' };
  assert.ok(checkConfig(base).warnings.some((w) => /EKLNI_DISK_ENCRYPTION_CONFIRMED/.test(w)));
  assert.ok(!checkConfig({ ...base, EKLNI_DISK_ENCRYPTION_CONFIRMED: '1' }).warnings.some((w) => /Disk encryption/.test(w)));
  assert.ok(checkConfig({ EKLNI_ALLOWED_ORIGINS: 'http://x.example/path' }).errors.length === 1);
});
