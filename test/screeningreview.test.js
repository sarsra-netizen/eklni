'use strict';
// SCREENING_REVIEW.md must list every question field and every flag the code can raise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateScreening } = require('../src/engine/screening');

const md = fs.readFileSync(path.join(__dirname, '..', 'SCREENING_REVIEW.md'), 'utf8');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'screening.js'), 'utf8');

test('every screening field is in the review document', () => {
  for (const field of Object.keys(validateScreening({}).value)) assert.ok(md.includes(`\`${field}\``), `missing field ${field}`);
});

test('every flag code in the code is in the review document', () => {
  const codes = new Set([...src.matchAll(/'([A-Z][A-Z_]{1,})'/g)].map((m) => m[1]));
  assert.ok(codes.size >= 15);
  for (const c of codes) assert.ok(md.includes(`\`${c}\``), `missing flag ${c}`);
});

test('document states it is not medically approved', () => {
  assert.match(md, /غير معتمد طبيًا/);
  assert.match(md, /سجل المراجعة/);
});
