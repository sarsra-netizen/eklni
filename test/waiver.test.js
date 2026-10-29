'use strict';
// 0.7.0: an adult may run a deficit plan on his own responsibility; minors, purging and pregnancy stay held.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { screen, validateScreening } = require('../src/engine/screening');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-waiver-'));
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'w.db'), today: () => '2026-10-22', trialDays: 30, notifications: false, registerLimitPerHour: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}
const ADULT = { sex: 'male', age: 30, heightCm: 178, currentWeight: 86, targetWeight: 80, startDate: '2026-10-22', sport: 'running', sessionsPerWeek: 4, minutesPerSession: 60 };
const ALL = { adult: true, understood: true, responsibility: true };

test('engine: waiver lifts missing screening and clearable red flags for adults only', () => {
  assert.equal(screen(null, { age: 30 }).hold, true);
  const w = screen(null, { age: 30, selfWaiver: true });
  assert.equal(w.hold, false);
  assert.ok(w.flags.some((f) => f.code === 'SELF_WAIVER_NO_SCREENING'));
  assert.equal(screen(null, { age: 16, selfWaiver: true }).hold, true, 'never for minors');
  const reds = validateScreening({ consent: true, boneStressInjury: true, conditions: ['thyroid'] }).value;
  const r = screen(reds, { age: 30, sex: 'male', selfWaiver: true });
  assert.equal(r.hold, false);
  assert.ok(r.flags.some((f) => f.code === 'SELF_WAIVER') && r.flags.some((f) => f.code === 'BONE_STRESS'), 'red flags stay visible');
  for (const extra of [{ eating: ['purge'] }, { pregnantOrBreastfeeding: true }]) {
    const s = screen(validateScreening({ consent: true, ...extra }).value, { age: 30, sex: 'female', selfWaiver: true });
    assert.equal(s.hold, true);
    assert.ok(s.flags.some((f) => f.code === 'SELF_WAIVER_BLOCKED'));
  }
});

test('API: every acknowledgement required; deficit applies; withdraw restores maintenance', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'w@x.test', password: 'longpass1' });
  const held = (await c('POST', '/api/goal', ADULT)).body;
  assert.equal(held.hold.hold, true);
  assert.equal((await c('PUT', '/api/self-waiver', { adult: true, understood: true })).status, 400);
  const ok = await c('PUT', '/api/self-waiver', ALL);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.hold.hold, false);
  assert.ok(ok.body.targets.trainingDay.kcal < held.targets.trainingDay.kcal, 'deficit now applied');
  assert.ok(ok.body.plan.nutrition.energyAvailability >= 30, 'safety floor still applies');
  const back = await c('PUT', '/api/self-waiver', { accept: false });
  assert.equal(back.body.hold.hold, true);
  assert.equal(back.body.targets.trainingDay.kcal, held.targets.trainingDay.kcal);
});

test('API: refused for under 18', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'teen@x.test', password: 'longpass1' });
  await c('POST', '/api/goal', { ...ADULT, age: 15, currentWeight: 60, targetWeight: 57, heightCm: 165 });
  assert.equal((await c('PUT', '/api/self-waiver', ALL)).status, 403);
});

test('accepting or withdrawing rebuilds an existing week plan so meals follow the new calories', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'wp@x.test', password: 'longpass1' });
  await c('POST', '/api/goal', ADULT);
  const before = (await c('POST', '/api/weekplan', {})).body.plan;
  const ok = (await c('PUT', '/api/self-waiver', ALL)).body;
  assert.equal(ok.planRefreshed, true);
  const after = (await c('GET', '/api/weekplan')).body;
  assert.equal(after.stale, null);
  assert.ok(after.plan.days[0].targets.kcal < before.days[0].targets.kcal, 'new plan uses deficit targets');
  const sum = after.plan.days.reduce((t, d) => t + d.totals.kcal, 0); const tgt = after.plan.days.reduce((t, d) => t + d.targets.kcal, 0);
  assert.ok(sum <= tgt * 1.03, `week calories ${Math.round(sum)} stay near target ${tgt}`);
  assert.equal((await c('PUT', '/api/self-waiver', { accept: false })).body.planRefreshed, true);
});

test('with the acknowledgement an adult may choose up to 0.9 kg/week (reviewer decision); never minors or pregnancy', () => {
  const { recommendRate } = require('../src/engine/rate');
  const p = { sex: 'male', age: 30, heightCm: 175, weightKg: 70, sessionsPerWeek: 3, minutesPerSession: 60, intensity: 'moderate' };
  assert.equal(recommendRate(p, '2026-10-22').allowedRangeKg[1], 0.7);
  assert.equal(recommendRate({ ...p, selfWaiver: true }, '2026-10-22').allowedRangeKg[1], 0.9);
  assert.equal(recommendRate({ ...p, selfWaiver: true, weightKg: 120 }, '2026-10-22').allowedRangeKg[1], 1.2, 'never lowers a higher cap');
  assert.ok(recommendRate({ ...p, selfWaiver: true, age: 16 }, '2026-10-22').allowedRangeKg[1] < 0.9);
  assert.ok(recommendRate({ ...p, sex: 'female', selfWaiver: true, pregnantOrBreastfeeding: true }, '2026-10-22').allowedRangeKg[1] < 0.9);
});
