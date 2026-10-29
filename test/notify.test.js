'use strict';
// Notifications: saving preferences is separate from delivery; delivery is idempotent; external forwarding
// needs opt-in and carries no health data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const notify = require('../src/notify');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-notify-'));
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'n.db'), today: () => '2026-10-23', trialDays: 7, notifications: false });
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
    return { status: res.status, body: await res.json() };
  };
}
const GOAL = { sex: 'male', age: 24, heightCm: 178, currentWeight: 82, targetWeight: 76, startDate: '2026-10-21', sessionsPerWeek: 5, minutesPerSession: 75 };

test('saving preferences does not send anything; validation rejects bad values', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'n1@x.test', password: 'longpass1' });
  assert.equal((await c('PUT', '/api/notifications', { weighInTime: '25:00', weeklyCheckinDay: 5 })).status, 400);
  const ok = await c('PUT', '/api/notifications', { weighInReminder: true, weighInTime: '07:00', weeklyCheckinDay: 5, weeklyCheckinReminder: true, adjustmentAlerts: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.deliveryImplemented, true);
  assert.equal((await c('GET', '/api/inbox')).body.items.length, 0, 'nothing delivered by saving');
  // external channel cannot be enabled when the platform has no gateway configured
  assert.equal((await c('PUT', '/api/notifications', { weighInTime: '07:00', weeklyCheckinDay: 5, externalChannel: true, externalAddress: '01001234567' })).status, 400);
});

test('delivery: due reminders reach the in-app inbox once (idempotent), respecting time and data', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'n2@x.test', password: 'longpass1' });
  await c('PUT', '/api/screening', { consent: true });
  await c('POST', '/api/goal', GOAL);
  await c('PUT', '/api/notifications', { weighInReminder: true, weighInTime: '07:00', weeklyCheckinDay: 5, weeklyCheckinReminder: true, adjustmentAlerts: true });
  // 06:00 → not yet due
  await app.runNotifications({ date: '2026-10-23', hhmm: '06:00', weekday: 5 }, { send: null });
  assert.equal((await c('GET', '/api/inbox')).body.items.length, 0);
  // 07:30 Friday (weekday 5) → weigh-in + weekly check-in
  await app.runNotifications({ date: '2026-10-23', hhmm: '07:30', weekday: 5 }, { send: null });
  await app.runNotifications({ date: '2026-10-23', hhmm: '07:31', weekday: 5 }, { send: null });
  const inbox = (await c('GET', '/api/inbox')).body;
  assert.deepEqual(inbox.items.map((i) => i.kind).sort(), ['weekly_checkin', 'weigh_in']);
  assert.equal(inbox.unread, 2);
  // logging today's weight means no weigh-in reminder for that day
  await c('POST', '/api/weights', { date: '2026-10-23', weightKg: 81.5 });
  const due = notify.dueFor(app.db, (await c('GET', '/api/me')).body.user.id, { date: '2026-10-23', hhmm: '08:00', weekday: 5 }, { active: true });
  assert.ok(!due.some((d) => d.kind === 'weigh_in'));
  // mark read
  assert.equal((await c('POST', `/api/inbox/${inbox.items[0].id}/read`, {})).body.unread, 1);
  assert.equal((await c('POST', '/api/inbox/999999/read', {})).status, 404);
  assert.equal((await c('POST', '/api/inbox/read-all', {})).body.unread, 0);
  // no health numbers in any message
  for (const i of inbox.items) assert.doesNotMatch(i.body + i.title, /\d+(\.\d+)?\s*(كجم|سعرة)/);
});

test('external forwarding only for opted-in users; failures are retried at most 3 times', async () => {
  const sent = [];
  const id = app.db.createUser('n3@x.test', 'scrypt$x$y');
  app.db.setNotifications(id, { ...notify.DEFAULTS, externalChannel: true, externalAddress: '01001234567' });
  app.db.addNotification(id, { kind: 'test', key: 'k1', title: 'عنوان', body: 'نص' });
  const r = await notify.runDue(app.db, { date: '2026-10-23', hhmm: '01:00', weekday: 5 }, { subOf: () => ({ active: true }), send: async (m) => { sent.push(m); } });
  assert.ok(r.forwarded >= 1);
  assert.ok(sent.some((m) => m.to === '01001234567' && m.title === 'عنوان'));
  // users who did not opt in are skipped, never sent
  assert.ok(!sent.some((m) => m.to == null));
  // failing gateway: attempts stop after MAX_ATTEMPTS
  app.db.addNotification(id, { kind: 'test', key: 'k2', title: 't2', body: 'b2' });
  let calls = 0;
  for (let i = 0; i < 5; i++) await notify.runDue(app.db, { date: '2026-10-23', hhmm: '01:00', weekday: 5 }, { subOf: () => ({ active: true }), send: async (m) => { if (m.title === 't2') { calls += 1; throw new Error('down'); } } });
  assert.equal(calls, notify.MAX_ATTEMPTS);
});

test('settings: an address is never stored without consent', () => {
  const v = notify.validateSettings({ weighInTime: '07:00', weeklyCheckinDay: 1, externalChannel: false, externalAddress: '0100' });
  assert.equal(v.value.externalAddress, null);
  assert.ok(notify.validateSettings({ weighInTime: '07:00', weeklyCheckinDay: 1, externalChannel: true, externalAddress: 'abc' }).errors.externalAddress);
});
