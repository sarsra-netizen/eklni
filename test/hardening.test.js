'use strict';
// Failure cases and fixes from AUDIT.md (SEC-*, SCI-*). Each assertion names the finding it covers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { openDb } = require('../src/db');
const auth = require('../src/auth');
const { validateGoalInput } = require('../src/engine/validate');
const { screen, validateScreening } = require('../src/engine/screening');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-hard-'));
const dbPath = path.join(dir, 'h.db');
let app, base;

test.before(async () => {
  // SEC-6: an account created before subscriptions existed (no subscription row)
  const pre = openDb(dbPath);
  pre.createUser('legacy@x.test', auth.hashPassword('longpass1'));
  pre.close();
  app = createApp({ dbPath, today: () => '2026-10-21', trialDays: 7, registerLimitPerHour: 50 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, p, body, raw) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };
}
const GOAL = { sex: 'male', age: 24, heightCm: 178, currentWeight: 82, targetWeight: 76, startDate: '2026-10-21', sessionsPerWeek: 5, minutesPerSession: 75 };
async function ready(email) {
  const c = client();
  await c('POST', '/api/auth/register', { email, password: 'longpass1' });
  await c('PUT', '/api/screening', { consent: true });
  await c('POST', '/api/goal', GOAL);
  return c;
}

test('SEC-6: legacy accounts get a trial on upgrade instead of being locked', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { email: 'legacy@x.test', password: 'longpass1' })).status, 200);
  const me = (await c('GET', '/api/me')).body;
  assert.equal(me.subscription.active, true);
  assert.equal(me.subscription.state, 'trial');
});

test('SEC-2: non-object JSON bodies are rejected with 400, never 500', async () => {
  const c = client();
  for (const raw of ['null', '[1]', '"x"', '7', 'true']) {
    assert.equal((await c('POST', '/api/auth/register', undefined, raw)).status, 400, raw);
    assert.equal((await c('POST', '/api/auth/login', undefined, raw)).status, 400, raw);
  }
  const u = await ready('json@x.test');
  assert.equal((await u('POST', '/api/adjustments/1/decision', undefined, 'null')).status, 400);
});

test('SEC-3: password length is bounded', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/register', { email: 'long@x.test', password: 'x'.repeat(201) })).status, 400);
  assert.equal((await c('POST', '/api/auth/login', { email: 'long@x.test', password: 'x'.repeat(5000) })).status, 401);
});

test('SEC-4: throttle map is bounded and drops empty keys', () => {
  for (let i = 0; i < 10050; i++) auth.recordFailure(`k${i}`);
  assert.ok(auth.throttleSize() <= 10000);
});

test('SEC-10: registration is throttled per address', async () => {
  const a = createApp({ dbPath: path.join(dir, 'r.db'), today: () => '2026-10-21', registerLimitPerHour: 3 });
  await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${a.server.address().port}`;
  const reg = (i) => fetch(b + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `t${i}@x.test`, password: 'longpass1' }) });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await reg(i)).status);
  a.server.close();
  assert.deepEqual(codes, [201, 201, 201, 429, 429]);
});

test('SCI-7: 405 for a wrong method; 404 when deleting something that does not exist', async () => {
  const c = await ready('m@x.test');
  assert.equal((await c('PATCH', '/api/state')).status, 405);
  assert.equal((await c('DELETE', '/api/hydration/999999')).status, 404);
  assert.equal((await c('DELETE', '/api/weights/2026-01-01')).status, 404);
});

test('SCI-4: hydration dates must be real and not in the future', async () => {
  const c = await ready('h@x.test');
  assert.equal((await c('POST', '/api/hydration', { date: '2026-02-30', preKg: 70, postKg: 69.5, durationMin: 60 })).status, 400);
  assert.equal((await c('POST', '/api/hydration', { date: '2026-10-22', preKg: 70, postKg: 69.5, durationMin: 60 })).status, 400);
  assert.equal((await c('POST', '/api/hydration', { date: '2026-10-21', preKg: 70, postKg: 69.5, durationMin: 60 })).status, 201);
});

test('SCI-3: start date window is enforced on the server', async () => {
  const c = await ready('d@x.test');
  assert.equal((await c('POST', '/api/goal/preview', { ...GOAL, startDate: '1990-01-01' })).body.errors.startDate !== undefined, true);
  assert.equal((await c('POST', '/api/goal/preview', { ...GOAL, startDate: '2099-01-01' })).body.errors.startDate !== undefined, true);
  assert.equal((await c('POST', '/api/goal/preview', { ...GOAL, startDate: '2026-09-01' })).status, 200);
});

test('SCI-2: measured RMR must be plausible for the body (hand-computed Mifflin)', () => {
  // female 24 y, 150 cm, 45 kg → 10×45 + 6.25×150 − 5×24 − 161 = 1106.5 kcal
  const base = { sex: 'female', age: 24, heightCm: 150, currentWeight: 45, targetWeight: 44, startDate: '2026-10-21' };
  assert.ok(validateGoalInput({ ...base, measuredRmr: 4900 }).errors.measuredRmr, '4.4× the estimate is rejected');
  const w = validateGoalInput({ ...base, measuredRmr: 1450 }); // 1.31× → warning + professional review
  assert.equal(w.errors.measuredRmr, undefined);
  assert.ok(w.warnings.length && w.value.requiresProfessional);
  assert.equal(validateGoalInput({ ...base, measuredRmr: 1150 }).warnings.length, 0);
});

test('SCI-5 / SCI-6: no check-ins for future weeks; servings out of range are rejected, not silently changed', async () => {
  const c = await ready('w@x.test');
  assert.equal((await c('POST', '/api/checkins', { week: 5, performance: 3 })).status, 400);
  assert.equal((await c('POST', '/api/checkins', { week: 0, performance: 3 })).status, 200);
  await c('POST', '/api/weekplan', {});
  for (const servings of [1e9, -1, 0.3, 1.25, '2']) {
    assert.equal((await c('POST', '/api/weekplan/extras', { day: 0, recipeId: 'drink_mint_tea', servings })).status, 400, String(servings));
  }
  assert.equal((await c('POST', '/api/weekplan/extras', { day: 0, recipeId: 'drink_mint_tea', servings: 1.5 })).status, 200);
});

test('SCI-1: for a female athlete the menstrual question cannot be skipped', () => {
  const v = validateScreening({ consent: true }).value;
  const r = screen(v, { age: 22, sex: 'female' });
  assert.equal(r.hold, true);
  assert.ok(r.flags.some((f) => f.code === 'MENSTRUAL_UNANSWERED'));
  assert.equal(screen({ ...v, menstrual: 'not_sure' }, { age: 22, sex: 'female' }).hold, false);
  assert.equal(screen(v, { age: 22, sex: 'male' }).hold, false);
});

test('SEC-8: staff viewing an athlete does not write into the athlete history', async () => {
  const service = require('../src/service');
  const a = await ready('ro@x.test');
  const id = (await a('GET', '/api/me')).body.user.id;
  const goal = app.db.activeGoal(id);
  app.db.setProjection(id, goal.id, '2000-01-01'); // force a projection difference
  const before = app.db.adjustments(id, goal.id).length;
  service.buildState(app.db, id, '2026-10-21', { readOnly: true });
  assert.equal(app.db.activeGoal(id).lastProjection, '2000-01-01');
  assert.equal(app.db.adjustments(id, goal.id).length, before);
});
