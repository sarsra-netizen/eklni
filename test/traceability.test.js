'use strict';
// Audit 2026-10-22: every plan carries its method and calculation version; RMR and TDEE are separate, TDEE has a
// scenario range; macro energy is checked against the calorie target; reports state real data sources.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGoalInput } = require('../src/engine/validate');
const { createPlan } = require('../src/engine/planner');
const energy = require('../src/engine/energy');
const { CALC_VERSION } = require('../src/engine/version');
const { renderNutritionDoc } = require('../src/nutritionDoc');
const wp = require('../src/engine/weekplan');

const T = '2026-10-22';
const mk = (x = {}) => { const v = validateGoalInput({ sex: 'male', age: 30, heightCm: 180, currentWeight: 80, targetWeight: 76, startDate: T, sport: 'running', sessionsPerWeek: 4, minutesPerSession: 60, ...x }, { today: T }); assert.deepEqual(v.errors, {}); return createPlan(v.value, T); };

test('Mifflin-St Jeor by hand: male 80 kg, 180 cm, 30 y = 1780; female same = 1614 (predicted, not measured)', () => {
  assert.equal(energy.bmr({ sex: 'male', weightKg: 80, heightCm: 180, age: 30 }).kcal, 1780);
  assert.equal(energy.bmr({ sex: 'female', weightKg: 80, heightCm: 180, age: 30 }).kcal, 1614);
  const p = mk();
  assert.equal(p.methods.rmr.kcal, 1780); assert.equal(p.methods.rmr.prediction, true);
  assert.equal(mk({ measuredRmr: 1800 }).methods.rmr.prediction, false);
});

test('plan carries calcVersion and methods; TDEE range brackets the estimate', () => {
  const p = mk();
  assert.equal(p.calcVersion, CALC_VERSION);
  const r = p.nutrition.needs.tdeeRange;
  assert.ok(r.low < p.nutrition.needs.tdeeAvg && p.nutrition.needs.tdeeAvg < r.high);
  assert.equal(p.methods.tdee.avg, p.nutrition.needs.tdeeAvg);
  assert.equal(p.methods.nonExercise.pal, energy.NON_EXERCISE_PAL.light);
  assert.ok(p.methods.rules.includes('R-W1'));
  assert.ok(mk({ primaryGoal: 'muscle_gain', targetWeight: 84 }).methods.rules.includes('R-G1'));
  // sedentary + low intensity is already the floor of the tables: low end equals that floor
  const floor = mk({ activityLevel: 'sedentary', intensity: 'low' }).nutrition.needs;
  assert.ok(floor.tdeeRange.low === floor.tdeeAvg && floor.tdeeRange.high > floor.tdeeAvg);
});

test('macro annotations: 4/4/9 energy, gap within rounding, g/kg and % of energy', () => {
  const d = mk().nutrition.trainingDay;
  assert.equal(d.macroKcal, d.proteinG * 4 + d.carbG * 4 + d.fatG * 9);
  assert.equal(d.macroGapKcal, d.macroKcal - d.kcal);
  assert.ok(Math.abs(d.macroGapKcal) <= 15);
  assert.equal(d.proteinGPerKg, Math.round((d.proteinG / 80) * 100) / 100);
  assert.ok(Math.abs(d.proteinPctKcal + d.carbPctKcal + d.fatPctKcal - (d.macroKcal / d.kcal) * 100) < 0.5);
});

test('nutrition file: RMR and TDEE separate, version, real sources (no stale SR-Legacy-only claim), page numbers, free-meal budget', () => {
  const p = mk();
  const plan = wp.generateWeekPlan({ targets: { trainingDay: p.nutrition.trainingDay, restDay: p.nutrition.restDay }, prefs: wp.validatePrefs({ freeMeal: { enabled: true, date: T, slot: 'dinner' } }).value, startDate: T, seed: 7 });
  const st = { plan: p, targets: { trainingDay: p.nutrition.trainingDay, restDay: p.nutrition.restDay }, calcVersion: p.calcVersion, goal: { input: { primaryGoal: 'fat_loss' } },
    planReview: { state: 'none', text: 'الخطة ما اتراجعتش من أخصائي.' }, hold: { hold: false } };
  const html = renderNutritionDoc({ st, plan, user: null, branding: null, hydration: null, displayName: 'سامي', today: T });
  assert.match(html, /معدل الأيض أثناء الراحة \(متوقع بمعادلة، مش قياس\): <b>1780<\/b>/);
  assert.match(html, new RegExp(`الاحتياج اليومي المقدّر \\(TDEE\\): <b>${p.nutrition.needs.tdeeAvg}</b>`));
  assert.match(html, new RegExp(CALC_VERSION.replace(/\./g, '\\.')));
  assert.match(html, /مصادر القيم الغذائية في الخطة دي/);
  assert.match(html, /USDA FNDDS 2021-2023 \d+%/);
  assert.doesNotMatch(html, /مأخوذة من USDA SR Legacy وتحتاج مراجعة/);
  assert.match(html, /counter\(pages\)/);
  assert.match(html, /وجبة حرة: ميزانية حوالي \d+ سعرة \(هدف، مش أكل محسوب/);
  assert.match(html, /مراجعة الأخصائي/);
  const shared = renderNutritionDoc({ st, plan, user: null, branding: null, hydration: null, today: T, share: true, shareName: 'س' });
  assert.doesNotMatch(shared, /معدل الأيض أثناء الراحة/, 'share links show no personal energy figures');
});
