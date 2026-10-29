'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcTimeline, evaluateTargetDate } = require('../src/engine/calculator');
const { monthsAndDays, addDays } = require('../src/engine/dates');
const { recommendRate, checkCustomRate } = require('../src/engine/rate');
const { buildPlan, bmr, energyNeeds } = require('../src/engine/energy');
const { validateGoalInput, validateWeightEntry, validateCheckin } = require('../src/engine/validate');
const { createPlan } = require('../src/engine/planner');
const { buildProgress, weeklyAverages } = require('../src/engine/progress');
const { evaluate } = require('../src/engine/adaptive');
const { buildTimeline } = require('../src/engine/timeline');
const { buildDayPlan, recipe, nutrientsFor } = require('../src/engine/meals');

const base = {
  sex: 'male', age: 25, heightCm: 178, currentWeight: 80, targetWeight: 74, startDate: '2026-10-01',
  activityLevel: 'light', sport: 'swimming', sessionsPerWeek: 4, minutesPerSession: 60, intensity: 'moderate',
};
const profile = (o = {}) => ({ ...base, weightKg: base.currentWeight, ...o });

// Build weigh-ins: n weeks, 4 weigh-ins per week, linear change `perWeek` (negative = loss)
function weighIns(start, startWeight, weeks, perWeek) {
  const out = [];
  for (let w = 0; w < weeks; w++) for (const d of [0, 2, 4, 6]) out.push({ date: addDays(start, w * 7 + d), weightKg: +(startWeight + perWeek * (w + d / 7)).toFixed(2) });
  return out;
}
const goalFor = (o = {}) => ({ startDate: '2026-10-01', startWeight: 80, targetWeight: 74, weeklyRateKg: 0.5, ...o });

// ---- 1/2. Target below current & calculator ----
test('weight to lose, weeks and completion date', () => {
  const r = calcTimeline({ currentWeight: 80, targetWeight: 74, weeklyRateKg: 0.5, startDate: '2026-10-01' });
  assert.equal(r.weightToLose, 6);
  assert.equal(r.estimatedWeeks, 12);
  assert.equal(r.estimatedDays, 84);
  assert.equal(r.completionDate, '2026-12-24');
  assert.equal(r.isEstimate, true);
});

test('target equal to or above current weight is rejected', () => {
  assert.throws(() => calcTimeline({ currentWeight: 80, targetWeight: 80, weeklyRateKg: 0.5, startDate: '2026-10-01' }), /أقل من الوزن الحالي/);
  const v = validateGoalInput({ ...base, targetWeight: 85 });
  assert.ok(v.errors.targetWeight);
});

test('calendar months respect month lengths', () => {
  assert.deepEqual(monthsAndDays('2026-01-31', '2026-02-28'), { months: 1, days: 0 }); // end-of-month convention
  assert.deepEqual(monthsAndDays('2026-01-15', '2026-03-01'), { months: 1, days: 14 }); // Feb has 28 days
  assert.deepEqual(monthsAndDays('2026-01-31', '2026-03-31'), { months: 2, days: 0 });
  assert.deepEqual(monthsAndDays('2026-10-01', '2027-03-01'), { months: 5, days: 0 });
  assert.equal(addDays('2028-02-27', 2), '2028-02-29'); // leap year
});

test('different rates give different durations', () => {
  const a = calcTimeline({ currentWeight: 80, targetWeight: 74, weeklyRateKg: 0.4, startDate: '2026-10-01' });
  const b = calcTimeline({ currentWeight: 80, targetWeight: 74, weeklyRateKg: 0.8, startDate: '2026-10-01' });
  assert.equal(a.estimatedWeeks, 15);
  assert.equal(b.estimatedWeeks, 7.5);
  assert.ok(a.completionDate > b.completionDate);
});

