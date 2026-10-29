'use strict';
// Audit 2026-10-22: logged intake (F1) and dietitian plan review (F2), both enforced on the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const intake = require('../src/engine/intake');
const pro = require('../src/pro');

const TODAY = '2026-10-22';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-intake-'));
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'i.db'), today: () => TODAY, trialDays: 3650, notifications: false, registerLimitPerHour: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  const c = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return c;
}
async function user(email) { const c = client(); c.id = (await c('POST', '/api/auth/register', { email, password: 'longpass1' })).body.user.id; return c; }
const CLEAR = { consent: true, menstrual: 'regular', eating: [], conditions: [], impairment: 'none' };
const GOAL = { sex: 'female', age: 22, heightCm: 168, currentWeight: 66, targetWeight: 62, startDate: TODAY, sport: 'swimming', sessionsPerWeek: 5, minutesPerSession: 75 };

test('engine: logged entry = planned items × fraction; free meal is not quantified; nothing comes from targets', () => {
  const day = { date: TODAY, totals: { kcal: 900, protein: 60, carb: 90, fat: 30, fiber: 10 }, added: [],
    meals: [{ idx: 0, slot: 'breakfast', label: 'الفطار', ar: 'فول', recipeItems: [{ foodId: 'baladi_bread', grams: 100 }], extras: [] },
      { idx: 1, slot: 'dinner', label: 'العشا', free: true, target: { kcal: 700, protein: 30, carb: 80, fat: 25 } }] };
  const full = intake.makeEntry(day, 'm0', 'eaten', 1);
  const half = intake.makeEntry(day, 'm0', 'partial', 0.5);
  assert.ok(Math.abs(half.totals.kcal * 2 - full.totals.kcal) <= 2);
  assert.equal(intake.makeEntry(day, 'm0', 'skipped', 0).totals.kcal, 0);
  assert.equal(intake.makeEntry(day, 'm9', 'eaten', 1), null);
  const free = intake.makeEntry(day, 'm1', 'eaten', 1);
  assert.equal(free.totals, null); assert.equal(free.quantified, false);
  const s = intake.daySummary(day, [{ ...half }, { ...free }], { kcal: 2000, proteinG: 120, carbG: 220, fatG: 60 });
  assert.equal(s.logged.kcal, half.totals.kcal, 'logged = only what was logged; the free meal target is NOT added');
  assert.equal(s.target.kcal, 2000); assert.equal(s.planned.kcal, 900);
  assert.equal(s.status, 'complete'); assert.ok(s.note && s.unquantified.length === 1);
  assert.ok(intake.validateLog({ status: 'partial', fraction: 1.2 }).errors.fraction);
  assert.ok(intake.validateLog({ status: 'maybe' }).errors.status);
});

test('API: log, change, clear; week totals sum entries; incomplete days stay incomplete; future and foreign days refused', async () => {
  const a = await user('eat@x.test');
  await a('PUT', '/api/screening', CLEAR);
  assert.equal((await a('POST', '/api/goal', GOAL)).status, 201);
  assert.equal((await a('GET', '/api/intake')).body.error, 'NO_PLAN');
  const wp = (await a('POST', '/api/weekplan', {})).body.plan;
  const d0 = wp.days[0];
  const keys = d0.meals.filter((m) => !m.empty && !m.free).map((m) => `m${m.idx}`);
  let r = await a('PUT', '/api/intake', { date: d0.date, key: keys[0], status: 'eaten' });
  assert.equal(r.status, 200);
  let day = r.body.days[0];
  assert.equal(day.status, 'partial'); assert.ok(day.unlogged.length === keys.length - 1);
  assert.equal(r.body.completeDays, 0); assert.equal(r.body.avgLoggedKcalCompleteDays, null, 'no average from an incomplete day');
  const m0 = d0.meals.find((m) => `m${m.idx}` === keys[0]);
  assert.ok(Math.abs(day.logged.kcal - m0.totals.kcal) <= 1, 'logged = the planned meal’s calculated food');
  r = await a('PUT', '/api/intake', { date: d0.date, key: keys[0], status: 'partial', fraction: 0.5 });
  assert.ok(Math.abs(r.body.days[0].logged.kcal - m0.totals.kcal / 2) <= 3, 'changing the log replaces it');
  for (const k of keys.slice(1)) r = await a('PUT', '/api/intake', { date: d0.date, key: k, status: 'skipped' });
  day = r.body.days[0];
  assert.equal(day.status, d0.added.length ? 'partial' : 'complete');
  assert.equal(r.body.loggedTotal.kcal, day.logged.kcal, 'week logged total = sum of logged entries');
  assert.notEqual(day.logged.kcal, day.target.kcal);
  r = await a('PUT', '/api/intake', { date: d0.date, key: keys[0], clear: true });
  assert.equal(r.body.days[0].entries.find((e) => e.key === keys[0]).log, null);
  assert.equal((await a('PUT', '/api/intake', { date: wp.days[3].date, key: keys[0], status: 'eaten' })).status, 400, 'future day');
  assert.equal((await a('PUT', '/api/intake', { date: '2026-01-01', key: keys[0], status: 'eaten' })).status, 400, 'not in plan');
  assert.equal((await a('PUT', '/api/intake', { date: d0.date, key: 'm99', status: 'eaten' })).status, 400);
  assert.equal((await a('PUT', '/api/intake', { date: d0.date, key: keys[0], status: 'partial', fraction: 3 })).status, 400);
  const b = await user('other@x.test');
  assert.equal((await b('GET', '/api/intake')).body.error, 'NO_GOAL', 'another user sees nothing of it');
  const exp = (await a('GET', '/api/export.json')).body;
  assert.ok(Array.isArray(exp.mealLogs) && exp.mealLogs.length >= 1, 'export includes the intake log');
});

