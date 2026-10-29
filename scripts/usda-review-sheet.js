'use strict';
// Builds a review sheet (for scripts/review-foods.js) that moves every food found in the official USDA FNDDS
// 2021-2023 file to its latest values, and records the reviewer given on the command line.
//   node scripts/usda-review-sheet.js "<reviewer>" <YYYY-MM-DD> > review.csv
// Foods not in FNDDS keep their current values (the reviewer's sign-off still applies to them).
const fs = require('node:fs');
const path = require('node:path');
const { parseCsv } = require('./nni-compare');
const { ndbOf } = require('./usda-compare');

const ROOT = path.join(__dirname, '..');
const COLS = ['id', 'ar', 'kcal', 'protein', 'carb', 'fat', 'fiber', 'ironMg', 'vitDug', 'calciumMg', 'source', 'reviewedBy', 'reviewedAt', 'note'];
const MAP = { kcal: 'kcal', protein: 'protein', carb: 'carb', fat: 'fat', fiber: 'fiber', ironMg: 'iron_mg', vitDug: 'vitd_ug', calciumMg: 'calcium_mg' };
const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function sheet(foods, fnddsRows, corrections, reviewer, date) {
  const by = new Map();
  for (const r of fnddsRows) {
    const k = Number(r.ndb); if (!by.has(k)) by.set(k, { d: r.description, v: {}, src: new Set(), fdc: new Set() });
    const e = by.get(k); e.v[r.nutrient] = Number(r.value); if (r.value_source) e.src.add(r.value_source); if (r.fdc_id) e.fdc.add(r.fdc_id);
  }
  const rows = foods.map((f) => {
    const ndb = corrections[f.id] ? corrections[f.id].to : ndbOf(f);
    const e = ndb != null ? by.get(ndb) : null;
    const out = { id: f.id, ar: f.ar, reviewedBy: reviewer, reviewedAt: date };
    for (const [k, n] of Object.entries(MAP)) out[k] = e && e.v[n] != null ? e.v[n] : f[k] ?? '';
    if (e) {
      out.source = `USDA FNDDS 2021-2023 · NDB ${ndb} «${e.d}» · ${[...e.src].join(' / ')}${e.fdc.size ? ` · FDC ${[...e.fdc].join(' ')}` : ''}${f.proxy ? ' (بديل تقريبي)' : ''}`;
      out.note = corrections[f.id] ? `اتحدث لأحدث قيم USDA؛ رقم NDB اتصحح من ${corrections[f.id].from} لـ ${ndb}` : 'اتحدث لأحدث قيم USDA (FNDDS 2021-2023)';
    } else {
      out.source = String(f.source || '').length >= 6 ? f.source : 'قيمة ثابتة (ماء/صفر سعرات)';
      out.note = 'القيم الحالية؛ الرقم مش موجود في ملف FNDDS المرفوع';
    }
    return out;
  });
  return [COLS.join(','), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

if (require.main === module) {
  const [reviewer, date] = process.argv.slice(2);
  if (!reviewer || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { console.error('usage: node scripts/usda-review-sheet.js "<reviewer>" <YYYY-MM-DD>'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'foods.json'), 'utf8'));
  const fndds = parseCsv(fs.readFileSync(path.join(ROOT, 'data', 'review', 'usda-fndds-subset.csv'), 'utf8'));
  const corr = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'review', 'ndb-corrections.json'), 'utf8')).corrections;
  process.stdout.write(sheet(raw.foods, fndds, corr, reviewer, date));
}
module.exports = { sheet };