// ---- unrealistic / unsafe goals ----
test('target implying body fat below essential is rejected', () => {
  const v = validateGoalInput({ ...base, currentWeight: 70, targetWeight: 60, bodyFatPct: 12, bodyFatMethod: 'dexa' });
  assert.match(v.errors.targetWeight, /غير آمن/);
});
test('very low target BMI without body fat is rejected; borderline only warns', () => {
  assert.ok(validateGoalInput({ ...base, targetWeight: 52 }).errors.targetWeight); // BMI 16.4
  const v = validateGoalInput({ ...base, targetWeight: 58 }); // BMI 18.3
  assert.equal(Object.keys(v.errors).length, 0);
  assert.ok(v.value.requiresProfessional);
});
test('aggressive target date is flagged with alternatives and interim target', () => {
  const r = evaluateTargetDate({ currentWeight: 80, targetWeight: 70, startDate: '2026-10-01', targetDate: '2026-11-12', maxSafeRateKg: 0.8, recommendedRateKg: 0.6 });
  assert.equal(r.feasible, false);
  assert.equal(r.requiredRateKg, 1.67);
  assert.equal(r.alternatives.length, 2);
  assert.ok(r.interimTargetWeight > 70);
});
test('custom rate above the personalised safe range is refused', () => {
  const rec = recommendRate(profile(), '2026-10-01');
  const chk = checkCustomRate(1.2, rec, 80);
  assert.equal(chk.ok, false);
  assert.equal(chk.code, 'RATE_ABOVE_SAFE');
  assert.throws(() => createPlan({ ...validateGoalInput({ ...base, weeklyRateKg: 1.5 }).value }, '2026-10-01'), /أعلى من الحد الآمن/);
});

// ---- personalised rate ----
test('rate stays within 0.25–1 %/week and slows for lean, high-load athletes', () => {
  const avg = recommendRate(profile({ sport: 'general', sessionsPerWeek: 2 }), '2026-10-01');
  assert.ok(avg.recommendedPct >= 0.5 && avg.recommendedPct <= 1);
  const lean = recommendRate(profile({ bodyFatPct: 11, bodyFatMethod: 'dexa', sessionsPerWeek: 10, minutesPerSession: 90, intensity: 'high' }), '2026-10-01');
  assert.ok(lean.recommendedPct < avg.recommendedPct);
  assert.ok(lean.allowedRangePct[1] <= 0.5);
  assert.equal(lean.trainingLoad, 'very_high');
});
test('competition within 4 weeks caps the rate', () => {
  const r = recommendRate(profile({ competitionDate: '2026-10-20' }), '2026-10-01');
  assert.ok(r.allowedRangePct[1] <= 0.35);
  assert.ok(r.flags.includes('COMPETITION_SOON'));
});
test('minors and medical flags require professional review', () => {
  assert.ok(recommendRate(profile({ age: 16 }), '2026-10-01').requiresProfessional);
  assert.ok(recommendRate(profile({ weightMedication: true }), '2026-10-01').requiresProfessional);
});