test('plan review: only a verified, subscribed dietitian with consent; bound to the current targets; audited', async () => {
  const admin = await user('adm@r.test'); const diet = await user('rd@r.test'); const ath = await user('ath@r.test'); const coach = await user('co@r.test');
  const A = (await admin('POST', '/api/academies', { name: 'Club' })).body.academy.id;
  const inv = async (role) => (await admin('POST', `/api/academies/${A}/invites`, { role })).body.code;
  await diet('POST', '/api/invites/accept', { code: await inv('dietitian'), displayName: 'د. منى' });
  await coach('POST', '/api/invites/accept', { code: await inv('coach') });
  await ath('POST', '/api/invites/accept', { code: await inv('athlete'), displayName: 'نور' });
  await ath('PUT', '/api/screening', CLEAR);
  await ath('POST', '/api/goal', GOAL);
  const url = `/api/academies/${A}/athletes/${ath.id}/review`;
  assert.equal((await ath('GET', '/api/state')).body.planReview.state, 'none');
  // not verified, no consent → refused
  assert.equal((await diet('POST', url, { decision: 'approved' })).status, 403);
  await diet('POST', '/api/pro/apply', { licenseNo: 'T-1', issuer: 'Syndicate' });
  pro.decide(app.db, 0, diet.id, 'verified', 'test'); pro.extend(app.db, 0, diet.id, 1, TODAY);
  assert.equal((await diet('POST', url, { decision: 'approved' })).status, 403, 'athlete has not shared health data');
  await ath('PUT', `/api/academies/${A}/sharing`, { shareHealth: true });
  assert.equal((await coach('POST', url, { decision: 'approved' })).status, 403, 'coach cannot review');
  assert.equal((await diet('POST', url, { decision: 'rejected' })).status, 400, 'a reason is required');
  assert.equal((await diet('POST', url, { decision: 'whatever' })).status, 400);
  const ok = await diet('POST', url, { decision: 'approved', note: 'الأهداف مناسبة' });
  assert.equal(ok.status, 200);
  let st = (await ath('GET', '/api/state')).body.planReview;
  assert.equal(st.state, 'current'); assert.equal(st.decision, 'approved');
  // targets change (calorie override) → the review no longer covers the plan
  await ath('PUT', '/api/calorie-override', { kcal: 2300, days: 3 });
  st = (await ath('GET', '/api/state')).body.planReview;
  assert.equal(st.state, 'outdated');
  await ath('DELETE', '/api/calorie-override');
  assert.equal((await ath('GET', '/api/state')).body.planReview.state, 'current', 'back to the reviewed targets');
  const log = (await admin('GET', `/api/academies/${A}/audit`)).body.log;
  assert.ok(log.some((e) => e.action === 'plan_review:approved'));
  const v = (await diet('GET', `/api/academies/${A}/athletes/${ath.id}`)).body;
  assert.equal(v.canReview, true); assert.equal(v.planReview.decision, 'approved');
  const nf = await fetch(`${base}/api/nutrition-file`, { headers: {} });
  assert.equal(nf.status, 401);
});
