'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { addDays } = require('../src/engine/dates');

let TODAY = '2026-10-29';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-test-'));
const dbPath = path.join(dir, 'test.db');
let app, base;

test.before(async () => {
  app = createApp({ dbPath, today: () => TODAY, trialDays: 3650 }); // subscriptions are tested in subscription.test.js
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
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
}

const GOAL = { sex: 'female', age: 22, heightCm: 168, currentWeight: 66, targetWeight: 62, bodyFatPct: 26, bodyFatMethod: 'skinfold',
  startDate: '2026-10-01', sport: 'fin_swimming', sessionsPerWeek: 6, minutesPerSession: 90, intensity: 'moderate', activityLevel: 'light', primaryGoal: 'preserve_muscle' };

const CLEAR = { consent: true, menstrual: 'regular', eating: [], conditions: [], impairment: 'none' };

test('auth is required and sessions are HttpOnly', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/state')).status, 401);
  const r = await c('POST', '/api/auth/register', { email: 'Swimmer@Example.com', password: 'longpass1' });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await c('POST', '/api/auth/register', { email: 'swimmer@example.com', password: 'longpass1' })).status, 409);
  assert.equal((await client()('POST', '/api/auth/login', { email: 'swimmer@example.com', password: 'wrongpass' })).status, 401);
  assert.equal((await c('GET', '/api/state')).body.goal, null);
});

test('rejects non-JSON bodies and invalid goal input', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'v@example.com', password: 'longpass1' });
  const raw = await fetch(base + '/api/goal', { method: 'POST', headers: { cookie: '' }, body: 'x' });
  assert.equal(raw.status, 401);
  const bad = await c('POST', '/api/goal', { ...GOAL, targetWeight: 70 });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.targetWeight);
  const unsafeRate = await c('POST', '/api/goal/preview', { ...GOAL, weeklyRateKg: 1.5 });
  assert.equal(unsafeRate.status, 400);
  assert.equal(unsafeRate.body.error, 'RATE_ABOVE_SAFE');
});

test('goal, weights and check-ins persist and are retrieved; other users cannot see them', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'a@example.com', password: 'longpass1' });
  const created = await c('POST', '/api/goal', GOAL);
  assert.equal(created.status, 201);
  assert.equal(created.body.goal.targetWeight, 62);
  assert.ok(created.body.plan.nutrition.trainingDay.kcal > 0);

  // 4 weeks of weigh-ins: −0.45 kg/week
  TODAY = '2026-10-29';
  for (let w = 0; w < 4; w++) for (const d of [1, 3, 5]) {
    const date = addDays('2026-10-01', w * 7 + d);
    const r = await c('POST', '/api/weights', { date, weightKg: +(66 - 0.45 * (w + d / 7)).toFixed(2) });
    assert.equal(r.status, 200);
  }
  assert.equal((await c('POST', '/api/weights', { date: '2026-12-01', weightKg: 60 })).status, 400); // future date
  const ck = await c('POST', '/api/checkins', { week: 3, waistCm: 74, adherencePct: 90, performance: 4, hunger: 2, energy: 4, sleep: 4, recovery: 4 });
  assert.equal(ck.status, 200);

  // Re-open the database through a fresh app instance: data must still be there.
  const app2 = createApp({ dbPath, today: () => TODAY });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const login = await fetch(`http://127.0.0.1:${app2.server.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'longpass1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const st = await (await fetch(`http://127.0.0.1:${app2.server.address().port}/api/state`, { headers: { cookie } })).json();
  app2.server.close();
  assert.equal(st.rows.length, 4);
  assert.equal(st.rows[3].waistCm, 74);
  assert.equal(st.weights.length, 13); // 12 + start-date weight
  assert.equal(st.timeline.projection.basis, 'trend');

  // Another user sees nothing
  const other = client();
  await other('POST', '/api/auth/register', { email: 'b@example.com', password: 'longpass1' });
  assert.equal((await other('GET', '/api/state')).body.goal, null);
  assert.equal((await other('POST', '/api/weights', { date: '2026-10-10', weightKg: 70 })).body.error, 'NO_GOAL');
});

