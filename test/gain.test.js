'use strict';
// 0.7.0: weight-gain goals (muscle_gain, weight_gain, fat_gain). Numbers are app rules R-G1…R-G6 (approved by the reviewer 2026-10-22);
// these tests check the arithmetic and the direction logic, not the scientific choice of the numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateGoalInput } = require('../src/engine/validate');
const { createPlan } = require('../src/engine/planner');
const { calcTimeline } = require('../src/engine/calculator');
const { buildProgress } = require('../src/engine/progress');
const { buildTimeline } = require('../src/engine/timeline');
const { evaluate } = require('../src/engine/adaptive');
const { screen, validateScreening } = require('../src/engine/screening');
const { GAIN_GOALS } = require('../src/engine/gain');
const { createApp } = require('../src/server');

const T = '2026-10-22';
const BASE = { sex: 'male', age: 24, heightCm: 178, currentWeight: 70, targetWeight: 76, startDate: T, sport: 'strength', sessionsPerWeek: 4, minutesPerSession: 60, seasonPhase: 'off_season' };
const plan = (extra) => {
  const v = validateGoalInput({ ...BASE, ...extra }, { today: T });
  assert.deepEqual(v.errors, {});
  return createPlan(v.value, T);
};

test('validation: gain goals need a higher target; loss goals still need a lower one', () => {
  for (const g of Object.keys(GAIN_GOALS)) {
    assert.ok(validateGoalInput({ ...BASE, primaryGoal: g, targetWeight: 68 }, { today: T }).errors.targetWeight, g);
    const v = validateGoalInput({ ...BASE, primaryGoal: g }, { today: T });
    assert.deepEqual(v.errors, {}); assert.equal(v.value.direction, 'gain');
  }
  assert.ok(validateGoalInput({ ...BASE, primaryGoal: 'fat_loss' }, { today: T }).errors.targetWeight);
  const big = validateGoalInput({ ...BASE, primaryGoal: 'fat_gain', targetWeight: 97 }, { today: T });
  assert.equal(big.value.requiresProfessional, true, 'target BMI ≥30 needs a specialist');
  assert.ok(big.warnings.some((w) => w.includes('15%')));
  assert.ok(validateGoalInput({ ...BASE, primaryGoal: 'muscle_gain', bodyFatPct: 15, targetBodyFatPct: 18 }, { today: T }).errors.targetBodyFatPct);
});

test('plan: surplus above TDEE, within the goal cap, macros add up, protein and fat per rule', () => {
  for (const [g, cfg] of Object.entries(GAIN_GOALS)) {
    const p = plan({ primaryGoal: g });
    const n = p.nutrition;
    assert.equal(p.direction, 'gain');
    assert.ok(n.intakeAvg > n.needs.tdeeAvg, `${g}: surplus`);
    assert.ok(n.dailySurplus <= n.needs.tdeeAvg * cfg.surplusMaxFraction + 1, `${g}: cap`);
    assert.equal(n.dailyDeficit, -n.dailySurplus);
    assert.ok(p.recommendation.allowedRangePct[1] <= cfg.maxPct + 1e-9);
    for (const d of [n.trainingDay, n.restDay].filter(Boolean)) {
      assert.ok(Math.abs(d.proteinG * 4 + d.carbG * 4 + d.fatG * 9 - d.kcal) <= 12, `${g}: macros add up`);
      assert.equal(d.proteinG, Math.round(cfg.proteinPerKg * BASE.currentWeight));
      assert.ok(d.fatG * 9 >= cfg.fatPct * d.kcal - 9);
    }
    assert.equal(p.timeline.weightToGain, 6);
    assert.ok(p.timeline.completionDate > T);
  }
  const m = plan({ primaryGoal: 'muscle_gain' }).nutrition.intakeAvg;
  const f = plan({ primaryGoal: 'fat_gain' }).nutrition.intakeAvg;
  assert.ok(f > m, 'fat gain has the larger surplus');
});

test('plan: minors and in-season athletes gain more slowly; custom rate above the cap is refused', () => {
  const minor = plan({ primaryGoal: 'fat_gain', age: 16 });
  assert.ok(minor.recommendation.allowedRangePct[1] <= 0.5);
  assert.equal(minor.requiresProfessional, true);
  assert.ok(plan({ primaryGoal: 'weight_gain', seasonPhase: 'in_season' }).recommendation.allowedRangePct[1] <= 0.25);
  const v = validateGoalInput({ ...BASE, primaryGoal: 'muscle_gain', weeklyRateKg: 0.6 }, { today: T });
  assert.throws(() => createPlan(v.value, T), (e) => e.code === 'RATE_ABOVE_SAFE');
});

