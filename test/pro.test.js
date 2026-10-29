'use strict';
// Professional (dietitian) verification + PRO subscription, separate from the platform subscription.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-pro-'));
let TODAY = '2026-10-21';
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'p.db'), today: () => TODAY, trialDays: 7, notifications: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const c = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return c;
}
async function user(email) { const c = client(); c.id = (await c('POST', '/api/auth/register', { email, password: 'longpass1' })).body.user.id; return c; }

let owner, diet, ath, A;
test('setup: owner, academy, consenting adult athlete, dietitian', async () => {
  owner = await user('owner@x.test'); app.db.grantOwner(owner.id);
  diet = await user('rd@x.test'); ath = await user('ath@x.test');
  await ath('PUT', '/api/screening', { consent: true });
  await ath('POST', '/api/goal', { sex: 'male', age: 25, heightCm: 178, currentWeight: 82, targetWeight: 76, startDate: '2026-10-21', sessionsPerWeek: 5, minutesPerSession: 75 });
  A = (await owner('POST', '/api/academies', { name: 'Club' })).body.academy.id;
  await diet('POST', '/api/invites/accept', { code: (await owner('POST', `/api/academies/${A}/invites`, { role: 'dietitian' })).body.code });
  await ath('POST', '/api/invites/accept', { code: (await owner('POST', `/api/academies/${A}/invites`, { role: 'athlete' })).body.code });
  assert.equal((await ath('PUT', `/api/academies/${A}/sharing`, { shareHealth: true })).status, 200);
});

test('consent alone is not enough: unverified dietitian sees the coach view', async () => {
  const v = (await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).body;
  assert.equal(v.level, 'coach');
  assert.match(v.healthHidden, /موثّق/);
  assert.equal(v.targets, undefined);
});

test('apply → owner verifies → still no clinical view without an active PRO subscription', async () => {
  assert.equal((await diet('POST', '/api/pro/apply', { licenseNo: 'x', issuer: 'y' })).status, 400);
  assert.equal((await diet('POST', '/api/pro/apply', { licenseNo: 'RD-2041', issuer: 'نقابة' })).body.verification, 'pending');
  assert.equal((await diet('POST', '/api/owner/pro/decision', { email: 'rd@x.test', decision: 'verified' })).status, 404, 'not an owner');
  assert.equal((await owner('POST', '/api/owner/pro/decision', { email: 'rd@x.test', decision: 'verified', note: 'license checked by phone' })).body.verification, 'verified');
  assert.equal((await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).body.level, 'coach');
  const s = (await owner('POST', '/api/owner/pro/subscriptions', { email: 'rd@x.test', months: 1 })).body;
  assert.equal(s.subscription.endsOn, '2026-11-20');
  assert.equal(s.clinicalAccess, true);
  const v = (await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).body;
  assert.equal(v.level, 'clinical');
  assert.ok(v.targets);
});

test('the two subscriptions stay separate', async () => {
  TODAY = '2026-11-05'; // dietitian's platform trial is over, PRO still active
  assert.equal((await diet('GET', '/api/state')).status, 402, 'PRO does not unlock personal tools');
  assert.equal((await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).status, 200, 'PRO keeps team/clinical tools');
  TODAY = '2026-11-25'; // PRO expired too
  assert.equal((await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).status, 402);
  await owner('POST', '/api/owner/subscriptions', { email: 'rd@x.test', months: 1 });
  const v = (await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).body;
  assert.equal(v.level, 'coach', 'a platform subscription alone never grants the clinical view');
  // revocation removes clinical access immediately
  await owner('POST', '/api/owner/pro/subscriptions', { email: 'rd@x.test', months: 1 });
  assert.equal((await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).body.level, 'clinical');
  await owner('POST', '/api/owner/pro/decision', { email: 'rd@x.test', decision: 'revoked' });
  assert.equal((await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).body.level, 'coach');
  TODAY = '2026-10-21';
});
