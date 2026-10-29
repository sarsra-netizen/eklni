'use strict';
// Compares the app's food values with the hand transcription of the Egyptian National Nutrition Institute
// tables (Food Composition Tables for Egypt, 2nd ed., 2006). It never changes src/data/foods.json:
// the output is a review sheet for a human reviewer.
//   node scripts/nni-compare.js            → writes data/review/nni-comparison.csv and prints a summary
// Notes:
//  - NNI "carbohydrate" excludes fibre (water+protein+fat+ash+fibre+carb ≈ 100), USDA-style totals include it,
//    so the app's carb is compared with NNI carb + fibre.
//  - Only rows marked match=same are compared as equivalents; other matches are listed for context.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TRANSCRIPTION = path.join(ROOT, 'data', 'review', 'nni-2006-transcription.csv');
const OUT = path.join(ROOT, 'data', 'review', 'nni-comparison.csv');
const COMPARABLE = new Set(['same', 'similar']);
const FIELDS = [['kcal', 'kcal'], ['protein', 'protein_g'], ['fat', 'fat_g'], ['carb', null], ['fiber', 'fiber_g'], ['ironMg', 'iron_mg']];

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [h, ...rest] = rows;
  return rest.filter((r) => r.length > 1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
const num = (v) => (v === '' || v == null ? null : Number(v));

// Internal consistency of a transcribed row (catches most misread digits in the macro columns).
function consistency(r) {
  const flags = [];
  const k = num(r.kcal), p = num(r.protein_g), f = num(r.fat_g), c = num(r.carb_available_g), fi = num(r.fiber_g), w = num(r.water_g), a = num(r.ash_g);
  if ([k, p, f, c].every((x) => x != null) && k > 0) {
    const est = 4 * p + 9 * f + 4 * c;
    if (Math.abs(est - k) / k > 0.08 && Math.abs(est - k) > 8) flags.push(`energy ${k} ≠ 4P+9F+4C ${Math.round(est)}`);
  }
  if ([w, p, f, a, c].every((x) => x != null)) {
    const s = w + p + f + a + c;
    if (Math.min(Math.abs(s - 100), Math.abs(s + (fi || 0) - 100)) > 2) flags.push(`proximates sum ${s.toFixed(1)}`);
  }
  return flags;
}

function compare(foods, rows) {
  const byId = new Map(foods.map((f) => [f.id, f]));
  const out = [];
  for (const r of rows) {
    if (!r.app_food) continue;
    const f = byId.get(r.app_food);
    if (!f) throw new Error(`unknown app food ${r.app_food}`);
    const nni = { kcal: num(r.kcal), protein: num(r.protein_g), fat: num(r.fat_g), fiber: num(r.fiber_g), ironMg: num(r.iron_mg),
      carb: num(r.carb_available_g) == null ? null : num(r.carb_available_g) + (num(r.fiber_g) || 0) };
    const line = { id: f.id, ar: f.ar, app_state: f.state, nni_item: r.nni_item, nni_page: r.printed_page, match: r.match, comparable: COMPARABLE.has(r.match) };
    let worst = 0;
    for (const [k] of FIELDS) {
      const a = f[k] == null ? null : Number(f[k]); const b = nni[k];
      line[`app_${k}`] = a; line[`nni_${k}`] = b == null ? null : Math.round(b * 100) / 100;
      // small absolute differences on tiny values are not flagged (floor: 30 kcal, 5 g, 1 mg iron)
      const base = Math.max(Math.abs(b || 0), k === 'kcal' ? 30 : k === 'ironMg' ? 1 : 5);
      const d = a == null || b == null ? null : Math.round(((a - b) / base) * 100);
      line[`diff_${k}_pct`] = d;
      if (d != null && ['kcal', 'protein', 'fat', 'carb'].includes(k)) worst = Math.max(worst, Math.abs(d));
    }
    line.nni_calcium_mg = num(r.calcium_mg);
    line.worst_macro_diff_pct = worst;
    line.flag = !line.comparable ? 'not_equivalent' : worst > 25 ? 'large_difference' : worst > 10 ? 'check' : 'close';
    line.transcription = r.transcription_check;
    out.push(line);
  }
  return out;
}

function toCsv(lines) {
  if (!lines.length) return '';
  const cols = Object.keys(lines[0]);
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return '﻿' + [cols.join(','), ...lines.map((l) => cols.map((c) => esc(l[c])).join(','))].join('\n') + '\n';
}

function main() {
  const foods = require('../src/data/foods.json');
  const list = Array.isArray(foods) ? foods : foods.foods;
  const rows = parseCsv(fs.readFileSync(TRANSCRIPTION, 'utf8').replace(/^﻿/, ''));
  const bad = rows.map((r) => [r, consistency(r)]).filter(([, f]) => f.length);
  const lines = compare(list, rows);
  fs.writeFileSync(OUT, toCsv(lines));
  const by = (fl) => lines.filter((l) => l.flag === fl).length;
  const mapped = new Set(lines.map((l) => l.id));
  console.log(`transcribed rows: ${rows.length} · consistency problems: ${bad.length}`);
  console.log(`app foods with an NNI row: ${mapped.size} of ${list.length} · close ${by('close')} · check ${by('check')} · large difference ${by('large_difference')} · not equivalent ${by('not_equivalent')}`);
  console.log(`written ${path.relative(ROOT, OUT)} — foods.json not modified`);
}

if (require.main === module) main();
module.exports = { parseCsv, consistency, compare, TRANSCRIPTION };
