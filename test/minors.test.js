'use strict';
// 0.7.0: athletes aged 12–17 may follow a weight-loss plan only with a linked guardian's recorded consent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { validateGoalInput } = require('../src/engine/validate');
const { buildPlan, MAX_DEFICIT_FRACTION_MINOR } = require('../src/engine/energy');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-minor-'));
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'm.db'), today: () => '2026-10-22', trialDays: 30, notifications: false, registerLimitPerHour: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

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
async function user(email) { const c = client(); c.id = (await c('POST', '/api/auth/register', { email, password: 'longpass1' })).body.user.id; return c; }
const GOAL = { sex: 'male', age: 14, heightCm: 165, currentWeight: 62, targetWeight: 59, startDate: '2026-10-22', sport: 'swimming', sessionsPerWeek: 5, minutesPerSession: 75 };

test('age limits: 11 rejected, 12 accepted', () => {
  assert.ok(validateGoalInput({ ...GOAL, age: 11 }).errors.age);
  assert.deepEqual(validateGoalInput({ ...GOAL, age: 12 }).errors, {});
});

test('without guardian consent a minor stays at maintenance', async () => {
  const kid = await user('kid@x.test');
  await kid('PUT', '/api/screening', { consent: true });
  const st = (await kid('POST', '/api/goal', GOAL)).body;
  assert.equal(st.hold.hold, true);
  assert.ok(st.hold.flags.some((f) => f.code === 'MINOR'));
});

test('family invite → parent links → consent lifts the hold; revoke or unlink restores it', async () => {
  const kid = await user('kid2@x.test');
  await kid('PUT', '/api/screening', { consent: true });
  const maint = (await kid('POST', '/api/goal', GOAL)).body.targets.trainingDay.kcal;
  const inv = await kid('POST', '/api/family/invite', { displayName: 'يوسف' });
  assert.equal(inv.status, 201);
  const fam = inv.body.academyId;
  const parent = await user('dad@x.test');
  const stranger = await user('stranger@x.test');
  assert.equal((await parent('POST', '/api/invites/accept', { code: inv.body.code, displayName: 'والد يوسف' })).status, 200);
  // only the linked guardian may consent, and must acknowledge the warning
  assert.equal((await stranger('PUT', `/api/academies/${fam}/minor-consent`, { athleteId: kid.id, allowWeightLoss: true, understood: true })).status, 404);
  assert.equal((await kid('PUT', `/api/academies/${fam}/minor-consent`, { athleteId: kid.id, allowWeightLoss: true, understood: true })).status, 403, 'the minor cannot consent for himself');
  assert.equal((await parent('PUT', `/api/academies/${fam}/minor-consent`, { athleteId: kid.id, allowWeightLoss: true })).status, 400);
  assert.equal((await parent('PUT', `/api/academies/${fam}/minor-consent`, { athleteId: kid.id, allowWeightLoss: true, understood: true })).status, 200);
  const st = (await kid('GET', '/api/state')).body;
  assert.equal(st.hold.hold, false);
  assert.ok(st.hold.flags.some((f) => f.code === 'MINOR_GUARDIAN_CONSENT'));
  assert.ok(st.targets.trainingDay.kcal < maint, 'a deficit now applies');
  assert.ok(st.plan.requiresProfessional, 'professional supervision is still recommended');
  // revoke
  await parent('PUT', `/api/academies/${fam}/minor-consent`, { athleteId: kid.id, allowWeightLoss: false });
  assert.equal((await kid('GET', '/api/state')).body.hold.hold, true);
  // consent again, then the guardian is removed from the family → consent no longer counts
  await parent('PUT', `/api/academies/${fam}/minor-consent`, { athleteId: kid.id, allowWeightLoss: true, understood: true });
  assert.equal((await kid('GET', '/api/state')).body.hold.hold, false);
  assert.equal((await kid('DELETE', `/api/academies/${fam}/members/${parent.id}`, { confirm: true })).status, 200);
  assert.equal((await kid('GET', '/api/state')).body.hold.hold, true);
  // audit trail without health data
  const log = app.db.auditLog(fam).map((e) => e.action);
  assert.ok(log.includes('minor_consent_on') && log.includes('minor_consent_off'));
});

test('other red flags still hold a minor even with guardian consent', () => {
  const { screen, validateScreening } = require('../src/engine/screening');
  const v = validateScreening({ consent: true, eating: ['purge'] }).value;
  assert.equal(screen(v, { age: 15, sex: 'male', guardianConsent: true }).hold, true);
  assert.equal(screen(validateScreening({ consent: true }).value, { age: 15, sex: 'male', guardianConsent: true }).hold, false);
});

test('minor limits: deficit ≤15% of needs (app rule R-W6)', () => {
  const p = { ...GOAL, weightKg: 62, intensity: 'moderate', activityLevel: 'light' };
  const plan = buildPlan(p, 2); // absurdly high request
  assert.equal(MAX_DEFICIT_FRACTION_MINOR, 0.15);
  assert.ok(plan.deficitPctOfTdee <= 15.0001, String(plan.deficitPctOfTdee));
  const adult = buildPlan({ ...p, age: 25 }, 2);
  assert.ok(adult.deficitPctOfTdee > 15);
});