// ---- energy & macros ----
test('BMR equations: Mifflin without reliable BF, Cunningham with it, measured RMR first', () => {
  // Mifflin 1990 (broad2019 Table 3.1): 10×80 + 6.25×178 − 5×25 + 5 = 1792.5 → 1793 (hand-computed)
  assert.equal(bmr(profile()).kcal, 1793);
  // Cunningham 1980: LBM = 80 × 0.85 = 68 kg → 500 + 22×68 = 1996 (hand-computed)
  const k = bmr(profile({ bodyFatPct: 15, bodyFatMethod: 'dexa' }));
  assert.equal(k.kcal, 1996);
  assert.equal(k.key, 'cunningham');
  assert.equal(bmr(profile({ measuredRmr: 1850, bodyFatPct: 15, bodyFatMethod: 'dexa' })).kcal, 1850);
  assert.match(bmr(profile({ bodyFatPct: 15, bodyFatMethod: 'bia' })).equation, /Mifflin/);
});
test('training energy is net of resting (no double counting)', () => {
  const n0 = energyNeeds(profile({ sessionsPerWeek: 0 }));
  const n1 = energyNeeds(profile());
  const perSession = (7 - 1) * 80 * 1; // net MET × kg × h
  assert.equal(n1.exercise.perSessionKcal, perSession);
  assert.equal(n1.tdeeAvg - n0.tdeeAvg, Math.round((perSession * 4) / 7));
});
test('deficit uses 7700 kcal/kg and macros add up', () => {
  const p = buildPlan(profile({ sessionsPerWeek: 0, activityLevel: 'active' }), 0.5);
  assert.equal(p.rawDailyDeficit, 550);
  assert.equal(p.dailyDeficit, 550);
  const d = p.restDay;
  const kcal = d.proteinG * 4 + d.carbG * 4 + d.fatG * 9;
  assert.ok(Math.abs(kcal - d.kcal) <= 12, `macros ${kcal} vs ${d.kcal}`);
  assert.ok(d.proteinG >= 1.8 * 80 - 1);
  assert.ok(d.fatG >= 0.6 * 80 - 1);
});
test('high-load athlete: deficit capped by energy availability, training days get smaller deficit', () => {
  const p = buildPlan(profile({ bodyFatPct: 14, bodyFatMethod: 'skinfold', sessionsPerWeek: 9, minutesPerSession: 120, intensity: 'high', sport: 'fin_swimming' }), 0.6);
  assert.ok(p.dailyDeficit < p.rawDailyDeficit);
  assert.ok(p.energyAvailability >= 30 - 0.1);
  assert.ok(p.effectiveRateKg < 0.6);
  assert.ok(p.trainingDay.carbTargetG >= 5 * 80);
  assert.ok(p.proteinPerKg >= 2.0);
});
test('severe deficit is capped at 35 % of TDEE (reviewer decision 2026-10-22) and flagged', () => {
  const p = buildPlan(profile({ sessionsPerWeek: 0, activityLevel: 'sedentary', sex: 'female', heightCm: 160, weightKg: 70, age: 40 }), 1.2);
  assert.ok(p.deficitLimited.includes('FRACTION'));
  assert.ok(p.dailyDeficit <= p.needs.tdeeAvg * 0.35 + 1);
  assert.ok(p.requiresProfessional);
});
test('missing body fat: plan still works using estimated FFM', () => {
  const v = validateGoalInput(base);
  assert.equal(Object.keys(v.errors).length, 0);
  const plan = createPlan(v.value, '2026-10-01');
  assert.equal(plan.recommendation.leanness, 'unknown');
  assert.equal(plan.nutrition.fatFreeMass.estimated, true);
  assert.ok(plan.nutrition.warnings.some((w) => /مقدّرة/.test(w)));
});

// ---- input errors ----
test('input validation errors', () => {
  const v = validateGoalInput({ ...base, age: 'abc', heightCm: 300, startDate: '2026-02-30', sport: 'chess' });
  assert.ok(v.errors.age && v.errors.heightCm && v.errors.startDate && v.errors.sport);
  assert.ok(validateGoalInput({}).errors.currentWeight);
  assert.ok(validateWeightEntry({ date: '2026-10-01', weightKg: 5 }).errors.weightKg);
  assert.ok(validateCheckin({ week: -1 }).errors.week);
  assert.ok(validateGoalInput({ ...base, targetBodyFatPct: 12 }).errors.targetBodyFatPct); // no current BF
});

// ---- progress over weeks ----
test('weekly averages, change vs previous week and goal %', () => {
  const entries = weighIns('2026-10-01', 80, 4, -0.5);
  const rows = buildProgress({ goal: goalFor(), entries, checkins: [] });
  assert.equal(rows.length, 4);
  assert.equal(weeklyAverages(entries, '2026-10-01')[0].weighIns, 4);
  assert.equal(rows[1].changeVsPrev, -0.5);
  assert.ok(rows[3].goalProgressPct > 25 && rows[3].goalProgressPct < 35);
});

