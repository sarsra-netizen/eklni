'use strict';
// 0.7.0: athlete / non-athlete, the person's name in the PDF, and a one-week calorie override.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { validateGoalInput } = require('../src/engine/validate');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-ovr-'));
let app, base, day = '2026-10-22';
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'o.db'), today: () => day, trialDays: 60, notifications: false, registerLimitPerHour: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
function client() {
  let cookie = '';
  const c = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const txt = await res.text();
    let b; try { b = JSON.parse(txt); } catch { b = txt; }
    return { status: res.status, body: b };
  };
  return c;
}
const GOAL = { fullName: 'محمد أحمد', sex: 'male', age: 32, heightCm: 176, currentWeight: 92, targetWeight: 84, startDate: '2026-10-22', sport: 'running', sessionsPerWeek: 4, minutesPerSession: 50 };
const avg = (t, tDays) => Math.round(((t.trainingDay ? t.trainingDay.kcal : t.restDay.kcal) * tDays + t.restDay.kcal * (7 - tDays)) / 7);

test('non-athlete: no sport, discipline, season phase or competition; season change refused', async () => {
  const v = validateGoalInput({ ...GOAL, isAthlete: false, sport: 'fencing', discipline: 'epee', seasonPhase: 'in_season', competitionDate: '2026-11-20' });
  assert.deepEqual(v.errors, {});
  assert.equal(v.value.sport, 'general'); assert.equal(v.value.seasonPhase, null); assert.equal(v.value.competitionDate, null); assert.equal(v.value.discipline, null);
  assert.equal(validateGoalInput(GOAL).value.isAthlete, true, 'old goals stay athletes');
  const c = client();
  await c('POST', '/api/auth/register', { email: 'na@x.test', password: 'longpass1' });
  await c('PUT', '/api/screening', { consent: true });
  const st = (await c('POST', '/api/goal', { ...GOAL, isAthlete: false })).body;
  assert.equal(st.goal.input.isAthlete, false);
  assert.ok(!JSON.stringify(st.plan.nutrition.athleteGuidance || []).includes('الموسم'));
  assert.equal((await c('PUT', '/api/goal/season', { seasonPhase: 'in_season' })).status, 400);
});

test('PDF: shows the person’s name and no "unreviewed estimate" banner', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'name@x.test', password: 'longpass1' });
  await c('PUT', '/api/screening', { consent: true });
  await c('POST', '/api/goal', GOAL);
  await c('POST', '/api/weekplan', {});
  const html = (await c('GET', '/api/nutrition-file')).body;
  assert.match(html, /الاسم: <b>محمد أحمد<\/b>/);
  assert.ok(!html.includes('بس من السعرات من أصناف اتراجعت'));
});

test('override: safety minimum, at most 7 days, plan follows it, then targets come back', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'ov@x.test', password: 'longpass1' });
  await c('PUT', '/api/screening', { consent: true });
  const st0 = (await c('POST', '/api/goal', GOAL)).body;
  await c('POST', '/api/weekplan', {});
  const info = st0.calorieOverride;
  assert.equal(info.active, false); assert.ok(info.min > 1000);
  const low = await c('PUT', '/api/calorie-override', { kcal: info.min - 100, days: 7 });
  assert.equal(low.status, 400); assert.equal(low.body.error, 'BELOW_SAFE_MIN'); assert.equal(low.body.min, info.min);
  assert.equal((await c('PUT', '/api/calorie-override', { kcal: info.min + 100, days: 8 })).status, 400);
  const want = info.min + 150;
  const ok = await c('PUT', '/api/calorie-override', { kcal: want, days: 3 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.planRefreshed, true);
  assert.equal(ok.body.calorieOverride.endsOn, '2026-10-24');
  const tDays = st0.plan.nutrition.trainingDays;
  assert.ok(Math.abs(avg(ok.body.targets, tDays) - want) <= 15, `average ${avg(ok.body.targets, tDays)} ≈ ${want}`);
  assert.equal(ok.body.targets.trainingDay.proteinG, st0.targets.trainingDay.proteinG, 'protein unchanged');
  const wp = (await c('GET', '/api/weekplan')).body;
  assert.equal(wp.stale, null);
  day = '2026-10-25';
  try {
    const later = (await c('GET', '/api/state')).body;
    assert.equal(later.calorieOverride.active, false);
    assert.equal(later.targets.trainingDay.kcal, st0.targets.trainingDay.kcal, 'normal targets after the period');
  } finally { day = '2026-10-22'; }
  const cleared = await c('DELETE', '/api/calorie-override');
  assert.equal(cleared.body.calorieOverride.active, false);
});

test('override while the plan is held: no deficit below maintenance', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { email: 'held@x.test', password: 'longpass1' });
  const st = (await c('POST', '/api/goal', GOAL)).body; // no screening → held at maintenance
  assert.equal(st.hold.hold, true);
  const r = await c('PUT', '/api/calorie-override', { kcal: st.calorieOverride.min - 300, days: 7 });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /الثبات/);
});
