'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateWeekPlan, swapMeal, validatePrefs, defaultTrainingDays } = require('../src/engine/weekplan');
const { FOODS } = require('../src/engine/meals');

const TARGETS = {
  trainingDay: { kcal: 2900, proteinG: 164, carbG: 380, fatG: 70, fiberG: 40 },
  restDay: { kcal: 2200, proteinG: 164, carbG: 220, fatG: 60, fiberG: 30 },
};
const plan = (body, seed = 1, targets = TARGETS) => generateWeekPlan({ targets, prefs: validatePrefs(body, 5).value, startDate: '2026-10-24', seed });
const items = (m) => (m.empty ? [] : [...m.recipeItems, ...m.extras.flatMap((e) => e.items)]);
const mains = (p) => p.days.flatMap((d) => d.meals).filter((m) => m.slot === 'lunch' || m.slot === 'dinner');

test('preference validation', () => {
  assert.ok(validatePrefs({ proteins: { chicken: -1, beef: -1, fish: -1, seafood: -1, eggs: -1, legumes: -1, dairy: -1 } }).errors.proteins);
  assert.ok(validatePrefs({ mealsPerDay: 9 }).errors.mealsPerDay);
  const g = validatePrefs({ avoid: ['gluten'], carbs: ['bread', 'pasta', 'rice'] }).value;
  assert.deepEqual(g.carbs, ['rice']);
  assert.ok(validatePrefs({ avoid: ['gluten'], carbs: ['bread'] }).errors.carbs);
  assert.deepEqual(defaultTrainingDays(0), []);
  assert.equal(defaultTrainingDays(5).length, 5);
  assert.equal(defaultTrainingDays(12).length, 7);
});

test('7 days, training days follow preferences, every meal filled', () => {
  const p = plan({ trainingDays: [6, 1, 3], mealsPerDay: 4 });
  assert.equal(p.days.length, 7);
  assert.equal(p.days.filter((d) => d.training).length, 3);
  assert.ok(p.days.every((d) => d.meals.every((m) => !m.empty)));
  for (const d of p.days.filter((x) => x.training)) {
    assert.ok(d.meals.some((m) => m.timing === 'pre') && d.meals.some((m) => m.timing === 'post'), d.dayAr);
  }
});

test('daily macros land close to targets across preference profiles and seeds', () => {
  const profiles = [
    { proteins: { chicken: 2, seafood: -1 }, mealsPerDay: 5, trainingTime: 'evening' },
    { proteins: { beef: 2, chicken: 0 }, mealsPerDay: 4 },
    { proteins: { fish: 2, beef: -1 }, avoid: ['dairy'], mealsPerDay: 4, trainingTime: 'morning' },
    { proteins: { chicken: -1, beef: -1, fish: -1, seafood: -1, eggs: 2, legumes: 2 }, mealsPerDay: 3 },
    { avoid: ['gluten'], carbStrategy: 'even', mealsPerDay: 6 },
  ];
  for (const body of profiles) for (const seed of [1, 2, 3]) {
    for (const d of plan(body, seed).days) {
      const t = d.targets;
      assert.ok(Math.abs(d.totals.protein - t.proteinG) <= t.proteinG * 0.22, `protein ${d.totals.protein} vs ${t.proteinG} ${JSON.stringify(body)}`);
      assert.ok(Math.abs(d.totals.carb - t.carbG) <= t.carbG * 0.2, `carb ${d.totals.carb} vs ${t.carbG}`);
      assert.ok(Math.abs(d.totals.kcal - t.kcal) <= t.kcal * 0.12, `kcal ${d.totals.kcal} vs ${t.kcal}`);
    }
  }
});

test('never-eaten proteins and allergens are excluded everywhere', () => {
  const p = plan({ proteins: { beef: -1, seafood: -1 }, avoid: ['dairy', 'peanuts', 'gluten'] }, 4);
  assert.ok(p.days.every((d) => d.meals.every((m) => !m.empty)), 'every meal filled even with strict exclusions');
  for (const m of p.days.flatMap((d) => d.meals)) {
    for (const i of items(m)) {
      const f = FOODS.get(i.foodId);
      assert.ok(!['beef', 'seafood'].includes(f.proteinType), `${m.recipeAr}: ${f.ar}`);
      assert.ok(!(f.allergens || []).some((a) => ['dairy', 'peanuts', 'gluten'].includes(a)), `${m.recipeAr}: ${f.ar}`);
    }
  }
});

test('favourite protein shows up most; no main dish repeats more than twice', () => {
  const p = plan({ proteins: { fish: 2, chicken: 0, beef: 0 } }, 3);
  assert.equal(p.proteinMix[0].type, 'fish');
  const counts = {};
  mains(p).forEach((m) => { counts[m.recipeId] = (counts[m.recipeId] || 0) + 1; });
  assert.ok(Math.max(...Object.values(counts)) <= 2, JSON.stringify(counts));
});

test('even carb strategy gives the same targets every day', () => {
  const p = plan({ carbStrategy: 'even' });
  assert.equal(new Set(p.days.map((d) => d.targets.carbG)).size, 1);
});

test('swap replaces only the chosen meal', () => {
  const p = plan({}, 5);
  const before = p.days[2].meals.map((m) => m.recipeId);
  const slot = p.days[2].meals.find((m) => m.slot === 'lunch').idx;
  swapMeal(p, 2, slot, 77);
  const after = p.days[2].meals.map((m) => m.recipeId);
  assert.notEqual(after[slot], before[slot]);
  after.forEach((id, i) => { if (i !== slot) assert.equal(id, before[i]); });
  assert.throws(() => swapMeal(p, 9, 0, 1), /اليوم/);
});

test('grocery list adds up to everything in the plan', () => {
  const p = plan({}, 6);
  const total = p.days.flatMap((d) => d.meals).flatMap(items).reduce((s, i) => s + i.grams, 0);
  const listed = p.grocery.reduce((s, g) => s + g.grams, 0);
  assert.ok(listed >= total && listed <= total + p.grocery.length * 10, `${listed} vs ${total}`);
});
