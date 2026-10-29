'use strict';
// Reproducible numeric audit (2026-10-22): generates week plans over a grid of profiles and checks that every
// displayed total is the sum of its underlying records, and how macro-derived energy compares with the targets.
// Usage: node scripts/audit-invariants.js [--json]
const { validateGoalInput } = require('../src/engine/validate');
const { createPlan } = require('../src/engine/planner');
const wp = require('../src/engine/weekplan');
const T = '2026-10-22';
const r1 = (x) => Math.round(x * 10) / 10;
function runAudit() {
const out = { plans: 0, days: 0, meals: 0, mealSumMismatch: [], daySumMismatch: [], weekSumMismatch: [], freeMealDays: 0, freeMealBudgetMissing: [], targetMacroEnergyGap: [], maxTargetGapKcal: 0 };
const sumItems = (items) => items.reduce((t, i) => ({ kcal: t.kcal + i.kcal, protein: t.protein + i.protein, carb: t.carb + i.carb, fat: t.fat + i.fat }), { kcal: 0, protein: 0, carb: 0, fat: 0 });
const mealItems = (m) => (m.empty || m.free ? [] : [...m.recipeItems, ...m.extras.flatMap((e) => e.items)]);
const profiles = [];
for (const sex of ['male', 'female']) for (const w of [45, 60, 80, 110]) for (const goal of ['fat_loss', 'muscle_gain']) for (const s of [0, 3, 6, 10]) for (const mins of [45, 120])
  profiles.push({ sex, age: 25, heightCm: sex === 'male' ? 178 : 163, currentWeight: w, targetWeight: goal === 'fat_loss' ? w - 3 : w + 3, primaryGoal: goal, startDate: T, sport: s ? 'swimming' : 'general', sessionsPerWeek: s, minutesPerSession: s ? mins : 0, seasonPhase: 'off_season' });
for (const [pi, body] of profiles.entries()) {
  const v = validateGoalInput(body, { today: T }); if (Object.keys(v.errors).length) continue;
  let plan; try { plan = createPlan(v.value, T); } catch { continue; }
  const n = plan.nutrition;
  for (const d of [n.trainingDay, n.restDay].filter(Boolean)) {
    const e = d.proteinG * 4 + d.carbG * 4 + d.fatG * 9; const gap = Math.round(e - d.kcal);
    out.maxTargetGapKcal = Math.max(out.maxTargetGapKcal, Math.abs(gap));
    if (Math.abs(gap) > 15) out.targetMacroEnergyGap.push({ profile: pi, kcal: d.kcal, macroKcal: e, gap });
  }
  const prefs = wp.validatePrefs(pi % 5 === 0 ? { freeMeal: { enabled: true, date: T, slot: 'dinner' } } : {}).value;
  const week = wp.generateWeekPlan({ targets: { trainingDay: n.trainingDay, restDay: n.restDay || n.trainingDay }, prefs, startDate: T, seed: pi + 1, athlete: { age: 25, sex: body.sex, sessionsPerWeek: body.sessionsPerWeek } });
  out.plans++;
  const acc = { kcal: 0, protein: 0, carb: 0, fat: 0 };
  for (const day of week.days) {
    out.days++;
    let dsum = { kcal: 0, protein: 0, carb: 0, fat: 0 };
    for (const m of day.meals) {
      out.meals++;
      const s = sumItems(mealItems(m));
      if (!m.free && !m.empty && (Math.abs(s.kcal - m.totals.kcal) > 1 || Math.abs(s.protein - m.totals.protein) > 0.2)) out.mealSumMismatch.push({ profile: pi, date: day.date, slot: m.slot, recomputed: s.kcal, shown: m.totals.kcal });
      if (m.free) { out.freeMealDays++; if (!day.freeMealBudget || day.freeMealBudget.kcal !== m.target.kcal) out.freeMealBudgetMissing.push({ profile: pi, date: day.date }); }
      for (const k of Object.keys(dsum)) dsum[k] += s[k];
    }
    for (const a of day.added || []) { const s = sumItems(a.items); for (const k of Object.keys(dsum)) dsum[k] += s[k]; }
    if (Math.abs(dsum.kcal - day.totals.kcal) > 1) out.daySumMismatch.push({ profile: pi, date: day.date, sumOfMeals: Math.round(dsum.kcal), shownDayTotal: day.totals.kcal });
    for (const k of Object.keys(acc)) acc[k] += dsum[k];
  }
  if (Math.abs(acc.kcal - week.weekTotals.kcal) > 1) out.weekSumMismatch.push({ profile: pi, sumOfDays: Math.round(acc.kcal), weekTotal: week.weekTotals.kcal });
  const daySum = week.days.reduce((t, d) => t + d.totals.kcal, 0);
  if (Math.abs(daySum - week.weekTotals.kcal) > 7) out.weekSumMismatch.push({ profile: pi, kind: 'shown day totals vs week total', sumOfShownDayTotals: daySum, weekTotal: week.weekTotals.kcal });
}
const summary = { plans: out.plans, days: out.days, meals: out.meals, mealSumMismatch: out.mealSumMismatch.length, daySumMismatch: out.daySumMismatch.length, weekSumMismatch: out.weekSumMismatch.length,
  freeMealDays: out.freeMealDays, freeMealBudgetMissing: out.freeMealBudgetMissing.length, targetsWithMacroEnergyGapOver15kcal: out.targetMacroEnergyGap.length, maxTargetGapKcal: out.maxTargetGapKcal };
return { summary, out };
}
if (require.main === module) {
const { summary, out } = runAudit();
if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, ...out }, null, 2));
else { console.log(summary); for (const k of ['mealSumMismatch', 'daySumMismatch', 'weekSumMismatch', 'freeMealBudgetMissing', 'targetMacroEnergyGap']) if (out[k].length) console.log(k, JSON.stringify(out[k].slice(0, 3))); }
}
module.exports = { runAudit };