// ---- adaptive engine ----
const ev = (perWeek, weeks, checkin = {}, extra = {}) => {
  const rows = buildProgress({ goal: goalFor(), entries: weighIns('2026-10-01', 80, weeks, perWeek), checkins: [{ week: weeks - 1, ...checkin }] });
  return evaluate({ rows, targetRateKg: 0.5, today: '2026-11-01', ...extra });
};
test('one week of data: no calorie change', () => {
  const r = ev(-0.5, 1);
  assert.equal(r.action, 'insufficient_data');
  assert.equal(r.kcalChange, 0);
});
test('on target with good recovery: continue', () => {
  assert.equal(ev(-0.5, 4, { performance: 4, sleep: 4 }).action, 'continue');
});
test('plateau: check adherence/logging first, no automatic cut', () => {
  const r = ev(0, 4, { adherencePct: 70 });
  assert.equal(r.action, 'check_first');
  assert.equal(r.kcalChange, 0);
  assert.ok(r.checklist.length >= 4);
});
test('plateau with confirmed high adherence: small decrease proposed', () => {
  const r = ev(-0.1, 4, { adherencePct: 92, checklistConfirmed: true });
  assert.equal(r.action, 'decrease_energy');
  assert.ok(r.kcalChange <= -100 && r.kcalChange >= -150);
});
test('plateau but recent decrease: wait', () => {
  const r = ev(-0.1, 4, { adherencePct: 92, checklistConfirmed: true }, { adjustments: [{ status: 'accepted', kcalChange: -100, decidedAt: '2026-10-25T08:00:00Z' }] });
  assert.equal(r.action, 'monitor');
});
test('plateau with poor recovery: do not cut food', () => {
  const r = ev(0, 4, { adherencePct: 95, checklistConfirmed: true, energy: 1, sleep: 2 });
  assert.equal(r.action, 'check_first');
  assert.equal(r.kcalChange, 0);
});
test('faster than expected with fatigue: increase energy', () => {
  const r = ev(-1.0, 3, { hunger: 5, performance: 2 });
  assert.equal(r.action, 'increase_energy');
  assert.ok(r.kcalChange > 0);
});
test('faster than expected without symptoms early: monitor', () => {
  assert.equal(ev(-0.75, 2, { performance: 4 }).action, 'monitor');
});

// ---- timeline & recalculated date ----
test('timeline scenarios use explicit rates and projection recalculates with reason', () => {
  const goal = goalFor();
  const rows = buildProgress({ goal, entries: weighIns('2026-10-01', 80, 4, -0.3), checkins: [] });
  const tl = buildTimeline({ goal, rows, previousProjection: '2026-12-24' });
  assert.deepEqual(tl.scenarios.map((s) => s.rateKg), [0.5, 0.38, 0.25]);
  assert.equal(tl.scenarios[0].completionDate, '2026-12-24');
  assert.equal(tl.projection.basis, 'trend');
  assert.ok(tl.projection.completionDate > '2026-12-24');
  assert.ok(tl.projection.changeDays > 0);
  assert.match(tl.projection.changeText, /تأخر/);
});
test('stable weight: projection falls back to plan rate from current weight', () => {
  const goal = goalFor();
  const rows = buildProgress({ goal, entries: weighIns('2026-10-01', 80, 3, 0), checkins: [] });
  assert.equal(buildTimeline({ goal, rows }).projection.basis, 'plan_from_current');
});

