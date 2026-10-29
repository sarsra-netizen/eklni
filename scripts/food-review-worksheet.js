'use strict';
// Builds the review worksheet for every food (data/review/foods-review-plan.csv) and an automated-checks
// summary (data/review/automated-checks.json). It reads src/data/foods.json and never modifies it.
//   node scripts/food-review-worksheet.js
// Automated checks are internal consistency only (Atwater, missing nutrients, proxy, identifier format).
// They are NOT a comparison with an official source; see scripts/fdc-compare.js for that.
const fs = require('node:fs');
const path = require('node:path');
const { ndbOf } = require('./fdc-compare');

// Egyptian foods or local variants where the Egyptian food composition tables (National Nutrition Institute)
// are the better reference than a US food.
const LOCAL_PREFERRED = new Set(['molokhia', 'fava_cooked', 'fava_dry', 'taro', 'pigeon_raw', 'hibiscus_dry', 'dates']);
const MICROS = ['ironMg', 'vitDug', 'calciumMg'];

function checks(f) {
  const flags = [];
  if (f.proxy) flags.push('proxy_us_substitute');
  const ndb = ndbOf(f.source);
  if (!ndb) flags.push('no_numeric_identifier');
  if (f.fiber == null) flags.push('fiber_missing');
  for (const m of MICROS) if (f[m] == null) flags.push(`${m}_missing`);
  if (f.kcal > 20) {
    const fib = f.fiber || 0;
    const at = 4 * f.protein + 4 * Math.max(0, f.carb - fib) + 9 * f.fat + 2 * fib;
    const d = (f.kcal - at) / f.kcal;
    if (Math.abs(d) > 0.15) flags.push(`atwater_gap_${Math.round(d * 100)}pct`);
  }
  if (f.protein + f.carb + f.fat > 100) flags.push('macros_exceed_100g');
  return { ndb, flags };
}

function sourceType(f, ndb) {
  if (f.id === 'water') return 'definition (0 for all nutrients) — reviewer confirms';
  if (f.proxy || LOCAL_PREFERRED.has(f.id)) return 'NNI Egypt food composition table (preferred) + USDA as comparison';
  if (ndb) return 'USDA FDC SR Legacy — confirm the NDB number and description';
  return 'USDA FDC (search by description) or NNI Egypt';
}

function build(foods) {
  const rows = foods.map((f) => {
    const { ndb, flags } = checks(f);
    return { f, ndb, flags, sourceType: sourceType(f, ndb) };
  });
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['id', 'ar', 'en', 'group', 'state', 'kcal', 'protein', 'carb', 'fat', 'fiber', 'ironMg', 'vitDug', 'calciumMg',
    'claimed_source_unverified', 'claimed_ndb_unverified', 'proposed_reference', 'automated_flags',
    'review_status', 'verified_source', 'verified_source_id', 'verified_food_state', 'reviewedBy', 'reviewedAt', 'reviewer_notes'];
  const csv = [head.join(','), ...rows.map(({ f, ndb, flags, sourceType: st }) => [f.id, f.ar, f.en, f.group, f.state, f.kcal, f.protein, f.carb, f.fat, f.fiber,
    f.ironMg, f.vitDug, f.calciumMg, f.source, ndb, st, flags.join(' '), f.reviewedBy && f.reviewedAt ? 'reviewed' : 'pending', '', '', '', f.reviewedBy || '', f.reviewedAt || '', f.reviewNote || ''].map(esc).join(','))].join('\n') + '\n';
  const summary = {
    generatedFrom: 'src/data/foods.json', foods: foods.length, reviewed: foods.filter((f) => f.reviewedBy && f.reviewedAt).length,
    byReference: rows.reduce((o, r) => { o[r.sourceType] = (o[r.sourceType] || 0) + 1; return o; }, {}),
    noReliableMatchYet: rows.filter((r) => r.f.proxy || !r.ndb || LOCAL_PREFERRED.has(r.f.id)).map((r) => ({ id: r.f.id, ar: r.f.ar, reason: r.f.proxy ? 'US substitute (proxy) for an Egyptian/local food' : !r.ndb ? 'no numeric identifier' : 'local variant — Egyptian table preferred' })),
    atwaterGaps: rows.filter((r) => r.flags.some((x) => x.startsWith('atwater_gap'))).map((r) => ({ id: r.f.id, ar: r.f.ar, kcal: r.f.kcal, flag: r.flags.find((x) => x.startsWith('atwater_gap')) })),
    coverage: Object.fromEntries(['fiber', ...MICROS].map((m) => [m, foods.filter((f) => f[m] != null).length])),
  };
  return { csv, summary };
}

if (require.main === module) {
  const foods = require('../src/data/foods.json').foods;
  const { csv, summary } = build(foods);
  const dir = path.join(__dirname, '..', 'data', 'review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'foods-review-plan.csv'), '﻿' + csv);
  fs.writeFileSync(path.join(dir, 'automated-checks.json'), JSON.stringify(summary, null, 1));
  console.log(`worksheet: ${summary.foods} foods, ${summary.reviewed} reviewed, ${summary.noReliableMatchYet.length} without a reliable match yet, ${summary.atwaterGaps.length} Atwater gaps`);
}

module.exports = { build, checks, LOCAL_PREFERRED };
