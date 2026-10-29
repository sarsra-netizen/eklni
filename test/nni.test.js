'use strict';
// NNI (Egypt, 2006) review data: the transcription is consistent, maps to real app foods,
// and comparing never changes or "approves" any food value.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { parseCsv, consistency, compare, TRANSCRIPTION } = require('../scripts/nni-compare');

const rows = parseCsv(fs.readFileSync(TRANSCRIPTION, 'utf8').replace(/^﻿/, ''));
const foodsRaw = require('../src/data/foods.json');
const foods = Array.isArray(foodsRaw) ? foodsRaw : foodsRaw.foods;

test('NNI transcription: every row has its page and is internally consistent', () => {
  assert.ok(rows.length >= 100);
  for (const r of rows) {
    assert.ok(Number(r.pdf_page) >= 12 && Number(r.pdf_page) <= 52, r.nni_item);
    assert.ok(r.nni_item && r.match && r.transcription_check, r.nni_item);
    assert.deepEqual(consistency(r), [], `${r.nni_item} p.${r.printed_page}`);
  }
  // uncertain rows say so
  for (const r of rows.filter((x) => /uncertain/i.test(x.note))) assert.match(r.transcription_check, /UNCERTAIN/);
});

test('NNI rows point at real app foods and each app food appears once', () => {
  const ids = new Set(foods.map((f) => f.id));
  const mapped = rows.filter((r) => r.app_food).map((r) => r.app_food);
  for (const id of mapped) assert.ok(ids.has(id), id);
  assert.equal(new Set(mapped).size, mapped.length);
});

test('comparison: carbohydrate adds NNI fibre back; nothing is approved; foods.json untouched', () => {
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'foods.json'))).digest('hex');
  const lines = compare(foods, rows);
  const flour = lines.find((l) => l.id === 'flour');
  assert.equal(flour.nni_carb, 76.7); // 76.3 available + 0.4 fibre
  assert.ok(lines.every((l) => ['close', 'check', 'large_difference', 'not_equivalent'].includes(l.flag)));
  assert.ok(lines.filter((l) => !l.comparable).every((l) => l.flag === 'not_equivalent'));
  assert.ok(lines.every((l) => !('reviewedBy' in l)), 'the comparison never writes review fields');
  const after = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'foods.json'))).digest('hex');
  assert.equal(after, before);
});