test('adjustment proposal must be accepted by the user and is logged', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'adj@example.com', password: 'longpass1' });
  await c('PUT', '/api/screening', CLEAR);
  await c('POST', '/api/goal', { ...GOAL, sessionsPerWeek: 3, minutesPerSession: 60 });
  TODAY = '2026-10-29';
  // fast loss with poor recovery
  for (let w = 0; w < 4; w++) for (const d of [1, 3, 5]) await c('POST', '/api/weights', { date: addDays('2026-10-01', w * 7 + d), weightKg: +(66 - 1.0 * (w + d / 7)).toFixed(2) });
  await c('POST', '/api/checkins', { week: 3, adherencePct: 95, hunger: 5, energy: 2, performance: 2, sleep: 3, recovery: 2 });
  const before = (await c('GET', '/api/state')).body;
  const ev = await c('POST', '/api/adjustments/evaluate');
  assert.equal(ev.body.evaluation.action, 'increase_energy');
  assert.ok(ev.body.proposalId);
  // nothing applied yet
  assert.equal(ev.body.state.goal.calorieAdjustment, 0);
  assert.equal(ev.body.state.targets.trainingDay.kcal, before.targets.trainingDay.kcal);
  const acc = await c('POST', `/api/adjustments/${ev.body.proposalId}/decision`, { decision: 'accepted' });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.goal.calorieAdjustment, ev.body.evaluation.kcalChange);
  assert.equal(acc.body.targets.trainingDay.kcal, before.targets.trainingDay.kcal + ev.body.evaluation.kcalChange);
  const logged = acc.body.adjustments.find((a) => a.id === ev.body.proposalId);
  assert.equal(logged.status, 'accepted');
  assert.ok(logged.decidedAt && logged.reasons.length);
  // cannot decide twice; cannot decide another user's proposal
  assert.equal((await c('POST', `/api/adjustments/${ev.body.proposalId}/decision`, { decision: 'rejected' })).status, 404);
  const other = client();
  await other('POST', '/api/auth/register', { email: 'adj2@example.com', password: 'longpass1' });
  await other('POST', '/api/goal', GOAL);
  assert.equal((await other('POST', `/api/adjustments/${ev.body.proposalId}/decision`, { decision: 'accepted' })).status, 404);
});

test('recalculation after weight change, notifications prefs, report and CSV export', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'r@example.com', password: 'longpass1' });
  await c('POST', '/api/goal', { ...GOAL, currentWeight: 80, targetWeight: 70, bodyFatPct: 32 });
  TODAY = '2026-11-20';
  for (let w = 0; w < 7; w++) for (const d of [1, 4]) await c('POST', '/api/weights', { date: addDays('2026-10-01', w * 7 + d), weightKg: +(80 - 0.5 * (w + d / 7)).toFixed(2) });
  const st = (await c('GET', '/api/state')).body;
  assert.equal(st.recalcSuggested, true);
  const rc = await c('POST', '/api/goal/recalculate');
  assert.equal(rc.status, 200);
  assert.ok(rc.body.plan.nutrition.needs.tdeeAvg < st.plan.nutrition.needs.tdeeAvg);
  assert.ok(rc.body.adjustments.some((a) => a.kind === 'recalc'));

  const n = await c('PUT', '/api/notifications', { weighInReminder: true, weighInTime: '06:30', weeklyCheckinDay: 5, weeklyCheckinReminder: false, adjustmentAlerts: true });
  assert.equal(n.body.settings.weighInTime, '06:30');
  assert.equal(n.body.deliveryImplemented, true); // changed in 0.5.0: delivery is now implemented (in-app inbox)
  assert.equal((await c('GET', '/api/notifications')).body.settings.weeklyCheckinReminder, false);

  const rep = await c('GET', '/api/report');
  assert.equal(rep.status, 200);
  assert.match(rep.body, /أكلني/);
  assert.match(rep.body, /<svg/);
  const csv = await c('GET', '/api/export.csv');
  assert.match(csv.body.split('\n')[0], /week,from,to,avgWeight/);
  assert.equal(csv.body.trim().split('\n').length, 1 + rc.body.rows.length);
});

test('static files are served and path traversal is blocked', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /dir="rtl"/);
  assert.equal((await fetch(base + '/..%2fpackage.json')).status, 404);
  assert.equal((await fetch(base + '/../src/db.js')).status, 404);
});

