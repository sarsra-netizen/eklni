'use strict';
// Comparison with official USDA files (FNDDS 2021-2023 ingredient values, FDC Foundation Foods 2025-12-18):
// review data only — it must never change or approve a food value.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { parseCsv } = require('../scripts/nni-compare');
const { compare, ndbOf } = require('../scripts/usda-compare');

const REVIEW = path.join(__dirname, '..', 'data', 'review');
const read = (f) => parseCsv(fs.readFileSync(path.join(REVIEW, f), 'utf8').replace(/^﻿/, ''));
const raw = require('../src/data/foods.json'); const foods = Array.isArray(raw) ? raw : raw.foods;

test('USDA subsets only hold the app’s claimed NDB numbers, with the source of every value', () => {
  const corr = require('../data/review/ndb-corrections.json').corrections;
  const claimed = new Set([...foods.map(ndbOf).filter((x) => x != null), ...Object.values(corr).flatMap((c) => [c.from, c.to])]);
  const fndds = read('usda-fndds-subset.csv');
  assert.ok(fndds.length > 500);
  for (const r of fndds) { assert.ok(claimed.has(Number(r.ndb)), r.ndb); assert.ok(r.value_source, r.ndb); }
  for (const r of read('usda-foundation-subset.csv')) { assert.ok(claimed.has(Number(r.ndb))); assert.ok(r.fdc_id); }
});

test('comparison flags real differences and never approves a food', () => {
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'foods.json'))).digest('hex');
  const lines = compare(foods, read('usda-fndds-subset.csv'), read('usda-foundation-subset.csv'));
  assert.ok(lines.filter((l) => l.flag === 'matches').length >= 50);
  // a wrong identifier (whole-wheat pita values filed under the white-pita NDB 18041) must be flagged
  const wrong = [{ id: 'baladi_bread_wrong', en: 'Egyptian baladi bread (proxy: whole-wheat pita)', source: 'USDA SR Legacy 18041', kcal: 266, protein: 9.8, fat: 2.6, carb: 55 }]; // the values shipped before 2026-10-22
  const extra = read('usda-fndds-subset.csv').concat([{ ndb: '18041', description: 'Bread, pita, white, enriched', nutrient: 'kcal', value: '275', value_source: 'SR Legacy', fdc_id: '' },
    { ndb: '18041', description: 'Bread, pita, white, enriched', nutrient: 'protein', value: '9.1', value_source: 'SR Legacy', fdc_id: '' },
    { ndb: '18041', description: 'Bread, pita, white, enriched', nutrient: 'fat', value: '1.2', value_source: 'SR Legacy', fdc_id: '' },
    { ndb: '18041', description: 'Bread, pita, white, enriched', nutrient: 'carb', value: '55.7', value_source: 'SR Legacy', fdc_id: '' }]);
  const flagged = compare(wrong, extra, []);
  assert.equal(flagged[0].flag, 'differs'); assert.match(flagged[0].usda_description, /white/);
  // baladi bread now uses the Egyptian NNI value (reviewer decision), so it has no USDA identifier any more
  assert.equal(lines.find((l) => l.id === 'baladi_bread').flag, 'no_ndb');
  assert.match(foods.find((f) => f.id === 'baladi_bread').source, /^NNI Egypt 2006/);
  const after = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'foods.json'))).digest('hex');
  assert.equal(after, before);
});
