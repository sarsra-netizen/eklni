'use strict';
// data/review/science-rules.json must match the code, so the human science review always sees the real values.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const energy = require('../src/engine/energy');
const rate = require('../src/engine/rate');
const gain = require('../src/engine/gain');
const rules = require('../data/review/science-rules.json');
const refs = require('../src/data/references.json');

const byKey = Object.fromEntries(rules.rules.filter((r) => r.key).map((r) => [r.key, r.value]));

test('documented values equal the values in the code', () => {
  assert.deepEqual(byKey.NON_EXERCISE_PAL, energy.NON_EXERCISE_PAL);
  assert.deepEqual(byKey.MET, Object.fromEntries(Object.entries(energy.SPORTS).map(([k, v]) => [k, v.met])));
  assert.deepEqual(byKey.INTENSITY_FACTOR, energy.INTENSITY_FACTOR);
  assert.equal(byKey.EA_THRESHOLD, energy.EA_THRESHOLD);
  assert.equal(byKey.MAX_DEFICIT_FRACTION, energy.MAX_DEFICIT_FRACTION);
  assert.equal(byKey.MAX_DEFICIT_FRACTION_MINOR, energy.MAX_DEFICIT_FRACTION_MINOR);
  assert.equal(byKey.ABS_MAX_PCT, rate.ABS_MAX_PCT);
  assert.equal(byKey.WAIVER_MAX_KG, rate.WAIVER_MAX_KG);
  assert.deepEqual(byKey.PHASE_CAP, rate.PHASE_CAP);
  assert.equal(byKey.KCAL_PER_KG, energy.KCAL_PER_KG);
  assert.deepEqual(byKey.GAIN_GOALS, Object.fromEntries(Object.entries(gain.GAIN_GOALS).map(([k, v]) => { const { ar, ...rest } = v; return [k, rest]; })));
  assert.equal(byKey.GAIN_MINOR_MAX_PCT, gain.GAIN_MINOR_MAX_PCT);
  assert.deepEqual(byKey.CARB_BASE, energy.CARB_BASE);
  assert.deepEqual(byKey.SPORT_CARB_ADJ, Object.fromEntries(Object.entries(energy.SPORT_NUTRITION).map(([k, v]) => [k, v.carbAdj])));
  assert.deepEqual(byKey.PHASE_CARB_ADJ, Object.fromEntries(Object.entries(energy.SEASON_PHASES).map(([k, v]) => [k, v.carbAdj])));
});

test('season caps are defined once (rate.PHASE_CAP equals the season table)', () => {
  assert.deepEqual(rate.PHASE_CAP, Object.fromEntries(Object.entries(energy.SEASON_PHASES).map(([k, v]) => [k, v.maxRatePct])));
});

test('every rule says its basis; references point to the registry; a review is claimed only with reviewer, date and decision', () => {
  const ids = new Set(refs.references.map((r) => r.id));
  for (const r of rules.rules) {
    assert.ok(['uploaded_reference', 'published_not_uploaded', 'app_rule'].includes(r.basis), r.id);
    if (r.basis === 'uploaded_reference') assert.ok(/^(broad2019|barclay2012|gropper2022|dga2015|kealy2023)\b/.test(r.reference) && ids.has(r.reference.split(' ')[0]), r.id);
  }
  assert.equal(rules._meta.reviewedBy, null, 'no blanket approval of the whole file');
  for (const r of rules.rules.filter((x) => x.review)) {
    assert.ok(r.review.by && /^\d{4}-\d{2}-\d{2}$/.test(r.review.at) && ['approved', 'changed'].includes(r.review.decision), r.id);
  }
  const md = fs.readFileSync(path.join(__dirname, '..', 'SCIENCE_REVIEW.md'), 'utf8');
  for (const r of rules.rules) assert.ok(md.includes(r.id), `SCIENCE_REVIEW.md is missing ${r.id}`);
  assert.doesNotMatch(md, /معتمد علميًا(?! إلا| قبل|»)/);
});