test('recipes endpoint lists the library', async () => {
  const r = await (await fetch(base + '/api/recipes')).json();
  assert.equal(r.recipes.length, 311);
  assert.ok(r.recipes.every((x) => x.perServing.kcal > 0));
});

test('preferences and weekly plan persist; swap and staleness work', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'wp@example.com', password: 'longpass1' });
  assert.equal((await c('GET', '/api/weekplan')).body.error, 'NO_GOAL');
  await c('POST', '/api/goal', GOAL);
  const g0 = await c('GET', '/api/weekplan');
  assert.equal(g0.body.plan, null);
  assert.equal(g0.body.hasSavedPrefs, false);
  const bad = await c('PUT', '/api/prefs', { mealsPerDay: 12 });
  assert.equal(bad.status, 400);
  const ok = await c('PUT', '/api/prefs', { proteins: { fish: 2, beef: -1 }, mealsPerDay: 5, trainingTime: 'evening', trainingDays: [6, 0, 2] });
  assert.equal(ok.status, 200);
  assert.equal((await c('GET', '/api/prefs')).body.prefs.mealsPerDay, 5);
  const made = await c('POST', '/api/weekplan');
  assert.equal(made.status, 200);
  assert.equal(made.body.plan.days.length, 7);
  assert.equal(made.body.stale, null);
  const lunch = made.body.plan.days[1].meals.find((m) => m.slot === 'lunch');
  const sw = await c('POST', '/api/weekplan/swap', { day: 1, slot: lunch.idx });
  assert.notEqual(sw.body.plan.days[1].meals.find((m) => m.idx === lunch.idx).recipeId, lunch.recipeId);
  assert.equal((await c('POST', '/api/weekplan/swap', { day: 'x', slot: 0 })).status, 400);
  await c('PUT', '/api/prefs', { proteins: { fish: 2, beef: -1 }, mealsPerDay: 4 });
  assert.equal((await c('GET', '/api/weekplan')).body.stale, 'prefs');
  const other = client();
  await other('POST', '/api/auth/register', { email: 'wp2@example.com', password: 'longpass1' });
  await other('POST', '/api/goal', GOAL);
  assert.equal((await other('GET', '/api/weekplan')).body.plan, null);
});

test('extras, season phase and championship endpoints', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'feat@example.com', password: 'longpass1' });
  await c('POST', '/api/goal', GOAL);
  await c('PUT', '/api/prefs', { schedule: { 6: [{ start: '07:00', duration: 90 }, { start: '17:00', duration: 90 }] }, wakeTime: '06:00', sleepTime: '22:30' });
  const made = await c('POST', '/api/weekplan');
  assert.equal(made.status, 200);
  assert.ok(made.body.plan.days.every((d) => d.meals.every((m) => /^\d\d:\d\d$/.test(m.time))));
  const add = await c('POST', '/api/weekplan/extras', { day: 0, recipeId: 'drink_orange_fresh', servings: 1 });
  assert.equal(add.status, 200);
  const entry = add.body.plan.days[0].added[0];
  assert.ok(entry);
  const del = await c('DELETE', `/api/weekplan/extras/0/${entry.id}`);
  assert.equal(del.body.plan.days[0].added.length, 0);
  assert.equal((await c('POST', '/api/weekplan/extras', { day: 0, recipeId: 'nope' })).status, 400);
  const season = await c('PUT', '/api/goal/season', { seasonPhase: 'in_season' });
  assert.equal(season.status, 200);
  assert.equal(season.body.goal.input.seasonPhase, 'in_season');
  assert.equal((await c('GET', '/api/weekplan')).body.stale, 'targets');
  const comp = await c('PUT', '/api/competition', { name: 'بطولة', raceDurationMin: 3, days: [{ date: '2026-12-05', races: ['10:00', '16:00'] }] });
  assert.equal(comp.status, 200);
  assert.equal(comp.body.competition.plan.days.length, 4);
  assert.ok((await c('GET', '/api/weekplan')).body.competitionDates.includes('2026-12-05'));
  assert.equal((await c('PUT', '/api/competition', { days: [] })).status, 400);
  assert.equal((await c('DELETE', '/api/competition')).body.competition, null);
});

