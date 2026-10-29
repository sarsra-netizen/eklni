'use strict';
// 0.7.0: "Sign in with Google" — tested against a mocked Google (local RSA key, injected fetch). No real Google call.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const google = require('../src/google');

const CLIENT = 'test-client.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const h = b64({ alg, kid, typ: 'JWT' }); const p = b64(claims);
  return `${h}.${p}.${crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);
const claimsFor = (o) => ({ iss: 'https://accounts.google.com', aud: CLIENT, exp: now() + 600, iat: now(), email_verified: true, ...o });

// What the mocked Google returns for the next code exchange.
let nextToken = null; const exchanges = [];
const fakeFetch = async (url, init) => {
  if (url === google.JWKS_URL) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  if (url === google.TOKEN_URL) {
    const body = new URLSearchParams(init.body); exchanges.push(body);
    return new Response(JSON.stringify({ id_token: nextToken(body) }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-google-'));
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'g.db'), today: () => '2026-10-22', trialDays: 30, notifications: false, registerLimitPerHour: 100,
    googleAuth: { clientId: CLIENT, clientSecret: 'not-a-real-secret', fetch: fakeFetch } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

// Runs the whole browser round-trip; `claims(nonce)` builds the id_token Google would return.
async function googleLogin(claims, { tamperState = false } = {}) {
  const start = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const gCookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly/);
  const nonce = loc.searchParams.get('nonce');
  nextToken = () => sign(claims(nonce));
  const state = tamperState ? 'x'.repeat(loc.searchParams.get('state').length) : loc.searchParams.get('state');
  const cb = await fetch(`${base}/api/auth/google/callback?code=abc&state=${state}`, { redirect: 'manual', headers: { cookie: gCookie } });
  const sid = (cb.headers.getSetCookie().find((c) => c.startsWith('eklni_sid=')) || '').split(';')[0];
  return { location: cb.headers.get('location'), cookie: sid || null };
}
const me = async (cookie) => (await (await fetch(`${base}/api/me`, { headers: { cookie } })).json());

test('meta advertises Google only when configured', async () => {
  assert.equal((await (await fetch(`${base}/api/meta`)).json()).googleEnabled, true);
});

test('new Google user: account created, e-mail verified, trial started, no usable password, PKCE verifier sent', async () => {
  const r = await googleLogin((nonce) => claimsFor({ sub: 'g-1', email: 'Runner@Gmail.com', nonce }));
  assert.equal(r.location, '/#google=new');
  const m = await me(r.cookie);
  assert.equal(m.user.email, 'runner@gmail.com');
  assert.equal(m.emailVerified, true);
  assert.equal(m.hasPassword, false);
  assert.deepEqual(m.signInMethods, ['google']);
  assert.equal(m.subscription.active, true);
  assert.ok(exchanges.at(-1).get('code_verifier'));
  // password login can never succeed for this account
  const lg = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'runner@gmail.com', password: 'none$google' }) });
  assert.equal(lg.status, 401);
  // second login: same account
  const again = await googleLogin((nonce) => claimsFor({ sub: 'g-1', email: 'runner@gmail.com', nonce }));
  assert.equal(again.location, '/#google=ok');
  assert.equal((await me(again.cookie)).user.id, m.user.id);
  // can add a password once, then delete the account with it
  const set = (body) => fetch(`${base}/api/auth/set-password`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: again.cookie }, body: JSON.stringify(body) });
  assert.equal((await set({ password: 'short' })).status, 400);
  assert.equal((await set({ password: 'longpass1' })).status, 200);
  assert.equal((await set({ password: 'longpass2' })).status, 409);
});

test('rejected tokens: wrong audience, issuer, nonce, signature, expiry, unverified e-mail, tampered state', async () => {
  const bad = [
    (n) => claimsFor({ sub: 'x', email: 'a@x.test', nonce: n, aud: 'someone-else' }),
    (n) => claimsFor({ sub: 'x', email: 'a@x.test', nonce: n, iss: 'https://evil.example' }),
    () => claimsFor({ sub: 'x', email: 'a@x.test', nonce: 'wrong' }),
    (n) => claimsFor({ sub: 'x', email: 'a@x.test', nonce: n, exp: now() - 3600 }),
    (n) => claimsFor({ sub: 'x', email: 'a@x.test', nonce: n, email_verified: false }),
  ];
  for (const c of bad) assert.deepEqual(await googleLogin(c), { location: '/#google=failed', cookie: null });
  // signed by another key
  const start = await fetch(`${base}/api/auth/google`, { redirect: 'manual' });
  const loc = new URL(start.headers.get('location'));
  nextToken = () => sign(claimsFor({ sub: 'x', email: 'a@x.test', nonce: loc.searchParams.get('nonce') }), { key: other.privateKey });
  const cb = await fetch(`${base}/api/auth/google/callback?code=abc&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: start.headers.get('set-cookie').split(';')[0] } });
  assert.equal(cb.headers.get('location'), '/#google=failed');
  assert.deepEqual(await googleLogin((n) => claimsFor({ sub: 'x', email: 'a@x.test', nonce: n }), { tamperState: true }), { location: '/#google=failed', cookie: null });
  // callback without the flow cookie
  const noCookie = await fetch(`${base}/api/auth/google/callback?code=abc&state=abc`, { redirect: 'manual' });
  assert.equal(noCookie.headers.get('location'), '/#google=failed');
});

