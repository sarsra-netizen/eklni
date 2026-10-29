'use strict';
// Food review tooling: the worksheet and the USDA comparison never approve or change food values.
// The FDC fixture is SYNTHETIC (see test/fixtures/fdc-synthetic/README.txt) — not USDA data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compare, loadFdc, toCsv, ndbOf } = require('../scripts/fdc-compare');
const { build } = require('../scripts/food-review-worksheet');
const foodsDb = require('../src/data/foods.json');

const FIX = path.join(__dirname, 'fixtures', 'fdc-synthetic');

test('every review comes from a named person through scripts/review-foods.js (reviewer, date, source, previous values kept)', () => {
  for (const f of foodsDb.foods.filter((x) => x.reviewedBy || x.reviewedAt)) {
    assert.ok(f.reviewedBy && f.reviewedBy.length >= 3 && f.reviewedAt && f.source && f.source.length >= 6, f.id);
    assert.ok(Array.isArray(f.history) && f.history.length && f.history.at(-1).previous, `${f.id}: review must keep the previous values`);
    assert.ok(!/claude|auto|script|bot/i.test(f.reviewedBy), `${f.id}: an automated step cannot be the reviewer`);
  }
});

test('worksheet: one pending row per food, nothing modified', () => {
  const before = JSON.stringify(foodsDb.foods);
  const { csv, summary } = build(foodsDb.foods);
  assert.equal(JSON.stringify(foodsDb.foods), before);
  assert.equal(csv.trim().split('\n').length, foodsDb.foods.length + 1);
  const reviewed = foodsDb.foods.filter((f) => f.reviewedBy && f.reviewedAt).length;
  assert.equal((csv.match(/,pending,/g) || []).length, foodsDb.foods.length - reviewed);
  assert.equal(summary.reviewed, reviewed);
  assert.ok(summary.noReliableMatchYet.some((x) => x.id === 'baladi_bread'));
  assert.equal(summary.coverage.calciumMg, foodsDb.foods.filter((f) => f.calciumMg != null).length);
});

test('identifier parsing', () => {
  assert.equal(ndbOf('USDA SR Legacy 16053'), '16053');
  assert.equal(ndbOf('USDA SR Legacy 9421 (x)'), '09421');
  assert.equal(ndbOf('USDA SR Legacy – Squab, meat only'), null);
  assert.equal(ndbOf('—'), null);
});

test('FDC comparison flags differences, wrong identifiers and missing data (synthetic fixture)', async () => {
  const fdc = await loadFdc(FIX);
  const foods = [
    { id: 'a_ok', en: 'Testfood alpha, boiled', state: 'cooked', source: 'USDA SR Legacy 99001', kcal: 101, protein: 10.2, fat: 2, carb: 12, fiber: 3, ironMg: 2, calciumMg: 50 },
    { id: 'a_bad', en: 'Testfood alpha, boiled', state: 'cooked', source: 'USDA SR Legacy 99001', kcal: 140, protein: 10, fat: 2, carb: 12, fiber: 3 },
    { id: 'wrong_id', en: 'Testfood alpha, boiled', state: 'cooked', source: 'USDA SR Legacy 99002', kcal: 300, protein: 5, fat: 1, carb: 70 },
    { id: 'missing', en: 'x', source: 'USDA SR Legacy 99999', kcal: 1, protein: 0, fat: 0, carb: 0 },
    { id: 'none', en: 'y', source: '—', kcal: 0, protein: 0, fat: 0, carb: 0 },
  ];
  const before = JSON.stringify(foods);
  const r = Object.fromEntries(compare(foods, fdc).map((x) => [x.id, x]));
  assert.equal(JSON.stringify(foods), before, 'inputs untouched');
  assert.equal(r.a_ok.status, 'compared');
  assert.deepEqual(r.a_ok.flags, [], 'within tolerance');
  assert.ok(r.a_bad.flags.includes('kcal_differs'));
  assert.equal(r.a_bad.values.kcal.diffPct, 40);
  assert.ok(r.a_bad.flags.includes('ironMg_missing_in_eklni'));
  assert.ok(r.wrong_id.flags.includes('name_mismatch_check_identifier'));
  assert.equal(r.missing.status, 'identifier_not_found');
  assert.equal(r.none.status, 'no_identifier');
  assert.match(toCsv(Object.values(r)), /^id,ar,en,state,proxy,ndb,fdc_id/);
});

test('an unexpected download format is rejected, not silently mis-read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdc-bad-'));
  for (const f of ['food.csv', 'nutrient.csv', 'food_nutrient.csv']) fs.copyFileSync(path.join(FIX, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'sr_legacy_food.csv'), '"fdc_id","ndb"\n"1","2"\n');
  await assert.rejects(loadFdc(dir), /missing column/);
  fs.rmSync(path.join(dir, 'sr_legacy_food.csv'));
  await assert.rejects(loadFdc(dir), /missing sr_legacy_food.csv/);
  fs.rmSync(dir, { recursive: true, force: true });
});