test('timeline, progress and target date work upward', () => {
  assert.throws(() => calcTimeline({ currentWeight: 70, targetWeight: 68, weeklyRateKg: 0.3, startDate: T, direction: 'gain' }), (e) => e.code === 'TARGET_NOT_ABOVE_CURRENT');
  const t = calcTimeline({ currentWeight: 70, targetWeight: 73, weeklyRateKg: 0.3, startDate: T, direction: 'gain' });
  assert.equal(t.estimatedWeeks, 10); assert.equal(t.weightToLose, null);
  const tooSoon = plan({ primaryGoal: 'muscle_gain', targetDate: '2026-11-22' });
  assert.equal(tooSoon.targetDateCheck.feasible, false);
  assert.ok(tooSoon.targetDateCheck.interimTargetWeight > 70);
  const goal = { startDate: T, startWeight: 70, targetWeight: 76, weeklyRateKg: 0.3 };
  const entries = [0, 7, 14, 21].flatMap((d, i) => [0, 1, 2].map((k) => ({ date: require('../src/engine/dates').addDays(T, d + k), weightKg: 70 + i * 0.3 })));
  const rows = buildProgress({ goal, entries, checkins: [] });
  assert.equal(rows[3].goalProgressPct, 15);
  const tl = buildTimeline({ goal, rows });
  assert.equal(tl.direction, 'gain');
  assert.equal(tl.planned.at(-1).weight, 76);
  assert.equal(tl.projection.basis, 'trend');
});

test('adaptive: slower gain → proposal to add energy; much faster → reduce; never on thin data', () => {
  const mk = (slope, extra = {}) => [0, 1, 2, 3].map((w) => ({ week: w, avgWeight: 70 + w * slope, adherencePct: 90, checklistConfirmed: true, ...extra }));
  assert.equal(evaluate({ rows: mk(0.3).slice(0, 1), targetRateKg: 0.3, direction: 'gain' }).action, 'insufficient_data');
  assert.equal(evaluate({ rows: mk(0.3), targetRateKg: 0.3, direction: 'gain' }).action, 'continue');
  const slow = evaluate({ rows: mk(0.05), targetRateKg: 0.3, today: T, direction: 'gain' });
  assert.equal(slow.action, 'increase_energy'); assert.ok(slow.kcalChange >= 100 && slow.kcalChange <= 200);
  assert.equal(evaluate({ rows: mk(0.05, { adherencePct: 60 }), targetRateKg: 0.3, direction: 'gain' }).action, 'check_first');
  const fast = evaluate({ rows: mk(0.8), targetRateKg: 0.3, direction: 'gain' });
  assert.equal(fast.action, 'decrease_energy'); assert.equal(fast.kcalChange, -150);
  assert.equal(evaluate({ rows: mk(0.05), targetRateKg: 0.3 }).action === 'increase_energy', false, 'loss logic unchanged');
});

test('screening: a surplus plan is not held for REDS-type signs, but eating, chronic and pregnancy still hold', () => {
  const reds = validateScreening({ consent: true, boneStressInjury: true, persistentFatigue: true, recurrentIllness: true }).value;
  assert.equal(screen(reds, { age: 24, sex: 'male' }).hold, true);
  const g = screen(reds, { age: 24, sex: 'male', gain: true });
  assert.equal(g.hold, false);
  assert.ok(g.flags.some((f) => f.code === 'GAIN_NO_HOLD') && g.flags.some((f) => f.code === 'REDS_SIGNS'), 'flags stay visible');
  for (const extra of [{ eating: ['purge'] }, { conditions: ['thyroid'] }, { pregnantOrBreastfeeding: true }]) {
    assert.equal(screen(validateScreening({ consent: true, menstrual: 'regular', ...extra }).value, { age: 24, sex: 'female', gain: true }).hold, true, JSON.stringify(extra));
  }
  assert.equal(screen(null, { age: 24, gain: true }).hold, true, 'screening still has to be done');
  assert.equal(screen(validateScreening({ consent: true }).value, { age: 15, gain: true }).hold, false, 'minor gain needs no deficit consent');
});

test('API: a gain goal gives surplus targets after screening; surplus applies once screening is done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-gain-'));
  const app = createApp({ dbPath: path.join(dir, 'g.db'), today: () => T, trialDays: 30, notifications: false, registerLimitPerHour: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const c = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  try {
    await c('POST', '/api/auth/register', { email: 'g@x.test', password: 'longpass1' });
    const bad = await c('POST', '/api/goal', { ...BASE, primaryGoal: 'muscle_gain', targetWeight: 65 });
    assert.equal(bad.status, 400);
    const g = await c('POST', '/api/goal', { ...BASE, primaryGoal: 'muscle_gain' });
    assert.equal(g.status, 201);
    assert.equal(g.body.hold.hold, true, 'screening missing → maintenance');
    const s = await c('PUT', '/api/screening', { consent: true, persistentFatigue: true, recurrentIllness: true, performanceDrop: true });
    assert.equal(s.status, 200);
    const st = (await c('GET', '/api/state')).body;
    assert.equal(st.hold.hold, false);
    assert.ok(st.targets.trainingDay.kcal > g.body.targets.trainingDay.kcal, 'surplus applied');
  } finally {
    app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
