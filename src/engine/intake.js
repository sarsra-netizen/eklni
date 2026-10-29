'use strict';
const { sum } = require('./meals');

// Audit 2026-10-22 (F1): logged intake, kept apart from the plan and from the targets.
//  - TARGET  = the day's calorie/macro targets (currentTargets).
//  - PLANNED = calculated totals of the food in the week plan.
//  - LOGGED  = what the person says he ate: each entry is a SNAPSHOT of the planned items × the eaten fraction,
//              taken when he logs it, so a later plan change never rewrites what was eaten.
// Nothing here ever copies a target into a logged total. Unlogged meals stay unlogged (null), not zero, not target.

const STATUSES = ['eaten', 'partial', 'skipped'];
const STATUS_AR = { eaten: 'أكلتها كلها', partial: 'أكلت جزء', skipped: 'ما أكلتهاش' };

const mealItems = (m) => [...(m.recipeItems || []), ...(m.extras || []).flatMap((e) => e.items)];

// Every loggable entry of a planned day: meals (m<idx>) and added items (a<id>). A free meal is loggable but has no
// calculated food, so it can only say whether it happened.
function loggable(day) {
  const out = [];
  for (const m of day.meals) {
    if (m.empty) continue;
    out.push({ key: `m${m.idx}`, label: m.free ? `${m.label}` : `${m.label || m.slot}: ${m.recipeAr || m.ar || ''}`.trim(), free: !!m.free, items: m.free ? [] : mealItems(m) });
  }
  for (const a of day.added || []) out.push({ key: `a${a.id}`, label: `إضافة: ${a.ar}`, free: false, items: a.items });
  return out;
}

function validateLog(body) {
  const errors = {};
  const status = body && body.status;
  if (!STATUSES.includes(status)) errors.status = 'اختار: أكلتها كلها، أو أكلت جزء، أو ما أكلتهاش.';
  let fraction = status === 'eaten' ? 1 : status === 'skipped' ? 0 : Number(body && body.fraction);
  if (status === 'partial' && !(Number.isFinite(fraction) && fraction >= 0.05 && fraction <= 0.95)) errors.fraction = 'الجزء اللي اتاكل من 5% لـ 95%.';
  if (status === 'partial' && !errors.fraction) fraction = Math.round(fraction * 100) / 100;
  return { value: { status, fraction }, errors };
}

// Builds the stored entry from the planned items × fraction. Returns null if the key is not in the day.
function makeEntry(day, key, status, fraction) {
  const e = loggable(day).find((x) => x.key === key);
  if (!e) return null;
  // scale the planned item records themselves (not a re-lookup from rounded grams), so "eaten = 1" equals the plan exactly
  const sc = (v, d) => (v == null ? null : Math.round(v * fraction * 10 ** d) / 10 ** d);
  const items = e.free || fraction === 0 ? [] : e.items.map((i) => ({ ...i, grams: Math.round(i.grams * fraction), kcal: sc(i.kcal, 1), protein: sc(i.protein, 2), carb: sc(i.carb, 2), fat: sc(i.fat, 2), fiber: sc(i.fiber, 2) }));
  const totals = e.free ? null : sum(items);
  return { key, label: e.label, status, fraction, free: e.free, quantified: !e.free, items: items.map((i) => ({ foodId: i.foodId, ar: i.ar, grams: i.grams, kcal: i.kcal, protein: i.protein, carb: i.carb, fat: i.fat })),
    totals: totals && { kcal: totals.kcal, protein: totals.protein, carb: totals.carb, fat: totals.fat, fiber: totals.fiber } };
}

const ZERO = () => ({ kcal: 0, protein: 0, carb: 0, fat: 0, fiber: 0 });
const r1 = (x) => Math.round(x * 10) / 10;
function add(t, x) { if (x) { t.kcal += x.kcal; t.protein += x.protein; t.carb += x.carb; t.fat += x.fat; t.fiber += x.fiber || 0; } return t; }
function fin(t) { return { kcal: Math.round(t.kcal), protein: r1(t.protein), carb: r1(t.carb), fat: r1(t.fat), fiber: r1(t.fiber) }; }

// logs: entries for this date (from the database). target: {kcal, proteinG, carbG, fatG}.
function daySummary(day, logs, target) {
  const keys = loggable(day);
  const byKey = new Map(logs.map((l) => [l.key, l]));
  const logged = ZERO();
  for (const l of logs) add(logged, l.totals);
  const unlogged = keys.filter((k) => !byKey.has(k.key)).map((k) => k.label);
  const unquantified = logs.filter((l) => l.free && l.status !== 'skipped').map((l) => l.label);
  const status = !logs.length ? 'none' : unlogged.length ? 'partial' : 'complete';
  return {
    date: day.date,
    target: target ? { kcal: target.kcal, protein: target.proteinG, carb: target.carbG, fat: target.fatG } : null,
    planned: { kcal: day.totals.kcal, protein: day.totals.protein, carb: day.totals.carb, fat: day.totals.fat, fiber: day.totals.fiber },
    logged: logs.length ? fin(logged) : null,
    status, statusAr: { none: 'مفيش تسجيل', partial: 'تسجيل ناقص', complete: 'اليوم متسجل كله' }[status],
    entries: [...keys.map((k) => ({ key: k.key, label: k.label, free: k.free, log: byKey.get(k.key) || null })),
      // logged before the plan for this day changed: still counted (it is what was eaten), shown with its own label
      ...logs.filter((l) => !keys.some((k) => k.key === l.key)).map((l) => ({ key: l.key, label: l.label, free: l.free, log: l, fromOlderPlan: true }))],
    unlogged, unquantified,
    note: unquantified.length ? 'الوجبة الحرة اتسجلت إنها اتاكلت، بس مالهاش قيم محسوبة؛ فالمسجّل أقل من الحقيقي.' : null,
  };
}

// Week: logged totals add up ONLY entries that exist; averages use complete days only, and say how many.
function weekSummary(plan, logsByDate, targetFor) {
  const days = plan.days.map((d) => daySummary(d, logsByDate[d.date] || [], targetFor(d)));
  const complete = days.filter((d) => d.status === 'complete' && !d.unquantified.length);
  const loggedAll = days.reduce((t, d) => add(t, d.logged), ZERO());
  const completeLogged = complete.reduce((t, d) => add(t, d.logged), ZERO());
  const completeTarget = complete.reduce((t, d) => t + (d.target ? d.target.kcal : 0), 0);
  return {
    days,
    loggedTotal: fin(loggedAll),
    plannedTotal: fin(days.reduce((t, d) => add(t, d.planned), ZERO())),
    completeDays: complete.length,
    partialDays: days.filter((d) => d.status === 'partial' || d.unquantified.length).length,
    unloggedDays: days.filter((d) => d.status === 'none').length,
    avgLoggedKcalCompleteDays: complete.length ? Math.round(completeLogged.kcal / complete.length) : null,
    avgTargetKcalCompleteDays: complete.length ? Math.round(completeTarget / complete.length) : null,
    note: 'المتوسط محسوب من الأيام المتسجلة كاملة بس. الأيام الناقصة أو اللي مش متسجلة مش بتتحسب صفر ولا بتتملا من الهدف.',
  };
}

module.exports = { STATUSES, STATUS_AR, loggable, validateLog, makeEntry, daySummary, weekSummary };
