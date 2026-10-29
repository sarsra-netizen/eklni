'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { addMonths } = require('../src/engine/dates');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-sub-'));
let TODAY = '2026-10-21';
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 't.db'), today: () => TODAY, trialDays: 7, pricing: { priceEgp: 200, paymentNote: 'تحويل' } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };
}
const GOAL = { sex: 'male', age: 24, heightCm: 178, currentWeight: 82, targetWeight: 76, startDate: '2026-10-21', sport: 'fin_swimming', sessionsPerWeek: 5, minutesPerSession: 75 };

test('calendar months: end-of-month clamping (hand-checked)', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-10-21', 3), '2027-01-21');
});

test('trial → expiry locks every tool on the server; export and status stay open', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'athlete@x.test', password: 'longpass1' });
  const me = (await c('GET', '/api/me')).body;
  assert.equal(me.subscription.state, 'trial');
  assert.equal(me.subscription.endsOn, '2026-10-27'); // 7 days including today
  assert.equal(me.subscription.daysLeft, 7);
  await c('PUT', '/api/screening', { consent: true });
  assert.equal((await c('POST', '/api/goal', GOAL)).status, 201);
  TODAY = '2026-10-28';
  for (const [m, p, b] of [['GET', '/api/state'], ['GET', '/api/weekplan'], ['POST', '/api/weekplan', {}], ['GET', '/api/hydration'], ['GET', '/api/screening'],
    ['GET', '/api/report'], ['GET', '/api/nutrition-file'], ['GET', '/api/academies'], ['POST', '/api/weights', { date: '2026-10-28', weightKg: 81 }]]) {
    const r = await c(m, p, b);
    assert.equal(r.status, 402, `${m} ${p}`);
  }
  const locked = await c('GET', '/api/state');
  assert.equal(locked.body.error, 'SUBSCRIPTION_REQUIRED');
  assert.equal(locked.body.pricing.priceEgp, 200);
  assert.equal((await c('GET', '/api/subscription')).status, 200);
  assert.equal((await c('GET', '/api/me')).body.subscription.active, false);
  assert.equal((await c('GET', '/api/export.csv')).status, 200, 'users can always export their own data');
});

test('only the owner can extend or cancel; extension uses calendar months', async () => {
  const owner = client();
  const reg = await owner('POST', '/api/auth/register', { email: 'owner@eklni.test', password: 'longpass1' });
  // registering with any e-mail never makes an owner; ownership is granted from the server console only
  assert.equal((await owner('GET', '/api/me')).body.isOwner, false);
  app.db.grantOwner(reg.body.user.id); // what scripts/owner.js does
  assert.equal((await owner('GET', '/api/me')).body.isOwner, true);
  const c = client();
  await c('POST', '/api/auth/login', { email: 'athlete@x.test', password: 'longpass1' });
  // non-owner cannot see or use owner routes
  assert.equal((await c('POST', '/api/owner/subscriptions', { email: 'athlete@x.test', months: 1 })).status, 404);
  assert.equal((await owner('POST', '/api/owner/subscriptions', { email: 'athlete@x.test', months: 0 })).status, 400);
  // expired → starts today (2026-10-28) → ends 2026-11-27
  const r = await owner('POST', '/api/owner/subscriptions', { email: 'athlete@x.test', months: 1, note: 'InstaPay' });
  assert.equal(r.body.subscription.endsOn, '2026-11-27');
  assert.equal((await c('GET', '/api/state')).status, 200, 'unlocked');
  // still active → continues from the end: 2026-11-28 + 2 months − 1 day = 2027-01-27
  assert.equal((await owner('POST', '/api/owner/subscriptions', { email: 'athlete@x.test', months: 2 })).body.subscription.endsOn, '2027-01-27');
  assert.ok((await owner('GET', '/api/owner/subscriptions?email=athlete@x.test')).body.events.length >= 3);
  assert.equal((await owner('POST', '/api/owner/subscriptions/cancel', { email: 'athlete@x.test' })).status, 400);
  assert.equal((await owner('POST', '/api/owner/subscriptions/cancel', { email: 'athlete@x.test', confirm: true })).status, 200);
  assert.equal((await c('GET', '/api/state')).status, 402);
});

test('nutrition file: printable, branded by the academy, and HTML-escaped', async () => {
  TODAY = '2026-10-21';
  const owner = client();
  await owner('POST', '/api/auth/login', { email: 'owner@eklni.test', password: 'longpass1' });
  const c = client();
  await c('POST', '/api/auth/register', { email: 'doc@x.test', password: 'longpass1' });
  await c('PUT', '/api/screening', { consent: true });
  await c('POST', '/api/goal', GOAL);
  assert.equal((await c('GET', '/api/nutrition-file')).status, 400, 'needs a week plan first');
  await c('POST', '/api/weekplan', {});
  const a = (await c('POST', '/api/academies', { name: 'Aqua Fitness', displayName: '<b>x</b>' })).body.academy.id;
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  assert.equal((await c('PUT', `/api/academies/${a}/branding`, { signature: 'ك/ أحمد ربيع', logo: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400, 'SVG refused');
  assert.equal((await c('PUT', `/api/academies/${a}/branding`, { signature: 'ك/ أحمد ربيع', logo })).status, 200);
  const doc = await c('GET', '/api/nutrition-file');
  assert.equal(doc.status, 200);
  assert.match(doc.body, /ملف التغذية/);
  assert.match(doc.body, /ك\/ أحمد ربيع/);
  assert.match(doc.body, /class="wm"><img src="data:image\/png/);
  assert.match(doc.body, /@page\{size:A4/);
  assert.doesNotMatch(doc.body, /<b>x<\/b>/, 'names are escaped');
  const rep = await c('GET', '/api/report');
  assert.match(rep.body, /ك\/ أحمد ربيع/);
  // someone without that academy gets no signature
  const other = client();
  await other('POST', '/api/auth/register', { email: 'plain@x.test', password: 'longpass1' });
  await other('PUT', '/api/screening', { consent: true });
  await other('POST', '/api/goal', GOAL);
  await other('POST', '/api/weekplan', {});
  assert.doesNotMatch((await other('GET', '/api/nutrition-file')).body, /أحمد ربيع/);
  assert.equal((await other('PUT', `/api/academies/${a}/branding`, { signature: 'x' })).status, 404);
});