test('unit: alg "none" and unknown kid are rejected', async () => {
  const getKey = async (kid) => (kid === 'k1' ? jwk : null);
  const c = claimsFor({ sub: 's', email: 'a@x.test', nonce: 'n' });
  const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64(c)}.`;
  await assert.rejects(google.verifyIdToken(none, { clientId: CLIENT, nonce: 'n', getKey }), /algorithm/);
  await assert.rejects(google.verifyIdToken(sign(c, { kid: 'k9' }), { clientId: CLIENT, nonce: 'n', getKey }), /unknown key/);
  assert.equal((await google.verifyIdToken(sign(c), { clientId: CLIENT, nonce: 'n', getKey })).sub, 's');
});

test('existing password account with an UNVERIFIED e-mail: password and sessions cancelled, then linked', async () => {
  const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'squat@gmail.com', password: 'squatter1' }) });
  const squatter = reg.headers.get('set-cookie').split(';')[0];
  const r = await googleLogin((n) => claimsFor({ sub: 'g-2', email: 'squat@gmail.com', nonce: n }));
  assert.equal(r.location, '/#google=ok');
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: squatter } })).status, 401, 'old session cancelled');
  const lg = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'squat@gmail.com', password: 'squatter1' }) });
  assert.equal(lg.status, 401, 'old password cancelled');
  const m = await me(r.cookie);
  assert.equal(m.emailVerified, true);
  assert.equal(m.hasPassword, false);
});

test('existing account with a VERIFIED e-mail keeps its password when Google is linked', async () => {
  const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@gmail.com', password: 'ownerpass1' }) });
  const id = (await reg.json()).user.id;
  app.db.setEmailVerified(id);
  const r = await googleLogin((n) => claimsFor({ sub: 'g-3', email: 'owner@gmail.com', nonce: n }));
  assert.equal((await me(r.cookie)).user.id, id);
  const lg = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@gmail.com', password: 'ownerpass1' }) });
  assert.equal(lg.status, 200);
});

test('Google disabled without credentials', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-g2-'));
  const a2 = createApp({ dbPath: path.join(d2, 'x.db'), notifications: false, googleAuth: null });
  await new Promise((r) => a2.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${a2.server.address().port}`;
  try {
    assert.equal((await fetch(`${b2}/api/auth/google`, { redirect: 'manual' })).status, 404);
    assert.equal((await (await fetch(`${b2}/api/meta`)).json()).googleEnabled, false);
  } finally { a2.server.closeAllConnections(); await new Promise((r) => a2.server.close(r)); fs.rmSync(d2, { recursive: true, force: true }); }
});

test('config: Google needs both credentials and an https public URL in production', () => {
  const { checkConfig } = require('../src/config');
  assert.ok(checkConfig({ GOOGLE_CLIENT_ID: 'x' }).errors.some((e) => /GOOGLE_CLIENT_SECRET/.test(e)));
  assert.ok(checkConfig({ NODE_ENV: 'production', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }).errors.some((e) => /EKLNI_PUBLIC_URL/.test(e)));
  assert.ok(!checkConfig({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }).errors.length);
});
