'use strict';
// Compare Eklni food values with the OFFICIAL USDA FoodData Central "SR Legacy" download.
//
// This script does NOT approve anything. It produces a comparison file that a qualified reviewer reads,
// then the reviewer fills the review CSV and runs scripts/review-foods.js (which records who/when/source).
//
//   1. Download "SR Legacy" (CSV) from https://fdc.nal.usda.gov/download-datasets and unzip it.
//      The folder must contain: food.csv, sr_legacy_food.csv, nutrient.csv, food_nutrient.csv
//   2. node scripts/fdc-compare.js <folder> [--out data/review/fdc-comparison.csv]
//
// Matching is by the NDB number written in each food's `source` (e.g. "USDA SR Legacy 16053").
// Those numbers were entered by hand and are themselves unverified: the official description is printed
// next to ours, and a weak name overlap is flagged so the reviewer can catch a wrong identifier.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

// SR nutrient numbers (nutrient.csv → nutrient_nbr)
const NUTRIENTS = { kcal: '208', protein: '203', fat: '204', carb: '205', fiber: '291', calciumMg: '301', ironMg: '303', vitDug: '328' };
const TOL = { kcal: 0.05, protein: 0.10, fat: 0.10, carb: 0.10, fiber: 0.15, calciumMg: 0.15, ironMg: 0.15, vitDug: 0.15 };
const ABS = { kcal: 5, protein: 0.5, fat: 0.5, carb: 0.5, fiber: 0.3, calciumMg: 3, ironMg: 0.2, vitDug: 0.2 }; // ignore tiny absolute gaps

function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
async function eachRow(file, fn, required = []) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let head = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cells = parseLine(line.replace(/^﻿/, ''));
    if (!head) {
      head = cells;
      const missing = required.filter((c) => !head.includes(c));
      if (missing.length) { rl.close(); throw new Error(`${path.basename(file)}: unexpected format, missing column(s) ${missing.join(', ')}`); }
      continue;
    }
    fn(Object.fromEntries(head.map((h, i) => [h, cells[i]])));
  }
}

const ndbOf = (source) => { const m = /\bNDB (\d{4,5})\b/.exec(source || '') || /USDA SR Legacy (\d{4,5})\b/.exec(source || ''); return m ? m[1].padStart(5, '0') : null; };
const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['raw', 'cooked', 'with', 'without', 'and', 'salt', 'the'].includes(w)));
function nameOverlap(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}

async function loadFdc(dir) {
  for (const f of ['food.csv', 'sr_legacy_food.csv', 'nutrient.csv', 'food_nutrient.csv']) {
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`missing ${f} in ${dir} — download the SR Legacy CSV from fdc.nal.usda.gov`);
  }
  const ndbToFdc = new Map(); const desc = new Map(); const nbrById = new Map(); const values = new Map();
  await eachRow(path.join(dir, 'sr_legacy_food.csv'), (r) => ndbToFdc.set(String(r.NDB_number).padStart(5, '0'), r.fdc_id), ['fdc_id', 'NDB_number']);
  await eachRow(path.join(dir, 'food.csv'), (r) => desc.set(r.fdc_id, r.description), ['fdc_id', 'description']);
  await eachRow(path.join(dir, 'nutrient.csv'), (r) => nbrById.set(r.id, String(r.nutrient_nbr).replace(/\.0+$/, '')), ['id', 'nutrient_nbr']);
  const wanted = new Set(Object.values(NUTRIENTS));
  await eachRow(path.join(dir, 'food_nutrient.csv'), (r) => {
    const nbr = nbrById.get(r.nutrient_id);
    if (!wanted.has(nbr)) return;
    const v = values.get(r.fdc_id) || {};
    v[nbr] = Number(r.amount);
    values.set(r.fdc_id, v);
  }, ['fdc_id', 'nutrient_id', 'amount']);
  return { ndbToFdc, desc, values };
}

