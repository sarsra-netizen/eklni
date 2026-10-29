'use strict';
// Human review of food values. The ONLY way a food becomes "reviewed" (trusted) in Eklni.
//
//   node scripts/review-foods.js template > foods-review.csv      # current values + empty reviewer columns
//   (a qualified person checks each row against an official source and fills source, reviewedBy, reviewedAt)
//   node scripts/review-foods.js apply foods-review.csv            # dry run: validates, changes nothing
//   node scripts/review-foods.js apply foods-review.csv --write    # writes src/data/foods.json
//
// Rows without reviewedBy are ignored. Any invalid row aborts the whole run (no partial writes).
// The previous values of every changed food are kept in its `history` array.
const fs = require('node:fs');
const path = require('node:path');

const COLS = ['id', 'ar', 'kcal', 'protein', 'carb', 'fat', 'fiber', 'ironMg', 'vitDug', 'calciumMg', 'source', 'reviewedBy', 'reviewedAt', 'note'];
const NUM = ['kcal', 'protein', 'carb', 'fat', 'fiber', 'ironMg', 'vitDug', 'calciumMg'];

function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

function template(foods) {
  return [COLS.join(','), ...foods.map((f) => COLS.map((c) => csvEscape(c === 'reviewedBy' || c === 'reviewedAt' || c === 'note' ? '' : f[c])).join(','))].join('\n') + '\n';
}

// Validates rows and returns { changes, errors } without touching the data.
function plan(foods, csvText, today = new Date().toISOString().slice(0, 10)) {
  const rows = parseCsv(csvText.replace(/^﻿/, ''));
  const head = rows.shift() || [];
  const idx = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  const errors = []; const changes = [];
  for (const c of ['id', 'source', 'reviewedBy', 'reviewedAt', ...NUM.slice(0, 4)]) if (!(c in idx)) errors.push(`missing column ${c}`);
  if (errors.length) return { changes, errors };
  const byId = new Map(foods.map((f) => [f.id, f]));
  rows.forEach((r, n) => {
    const line = n + 2;
    const get = (c) => (c in idx ? (r[idx[c]] ?? '').trim() : '');
    const reviewer = get('reviewedBy');
    if (!reviewer) return; // not reviewed in this file
    const id = get('id'); const f = byId.get(id);
    if (!f) { errors.push(`line ${line}: unknown food id "${id}"`); return; }
    const at = get('reviewedAt');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || Number.isNaN(Date.parse(at)) || at > today) errors.push(`line ${line} (${id}): reviewedAt must be a real date, not in the future`);
    const source = get('source');
    if (source.length < 6) errors.push(`line ${line} (${id}): source is required (e.g. "USDA FDC 173944" or "NNI Egypt table p.12")`);
    const vals = {};
    for (const c of NUM) {
      const raw = get(c);
      if (raw === '') { vals[c] = null; continue; }
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) { errors.push(`line ${line} (${id}): ${c} must be a number ≥ 0`); continue; }
      vals[c] = v;
    }
    for (const c of ['kcal', 'protein', 'carb', 'fat']) if (vals[c] == null) errors.push(`line ${line} (${id}): ${c} is required`);
    if (vals.kcal > 900) errors.push(`line ${line} (${id}): kcal per 100 g above 900 is impossible`);
    if ((vals.protein || 0) + (vals.carb || 0) + (vals.fat || 0) > 100.5) errors.push(`line ${line} (${id}): protein+carb+fat exceed 100 g per 100 g`);
    if (vals.kcal > 20) {
      const fib = vals.fiber || 0;
      const at4 = 4 * vals.protein + 4 * Math.max(0, vals.carb - fib) + 9 * vals.fat + 2 * fib;
      if (Math.abs(vals.kcal - at4) / vals.kcal > 0.25 && !get('note')) {
        errors.push(`line ${line} (${id}): energy differs >25% from Atwater (${Math.round(at4)} kcal); add a note explaining the source's factors`);
      }
    }
    changes.push({ id, values: vals, source, reviewedBy: reviewer, reviewedAt: at, note: get('note') || null });
  });
  return { changes, errors };
}

function apply(foods, changes, now = new Date().toISOString()) {
  const byId = new Map(foods.map((f) => [f.id, f]));
  for (const ch of changes) {
    const f = byId.get(ch.id);
    const previous = Object.fromEntries([...NUM, 'source', 'reviewedBy', 'reviewedAt'].map((k) => [k, f[k] ?? null]));
    f.history = [...(f.history || []), { changedAt: now, previous }];
    for (const [k, v] of Object.entries(ch.values)) { if (v == null) delete f[k]; else f[k] = v; }
    f.source = ch.source; f.reviewedBy = ch.reviewedBy; f.reviewedAt = ch.reviewedAt;
    if (ch.note) f.reviewNote = ch.note;
  }
  return foods;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const fileArg = args.indexOf('--file');
  const file = fileArg >= 0 ? args[fileArg + 1] : path.join(__dirname, '..', 'src', 'data', 'foods.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args[0] === 'template') process.stdout.write(template(data.foods));
  else if (args[0] === 'apply' && args[1]) {
    const { changes, errors } = plan(data.foods, fs.readFileSync(args[1], 'utf8'));
    if (errors.length) { console.error(`${errors.length} problem(s); nothing was written:\n- ${errors.join('\n- ')}`); process.exitCode = 1; }
    else if (!args.includes('--write')) console.log(`dry run OK: ${changes.length} food(s) would be marked reviewed. Re-run with --write to save.`);
    else { apply(data.foods, changes); fs.writeFileSync(file, JSON.stringify(data, null, 1)); console.log(`${changes.length} food(s) marked reviewed in ${file}`); }
  } else { console.error('usage: node scripts/review-foods.js template | apply <file.csv> [--write] [--file foods.json]'); process.exitCode = 1; }
}

module.exports = { template, plan, apply, parseCsv };
