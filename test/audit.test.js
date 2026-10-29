'use strict';
// Audit 2026-10-22 regression tests: displayed totals come from the food records underneath them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAudit } = require('../scripts/audit-invariants');

test('audit D1: meal = sum of items, day = sum of meals, week = sum of days, free-meal allowance kept apart (112 plans)', () => {
  const { summary } = runAudit();
  assert.ok(summary.plans >= 100 && summary.freeMealDays > 0, 'the grid must include free-meal days');
  assert.equal(summary.mealSumMismatch, 0);
  assert.equal(summary.daySumMismatch, 0);
  assert.equal(summary.weekSumMismatch, 0);
  assert.equal(summary.freeMealBudgetMissing, 0);
  assert.ok(summary.maxTargetGapKcal <= 15, 'macro energy (4/4/9) of the targets is within rounding of the calorie target');
});