function compare(foods, fdc) {
  return foods.map((f) => {
    const ndb = ndbOf(f.source);
    const row = { id: f.id, ar: f.ar, en: f.en, state: f.state, proxy: !!f.proxy, ndb, fdcId: null, fdcDescription: null, nameOverlap: null, status: '', flags: [], values: {} };
    if (!ndb) { row.status = 'no_identifier'; row.flags.push('needs_manual_source'); return row; }
    const fid = fdc.ndbToFdc.get(ndb);
    if (!fid) { row.status = 'identifier_not_found'; row.flags.push('ndb_not_in_sr_legacy'); return row; }
    row.fdcId = fid; row.fdcDescription = fdc.desc.get(fid) || null;
    row.nameOverlap = Math.round(nameOverlap(f.en, row.fdcDescription) * 100) / 100;
    if (row.nameOverlap < 0.5) row.flags.push('name_mismatch_check_identifier');
    if (f.proxy) row.flags.push('proxy_food_needs_local_source');
    const v = fdc.values.get(fid) || {};
    for (const [k, nbr] of Object.entries(NUTRIENTS)) {
      const ours = f[k] ?? null; const theirs = v[nbr] ?? null;
      let diffPct = null; let flag = null;
      if (ours == null && theirs != null) flag = 'missing_in_eklni';
      else if (ours != null && theirs == null) flag = 'not_in_fdc';
      else if (ours != null && theirs != null) {
        const gap = Math.abs(ours - theirs);
        diffPct = theirs === 0 ? (ours === 0 ? 0 : null) : Math.round(((ours - theirs) / theirs) * 1000) / 10;
        if (gap > ABS[k] && (diffPct == null || Math.abs(diffPct) / 100 > TOL[k])) flag = 'differs';
      }
      row.values[k] = { eklni: ours, fdc: theirs, diffPct, flag };
      if (flag === 'differs') row.flags.push(`${k}_differs`);
      if (flag === 'missing_in_eklni') row.flags.push(`${k}_missing_in_eklni`);
    }
    row.status = 'compared';
    return row;
  });
}

function toCsv(rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const keys = Object.keys(NUTRIENTS);
  const head = ['id', 'ar', 'en', 'state', 'proxy', 'ndb', 'fdc_id', 'fdc_description', 'name_overlap', 'status', 'flags',
    ...keys.flatMap((k) => [`${k}_eklni`, `${k}_fdc`, `${k}_diff_pct`])];
  return [head.join(','), ...rows.map((r) => [r.id, r.ar, r.en, r.state, r.proxy, r.ndb, r.fdcId, r.fdcDescription, r.nameOverlap, r.status, r.flags.join(' '),
    ...keys.flatMap((k) => { const x = r.values[k] || {}; return [x.eklni, x.fdc, x.diffPct]; })].map(esc).join(','))].join('\n') + '\n';
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const dir = args.find((a) => !a.startsWith('--'));
    if (!dir) { console.error('usage: node scripts/fdc-compare.js <SR Legacy CSV folder> [--out file.csv]'); process.exitCode = 1; return; }
    const outArg = args.indexOf('--out');
    const out = outArg >= 0 ? args[outArg + 1] : path.join(__dirname, '..', 'data', 'review', 'fdc-comparison.csv');
    const foods = require('../src/data/foods.json').foods;
    const rows = compare(foods, await loadFdc(dir));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, '﻿' + toCsv(rows));
    const c = (s) => rows.filter((r) => r.status === s).length;
    console.log(`compared ${c('compared')}, identifier not found ${c('identifier_not_found')}, no identifier ${c('no_identifier')}; flagged ${rows.filter((r) => r.flags.length).length}. Written to ${out}.`);
    console.log('Nothing was approved. A qualified reviewer must check each row and record decisions with scripts/review-foods.js.');
  })().catch((e) => { console.error(e.message); process.exitCode = 1; });
}

module.exports = { compare, loadFdc, toCsv, ndbOf, nameOverlap, NUTRIENTS };