test('safety hold: no screening → maintenance; clear screening → deficit; red flag → maintenance + referral', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'hold@example.com', password: 'longpass1' });
  const st0 = (await c('POST', '/api/goal', GOAL)).body;
  assert.equal(st0.hold.hold, true);
  assert.equal(st0.targets.maintenanceHold, true);
  const maintTrain = st0.targets.trainingDay.kcal;
  // consent is required
  assert.equal((await c('PUT', '/api/screening', { ...CLEAR, consent: false })).status, 400);
  const sc = await c('PUT', '/api/screening', CLEAR);
  assert.equal(sc.status, 200);
  assert.equal(sc.body.result.deficitAllowed, true);
  const st1 = (await c('GET', '/api/state')).body;
  assert.equal(st1.hold.hold, false);
  assert.ok(st1.targets.trainingDay.kcal < maintTrain, 'deficit applies only after a clear screening');
  const red = await c('PUT', '/api/screening', { ...CLEAR, menstrual: 'absent' });
  assert.equal(red.body.result.hold, true);
  assert.ok(red.body.result.referral);
  assert.ok(red.body.result.flags.some((f) => f.code === 'MENSTRUAL_CHANGE'));
  const st2 = (await c('GET', '/api/state')).body;
  assert.equal(st2.targets.trainingDay.kcal, maintTrain);
  // the adaptive system cannot cut calories while on hold
  const ev = await c('POST', '/api/adjustments/evaluate');
  assert.ok(!ev.body.proposalId);
});

test('minors are always held at maintenance, even with professional clearance', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'minor@example.com', password: 'longpass1' });
  await c('PUT', '/api/screening', { ...CLEAR, professionalClearance: true });
  const st = (await c('POST', '/api/goal', { ...GOAL, age: 16 })).body;
  assert.equal(st.hold.hold, true);
  assert.ok(st.hold.flags.some((f) => f.code === 'MINOR'));
});

test('hydration log: sweat rate is computed server-side and scoped per user', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'hyd@example.com', password: 'longpass1' });
  const bad = await c('POST', '/api/hydration', { date: '2026-10-20', preKg: 70, postKg: 60, durationMin: 60 });
  assert.equal(bad.status, 400);
  const r = await c('POST', '/api/hydration', { date: '2026-10-20', preKg: 70, postKg: 69.2, fluidL: 0.5, urineL: 0, durationMin: 90 });
  assert.equal(r.status, 201);
  // (70 − 69.2 + 0.5 − 0) / 1.5 h = 0.8667 → 0.87 L/h (hand-computed)
  assert.equal(r.body.logs[0].result.sweatRateLph, 0.87);
  const other = client();
  await other('POST', '/api/auth/register', { email: 'hyd2@example.com', password: 'longpass1' });
  assert.equal((await other('GET', '/api/hydration')).body.logs.length, 0);
  await other('DELETE', `/api/hydration/${r.body.logs[0].id}`);
  assert.equal((await c('GET', '/api/hydration')).body.logs.length, 1, 'another user cannot delete my log');
});

test('week plan versions are kept and can be restored', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'ver@example.com', password: 'longpass1' });
  await c('PUT', '/api/screening', CLEAR);
  await c('POST', '/api/goal', GOAL);
  const p1 = (await c('POST', '/api/weekplan')).body.plan;
  await c('POST', '/api/weekplan/swap', { day: 0, slot: 0 });
  const h = (await c('GET', '/api/weekplan/history')).body.versions;
  assert.ok(h.length >= 2);
  assert.equal(h[h.length - 1].reason, 'generated');
  const back = await c('POST', `/api/weekplan/restore/${h[h.length - 1].id}`);
  assert.equal(back.status, 200);
  assert.equal(JSON.stringify(back.body.plan.days[0].meals.map((m) => m.recipeId)), JSON.stringify(p1.days[0].meals.map((m) => m.recipeId)));
  assert.equal((await c('POST', '/api/weekplan/restore/999999')).status, 404);
  const refs = (await c('GET', '/api/references')).body;
  assert.ok(refs.references.find((r) => r.id === 'broad2019'));
  const foodsDb = require('../src/data/foods.json').foods;
  assert.equal(refs.foodQuality.reviewed, foodsDb.filter((f) => !f.proxy && f.reviewedBy && f.reviewedAt && f.source).length, 'review coverage reported from the data');
});
