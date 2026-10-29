'use strict';
// Unreviewed nutrition values must never be presented as reliable (AUDIT DAT-1, DAT-6).
const test = require('node:test');
const assert = require('node:assert/strict');
const foodsDb = require('../src/data/foods.json');
const { nutrientsFor, recipe, trustOf, foodQuality, sum } = require('../src/engine/meals');
const weekplan = require('../src/engine/weekplan');
const review = require('../scripts/review-foods');

test('integrity: a food counts as reviewed only with reviewer, source and date', () => {
  for (const f of foodsDb.foods) {
    if (f.reviewedAt || f.reviewedBy) {
      assert.ok(f.reviewedAt && f.reviewedBy && f.source, `${f.id}: incomplete review record`);
      assert.match(f.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  assert.equal(trustOf({ source: 'USDA', reviewedAt: '2026-01-01' }), 'unreviewed', 'no reviewer → not reviewed');
  assert.equal(trustOf({ source: 'USDA', reviewedAt: '2026-01-01', reviewedBy: 'R.D. X' }), 'reviewed');
  assert.equal(trustOf({ proxy: true, source: 'x', reviewedAt: '2026-01-01', reviewedBy: 'y' }), 'proxy');
});

// Temporarily treat some foods as unreviewed (the shipped data is now reviewed) — restored afterwards.
function asUnreviewed(ids, fn) {
  const saved = foodsDb.foods.filter((f) => ids === 'all' || ids.includes(f.id)).map((f) => [f, f.reviewedBy, f.reviewedAt]);
  for (const [f] of saved) { delete f.reviewedBy; delete f.reviewedAt; }
  try { return fn(); } finally { for (const [f, by, at] of saved) { if (by) f.reviewedBy = by; if (at) f.reviewedAt = at; } }
}

test('every output built from unreviewed values is labelled as an estimate', () => asUnreviewed(['chicken_breast_cooked', 'mint', 'tea', 'water', 'sugar', 'honey', 'lemon_juice'], () => {
  const it = nutrientsFor('chicken_breast_cooked', 100);
  assert.equal(it.trust, 'unreviewed');
  assert.equal(it.estimate, true);
  assert.equal(nutrientsFor('beef_cubes_lean_raw', 100).trust, 'proxy', 'a foreign substitute stays a proxy even when reviewed');
  assert.equal(nutrientsFor('baladi_bread', 100).trust, 'reviewed', 'baladi bread now uses the NNI Egypt value');
  const r = recipe('drink_mint_tea');
  assert.equal(r.estimate, true);
  assert.equal(r.totals.dataStatus, 'estimate');
  assert.equal(sum([{ ...it, trust: 'reviewed' }]).dataStatus, 'reviewed');
  const p = weekplan.generateWeekPlan({ targets: { trainingDay: { kcal: 2500, proteinG: 140, carbG: 300, fatG: 70 }, restDay: { kcal: 2100, proteinG: 140, carbG: 220, fatG: 65 } },
    prefs: weekplan.validatePrefs({}).value, startDate: '2026-10-21', seed: 5 });
  assert.equal(p.dataStatus.status, 'estimate');
  assert.ok(p.dataStatus.reviewedKcalPct < 100);
  assert.match(p.dataStatus.label, /تقديرية/);
}));

test('reviewed-only mode refuses to build a plan while reviewed data is insufficient', () => asUnreviewed('all', () => {
  // fresh engine modules so the recipe list is rebuilt from the (temporarily unreviewed) foods
  for (const m of ['../src/engine/meals', '../src/engine/weekplan']) delete require.cache[require.resolve(m)];
  const freshWeekplan = require('../src/engine/weekplan');
  for (const m of ['../src/engine/meals', '../src/engine/weekplan']) delete require.cache[require.resolve(m)];
  assert.throws(() => freshWeekplan.generateWeekPlan({ targets: { trainingDay: { kcal: 2500, proteinG: 140, carbG: 300, fatG: 70 }, restDay: null },
    prefs: weekplan.validatePrefs({}).value, startDate: '2026-10-21', seed: 5, dataMode: 'reviewed_only' }), (e) => e.code === 'NOT_ENOUGH_REVIEWED_DATA');
}));

test('reviewed-only mode, once enough foods are reviewed, uses only fully reviewed recipes', () => {
  const p = weekplan.generateWeekPlan({ targets: { trainingDay: { kcal: 2500, proteinG: 140, carbG: 300, fatG: 70 }, restDay: { kcal: 2100, proteinG: 140, carbG: 220, fatG: 65 } },
    prefs: weekplan.validatePrefs({}).value, startDate: '2026-10-21', seed: 5, dataMode: 'reviewed_only' });
  for (const d of p.days) for (const m of d.meals) if (m.recipeId) assert.equal(recipe(m.recipeId).plan.reviewed, true, m.recipeId);
});

test('quality summary reports review coverage honestly', () => {
  const q = foodQuality();
  assert.equal(q.reviewed + q.unreviewed + q.proxies, q.foods);
  const { RECIPES, FOODS } = require('../src/engine/meals');
  assert.equal(q.recipesReviewed, RECIPES.filter((r) => r.ingredients.every((i) => FOODS.get(i.food) && trustOf(FOODS.get(i.food)) === 'reviewed')).length);
  assert.equal(q.reviewed, foodsDb.foods.filter((f) => trustOf(f) === 'reviewed').length);
});

test('review script: validates every row and writes nothing on any error', () => {
  const foods = JSON.parse(JSON.stringify(foodsDb.foods));
  const tpl = review.template(foods);
  assert.equal(tpl.trim().split('\n').length, foods.length + 1);
  const head = 'id,ar,kcal,protein,carb,fat,fiber,ironMg,vitDug,calciumMg,source,reviewedBy,reviewedAt,note';
  // chicken breast cooked: 165 kcal, P 31, C 0, F 3.6 → Atwater 156.4 (within 25 %)
  const good = `${head}\nchicken_breast_cooked,فراخ,165,31,0,3.6,0,1.04,0.1,15,USDA FDC SR 05064,RD Test,2026-10-01,\negg_whole,بيض,155,12.6,1.1,10.6,0,,,,,,,\n`;
  const ok = review.plan(foods, good, '2026-10-21');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.changes.length, 1, 'rows without a reviewer are ignored');
  const cases = {
    'unknown id': `${head}\nnope,x,1,1,1,1,0,,,,USDA FDC 1,RD,2026-10-01,`,
    'missing source': `${head}\nchicken_breast_cooked,x,165,31,0,3.6,0,,,,,RD,2026-10-01,`,
    'future date': `${head}\nchicken_breast_cooked,x,165,31,0,3.6,0,,,,USDA FDC 05064,RD,2027-01-01,`,
    'impossible macros': `${head}\nchicken_breast_cooked,x,165,80,30,3.6,0,,,,USDA FDC 05064,RD,2026-10-01,`,
    'atwater mismatch, no note': `${head}\nchicken_breast_cooked,x,300,31,0,3.6,0,,,,USDA FDC 05064,RD,2026-10-01,`,
    'negative value': `${head}\nchicken_breast_cooked,x,165,-1,0,3.6,0,,,,USDA FDC 05064,RD,2026-10-01,`,
  };
  for (const [name, csv] of Object.entries(cases)) assert.ok(review.plan(foods, csv, '2026-10-21').errors.length > 0, name);
  // explained Atwater deviation is allowed (e.g. vinegar: acetic acid energy)
  assert.deepEqual(review.plan(foods, `${head}\nvinegar,خل,21,0,0.9,0,0,,,,USDA FDC SR 02048,RD,2026-10-01,"acetic acid ~ 3.6 kcal/g"`, '2026-10-21').errors, []);
  review.apply(foods, ok.changes, '2026-10-21T10:00:00Z');
  const f = foods.find((x) => x.id === 'chicken_breast_cooked');
  assert.equal(trustOf(f), 'reviewed');
  assert.equal(f.calciumMg, 15);
  const shipped = foodsDb.foods.find((x) => x.id === 'chicken_breast_cooked');
  assert.equal(f.history.length, (shipped.history || []).length + 1, 'one history entry per review');
  assert.equal(f.history.at(-1).previous.reviewedBy, shipped.reviewedBy ?? null, 'previous reviewer kept');
});
