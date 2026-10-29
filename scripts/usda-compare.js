'use strict';
// Compares the app's food values with official USDA data the reviewer downloaded (FNDDS 2021-2023 ingredient values,
// which are SR Legacy / Foundation values keyed by NDB number, and FoodData Central Foundation Foods 2025-12-18).
// Input: data/review/usda-fndds-subset.csv and usda-foundation-subset.csv (made by scripts/usda-extract.py).
// Output: data/review/usda-comparison.csv. It never changes src/data/foods.json and never marks a food reviewed.
const fs = require('node:fs');
const path = require('node:path');
const { parseCsv } = require('./nni-compare');

const ROOT = path.join(__dirname, '..');
const REVIEW = path.join(ROOT, 'data', 'review');
const FIELDS = [['kcal', 'kcal', 30], ['protein', 'protein', 5], ['fat', 'fat', 5], ['carb', 'carb', 5], ['fiber', 'fiber', 3], ['ironMg', 'iron_mg', 1], ['vitDug', 'vitd_ug', 1]];
const read = (f) => (fs.existsSync(path.join(REVIEW, f)) ? parseCsv(fs.readFileSync(path.join(REVIEW, f), 'utf8').replace(/^﻿/, '')) : []);
const ndbOf = (food) => { const s = String(food.source || ''); const m = /\bNDB (\d{4,6})\b/.exec(s) || /USDA SR Legacy (\d{4,6})\b/.exec(s); return m ? Number(m[1]) : null; };
const stem = (w) => w.replace(/(oes|ies|es|s)$/, (m) => (m === 'ies' ? 'y' : m === 'oes' ? 'o' : ''));
const words = (s) => new Set(String(s).toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z]+/).filter((w) => w.length > 2 && !['raw', 'with', 'and', 'without', 'proxy', 'cooked'].includes(w)).map(stem));

function index(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = Number(r.ndb);
    if (!by.has(k)) by.set(k, { description: r.description, fdc: new Set(), v: {} });
    const e = by.get(k);
    e.v[r.nutrient] = Number(r.value);
    if (r.fdc_id) e.fdc.add(r.fdc_id);
    if (r.value_source) (e.src ||= new Set()).add(r.value_source);
  }
  return by;
}

function compare(foods, fnddsRows, foundationRows) {
  const F = index(fnddsRows); const G = index(foundationRows);
  return foods.filter((f) => f.id !== 'water').map((f) => {
    const ndb = ndbOf(f); const e = ndb != null ? F.get(ndb) : null; const g = ndb != null ? G.get(ndb) : null;
    const line = { id: f.id, ar: f.ar, app_en: f.en, claimed_ndb: ndb ?? '', usda_description: e ? e.description : '', usda_value_sources: e && e.src ? [...e.src].join(' / ') : '' };
    let worst = 0;
    for (const [k, n, floor] of FIELDS) {
      const a = f[k] == null ? null : Number(f[k]); const b = e && e.v[n] != null ? e.v[n] : null;
      line[`app_${k}`] = a; line[`usda_${k}`] = b;
      const d = a == null || b == null ? null : Math.round(((a - b) / Math.max(Math.abs(b), floor)) * 100);
      line[`diff_${k}_pct`] = d;
      if (d != null && ['kcal', 'protein', 'fat', 'carb'].includes(k)) worst = Math.max(worst, Math.abs(d));
    }
    line.usda_calcium_mg = e && e.v.calcium_mg != null ? e.v.calcium_mg : '';
    line.foundation_kcal = g ? g.v.kcal ?? g.v.kcal_atwater_general ?? '' : '';
    line.foundation_protein = g && g.v.protein != null ? g.v.protein : '';
    line.foundation_fat = g && g.v.fat != null ? g.v.fat : '';
    line.foundation_fdc_ids = g ? [...g.fdc].join(' ') : '';
    const shared = e ? [...words(f.en)].filter((w) => words(e.description).has(w)).length : 0;
    line.name_check = !e ? '' : shared ? 'ok' : 'check_identifier';
    line.worst_macro_diff_pct = e ? worst : '';
    line.flag = ndb == null ? 'no_ndb' : !e ? 'not_in_fndds' : worst > 10 ? 'differs' : worst > 3 ? 'small_difference' : 'matches';
    // FNDDS mixes SR Legacy and newer Foundation analyses: a "differs" row may simply be a newer USDA value.
    line.usda_newer_analysis = e && e.src && [...e.src].some((x) => /Foundation/.test(x)) ? 'yes' : 'no';
    return line;
  });
}

function toCsv(lines) {
  const cols = Object.keys(lines[0]);
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return '﻿' + [cols.join(','), ...lines.map((l) => cols.map((c) => esc(l[c])).join(','))].join('\n') + '\n';
}

function main() {
  const raw = require('../src/data/foods.json'); const foods = Array.isArray(raw) ? raw : raw.foods;
  const lines = compare(foods, read('usda-fndds-subset.csv'), read('usda-foundation-subset.csv'));
  fs.writeFileSync(path.join(REVIEW, 'usda-comparison.csv'), toCsv(lines));
  const n = (fl) => lines.filter((l) => l.flag === fl).length;
  console.log(`foods: ${lines.length} · matches ${n('matches')} · small difference ${n('small_difference')} · differs ${n('differs')} · NDB not in FNDDS ${n('not_in_fndds')} · no NDB ${n('no_ndb')}`);
  console.log(`name check needed: ${lines.filter((l) => l.name_check === 'check_identifier').length} · Foundation (lab) values for ${lines.filter((l) => l.foundation_fdc_ids).length} foods · USDA calcium available for ${lines.filter((l) => l.usda_calcium_mg !== '').length}`);
  console.log('written data/review/usda-comparison.csv — foods.json not modified');
}
if (require.main === module) main();
module.exports = { compare, ndbOf };