// ---- Egyptian food & meals ----
test('recipe totals include measured oil', () => {
  const r = recipe('ful_oil');
  const ful = nutrientsFor('fava_cooked', 200);
  assert.equal(r.totals.fat, +(ful.fat + 5).toFixed(1));
  assert.equal(r.totals.kcal, Math.round(ful.kcal + 44));
});
test('day plan approximates macro targets and flags proxy foods', () => {
  const target = { kcal: 2400, proteinG: 160, carbG: 280, fatG: 70, fiberG: 34 };
  const d = buildDayPlan(target, { type: 'training' });
  assert.ok(Math.abs(d.totals.protein - 160) <= 16, `protein ${d.totals.protein}`);
  assert.ok(Math.abs(d.totals.carb - 280) <= 28, `carb ${d.totals.carb}`);
  assert.ok(Math.abs(d.totals.kcal - 2400) <= 2400 * 0.1, `kcal ${d.totals.kcal}`);
  // flagged exactly when some ingredient is not a reviewed value (proxy or unreviewed)
  assert.equal(d.hasEstimates, d.meals.some((m) => m.items.some((i) => i.trust !== 'reviewed')));
  assert.equal(d.costIncluded, false);
  for (const m of d.meals) for (const i of m.items) assert.ok(['raw', 'cooked', 'ready'].includes(i.state));
});

test('target-date feasibility respects energy-availability limits, not just the % cap', () => {
  const v = validateGoalInput({ ...base, sex: 'male', age: 22, heightCm: 170, currentWeight: 72, targetWeight: 68, bodyFatPct: 17,
    bodyFatMethod: 'skinfold', startDate: '2026-09-22', targetDate: '2026-11-15', sport: 'fin_swimming', sessionsPerWeek: 9, minutesPerSession: 120, activityLevel: 'sedentary' });
  const plan = createPlan(v.value, '2026-09-22');
  assert.ok(plan.effectiveRateKg < plan.recommendation.recommendedKg);
  assert.equal(plan.targetDateCheck.feasible, false);
  assert.ok(plan.targetDateCheck.alternatives[1].rateKg <= plan.effectiveRateKg + 0.01);
});

// ---- recipe library ----
test('every recipe uses known foods, has steps, and per-serving values add up', () => {
  const { listRecipes, FOODS } = require('../src/engine/meals');
  const raw = require('../src/data/recipes.json');
  assert.equal(raw.recipes.length, 307);
  const ids = new Set();
  for (const r of raw.recipes) {
    assert.ok(!ids.has(r.id), `duplicate ${r.id}`); ids.add(r.id);
    assert.ok(r.steps.length >= 1, `${r.id} steps`);
    assert.ok(r.servings >= 1);
    for (const i of r.ingredients) assert.ok(FOODS.has(i.food), `${r.id}: unknown food ${i.food}`);
  }
  for (const r of listRecipes().recipes) {
    assert.ok(Math.abs(r.perServing.kcal * r.servings - r.totals.kcal) <= r.servings, `${r.id} kcal`);
    const macroKcal = r.totals.protein * 4 + (r.totals.carb - r.totals.fiber) * 4 + r.totals.fiber * 2 + r.totals.fat * 9; // fiber ≈ 2 kcal/g
    if (r.totals.kcal < 30) continue; // near-zero drinks (water, hibiscus, coffee)
    assert.ok(Math.abs(macroKcal - r.totals.kcal) < Math.max(10, r.totals.kcal * 0.12), `${r.id} macros ${macroKcal} vs ${r.totals.kcal}`);
  }
});
test('honey garlic thighs: oil and honey counted in the totals', () => {
  const { recipe } = require('../src/engine/meals');
  const r = recipe('honey_garlic_thighs');
  assert.equal(r.oilG, 10);
  // 700 g raw thigh 847 + honey 91 + garlic 21 (USDA FNDDS 2021-2023: 143 kcal/100 g) + soy 8 + lemon 3 + oil 88 = 1058
  assert.equal(r.totals.kcal, 1058);
  assert.equal(r.perServing.kcal, 265);
  assert.equal(r.items.find((i) => i.foodId === 'chicken_thigh_raw').state, 'raw');
});
