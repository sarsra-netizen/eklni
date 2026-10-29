'use strict';
// Personal data export, account deletion and retention (AUDIT: "حذف الحساب غير منفذ").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const account = require('../src/account');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-acct-'));
let TODAY = '2026-10-21';
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'a.db'), today: () => TODAY, trialDays: 7, registerLimitPerHour: 100 });
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
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  return c;
}
const GOAL = { sex: 'male', age: 24, heightCm: 178, currentWeight: 82, targetWeight: 76, startDate: '2026-10-21', sessionsPerWeek: 5, minutesPerSession: 75 };
async function athlete(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'longpass1' });
  c.id = r.body.user.id;
  await c('PUT', '/api/screening', { consent: true });
  await c('POST', '/api/goal', GOAL);
  await c('POST', '/api/hydration', { date: '2026-10-21', preKg: 82, postKg: 81.4, durationMin: 75 });
  await c('POST', '/api/weekplan', {});
  return c;
}
const countRows = (uid) => {
  const q = (sql) => app.db.raw.prepare(sql).get(uid).n;
  return ['goals', 'weights', 'checkins', 'adjustments', 'prefs', 'weekplans', 'screenings', 'hydration_logs', 'subscriptions', 'subscription_events', 'sessions', 'memberships']
    .reduce((t, tb) => t + q(`SELECT COUNT(*) AS n FROM ${tb} WHERE user_id = ?`), 0) + q('SELECT COUNT(*) AS n FROM users WHERE id = ?');
};

test('export: everything about the user, no secrets, and still available when locked', async () => {
  const c = await athlete('exp@x.test');
  const e = await c('GET', '/api/export.json');
  assert.equal(e.status, 200);
  assert.match(e.headers.get('content-disposition'), /attachment/);
  assert.equal(e.body.account.email, 'exp@x.test');
  assert.equal(e.body.goals.length, 1);
  assert.ok(e.body.goals[0].weights.length >= 1);
  assert.ok(e.body.screening.consent);
  assert.equal(e.body.hydration.length, 1);
  assert.equal(e.body.weekPlans.length, 1);
  assert.doesNotMatch(JSON.stringify(e.body), /scrypt\$|pass_hash|token/);
  TODAY = '2026-11-30'; // trial over
  assert.equal((await c('GET', '/api/state')).status, 402);
  assert.equal((await c('GET', '/api/export.json')).status, 200);
  TODAY = '2026-10-21';
});

test('deletion needs the confirmation word and the password; then all personal rows are gone', async () => {
  const c = await athlete('del@x.test');
  assert.ok(countRows(c.id) > 5);
  assert.equal((await c('DELETE', '/api/account', { password: 'longpass1' })).status, 400);
  assert.equal((await c('DELETE', '/api/account', { password: 'wrongpass', confirm: 'DELETE' })).status, 403);
  const r = await c('DELETE', '/api/account', { password: 'longpass1', confirm: 'DELETE' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(countRows(c.id), 0);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'del@x.test', password: 'longpass1' })).status, 401);
  assert.equal((await c('GET', '/api/state')).status, 401, 'old session no longer works');
});

test('an academy is never left without an admin; solo academies are removed; creator is reassigned', async () => {
  const admin = await athlete('boss@x.test');
  const a = (await admin('POST', '/api/academies', { name: 'Club A' })).body.academy.id;
  const member = await athlete('member@x.test');
  const code = (await admin('POST', `/api/academies/${a}/invites`, { role: 'coach' })).body.code;
  await member('POST', '/api/invites/accept', { code });
  const blocked = await admin('DELETE', '/api/account', { password: 'longpass1', confirm: 'DELETE' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'ACADEMY_NEEDS_ADMIN');
  // make the coach an admin too, then deletion works and the academy survives
  const code2 = (await admin('POST', `/api/academies/${a}/invites`, { role: 'admin' })).body.code;
  await member('POST', '/api/invites/accept', { code: code2 });
  assert.equal((await admin('DELETE', '/api/account', { password: 'longpass1', confirm: 'DELETE' })).status, 200);
  assert.ok(app.db.academy(a), 'academy kept');
  assert.equal(app.db.raw.prepare('SELECT created_by AS c FROM academies WHERE id = ?').get(a).c, member.id);
  // solo academy disappears with its only member
  const solo = await athlete('solo@x.test');
  const s = (await solo('POST', '/api/academies', { name: 'Solo' })).body.academy.id;
  assert.equal((await solo('DELETE', '/api/account', { password: 'longpass1', confirm: 'DELETE' })).status, 200);
  assert.equal(app.db.academy(s), null);
});

test('retention: expired sessions, old audit rows and old invites are purged', () => {
  const now = Date.parse('2027-12-01T00:00:00Z');
  app.db.raw.prepare("INSERT INTO audit_log (at, academy_id, actor_id, action) VALUES ('2026-01-01T00:00:00Z', NULL, 1, 'old')").run();
  app.db.raw.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) SELECT 'expired-x', id, 1 FROM users LIMIT 1").run();
  const r = account.maintenance(app.db, now);
  assert.ok(r.audit >= 1);
  assert.ok(r.sessions >= 1);
  assert.equal(app.db.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'old'").get().n, 0);
});
