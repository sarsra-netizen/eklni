'use strict';
// Sports added in 0.7.0: fencing, modern pentathlon, triathlon.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGoalInput } = require('../src/engine/validate');
const { buildPlan, energyNeeds, SPORTS } = require('../src/engine/energy');

const base = { sex: 'male', age: 24, heightCm: 178, currentWeight: 75, targetWeight: 72, startDate: '2026-10-21', sessionsPerWeek: 6, minutesPerSession: 90 };

test('validation: new sports and their disciplines', () => {
  assert.deepEqual(validateGoalInput({ ...base, sport: 'fencing', discipline: 'sabre' }).errors, {});
  assert.deepEqual(validateGoalInput({ ...base, sport: 'triathlon', discipline: 'olympic' }).errors, {});
  assert.deepEqual(validateGoalInput({ ...base, sport: 'modern_pentathlon' }).errors, {});
  assert.ok(validateGoalInput({ ...base, sport: 'triathlon', discipline: 'sabre' }).errors.discipline, 'discipline must belong to the sport');
  assert.ok(validateGoalInput({ ...base, sport: 'fencing', discipline: 'nope' }).errors.discipline);
});

test('energy: net-MET exercise energy (hand-computed) and estimate warnings', () => {
  const p = { ...base, weightKg: 75, sport: 'fencing', intensity: 'moderate', activityLevel: 'light' };
  // fencing MET 6.0 → (6 − 1) × 75 kg × 1.5 h = 562.5 kcal per session
  assert.equal(energyNeeds(p).exercise.perSessionKcal, 563);
  assert.equal(SPORTS.fencing.estimate, undefined);
  const tri = buildPlan({ ...p, sport: 'triathlon' }, 0.3);
  assert.ok(tri.warnings.some((w) => /الثلاثي/.test(w) && /تقديري/.test(w)));
  assert.ok(buildPlan({ ...p, sport: 'modern_pentathlon' }, 0.3).warnings.some((w) => /الخماسي/.test(w)));
});

test('guidance: sport and discipline text is added, numbers unchanged by discipline', () => {
  const p = { ...base, weightKg: 75, sport: 'triathlon', intensity: 'moderate', activityLevel: 'light' };
  const a = buildPlan({ ...p, discipline: 'full' }, 0.3);
  const b = buildPlan({ ...p, discipline: 'sprint_tri' }, 0.3);
  assert.ok(a.athleteGuidance.some((g) => /آيرونمان/.test(g)));
  assert.ok(b.athleteGuidance.some((g) => /السبرنت/.test(g)));
  assert.deepEqual(a.trainingDay, b.trainingDay, 'discipline changes text only');
  assert.ok(buildPlan({ ...p, sport: 'fencing' }, 0.3).athleteGuidance.some((g) => /الجولات/.test(g)));
});
