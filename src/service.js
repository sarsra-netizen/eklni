'use strict';
const { buildProgress } = require('./engine/progress');
const { buildTimeline } = require('./engine/timeline');
const { evaluate } = require('./engine/adaptive');
const { buildDayPlan } = require('./engine/meals');
const { createPlan } = require('./engine/planner');
const { validateGoalInput } = require('./engine/validate');
const { round } = require('./engine/calculator');
const weekplan = require('./engine/weekplan');
const household = require('./household');
const { listRecipes } = require('./engine/meals');
const { buildPlan } = require('./engine/energy');
const energy = require('./engine/energy');
const { addDays } = require('./engine/dates');
const screening = require('./engine/screening');
const hydration = require('./engine/hydration');
const { driFor } = require('./engine/dri');
const intake = require('./engine/intake');
const { CALC_VERSION } = require('./engine/version');

// ---- safety hold: screening flags / minors → maintenance targets, no deficit ----
// A guardian's consent counts only while that guardian is still linked to the athlete.
function guardianConsent(db, userId) {
  const c = db.getMinorConsent ? db.getMinorConsent(userId) : null;
  return !!c && db.isGuardian(c.academyId, c.guardianId, userId);
}
const { isGainGoal } = require('./engine/gain');
const isGain = (goal) => !!goal && isGainGoal(goal.input && goal.input.primaryGoal);
function holdFor(db, userId, goal) {
  return screening.screen(db.getScreening(userId), { age: goal.input.age, sex: goal.input.sex, guardianConsent: goal.input.age < 18 && guardianConsent(db, userId),
    selfWaiver: goal.input.age >= 18 && !!(db.getSelfWaiver && db.getSelfWaiver(userId)), gain: isGain(goal) });
}
const reached = (goal, w) => (isGain(goal) ? w >= goal.targetWeight : w <= goal.targetWeight);
function maintenanceNutrition(goal) {
  return buildPlan({ ...goal.input, weightKg: goal.input.currentWeight }, 0);
}
function currentTargets(db, userId, goal, hold = holdFor(db, userId, goal), today = null) {
  const t = currentTargetsRaw(db, userId, goal, hold, today);
  const w = goal.input.currentWeight;
  return { ...t, trainingDay: energy.annotateMacros(t.trainingDay, w), restDay: energy.annotateMacros(t.restDay, w) };
}
function currentTargetsRaw(db, userId, goal, hold, today) {
  const base = hold.hold ? { ...adjustedTargets(maintenanceNutrition(goal), 0), maintenanceHold: true } : adjustedTargets(goal.plan.nutrition, goal.calorieAdjustment);
  const ov = today && db.getCalorieOverride ? db.getCalorieOverride(userId) : null;
  if (!ov || today < ov.startsOn || today > ov.endsOn) return base;
  return overrideTargets(goal, base, ov, hold);
}

// ---- one-week calorie override (0.7.0, owner decision) ----
// The person types a daily calorie average; protein stays, carbohydrate and fat move (fat floor from dayMacros).
// Limits are the app's own safety rules: no deficit while the plan is held, deficit ≤25% of needs (15% for minors),
// and energy availability ≥30 kcal/kg FFM when training. At most 7 days, then the normal targets come back.
const OVERRIDE_MAX_DAYS = 7;
function trainingDaysOf(goal, hold) {
  const n = hold.hold ? maintenanceNutrition(goal) : goal.plan.nutrition;
  return { n, tDays: n.trainingDay ? n.trainingDays || 0 : 0 };
}
function intakeAvgOf(t, tDays) {
  const tr = t.trainingDay ? t.trainingDay.kcal : null; const rs = t.restDay ? t.restDay.kcal : tr;
  return tr == null ? rs : Math.round((tr * tDays + rs * (7 - tDays)) / 7);
}
function overrideLimits(goal, hold) {
  const { n, tDays } = trainingDaysOf(goal, hold);
  const maint = maintenanceNutrition(goal);
  const tdee = maint.needs.tdeeAvg;
  if (hold.hold) return { min: Math.round(intakeAvgOf(adjustedTargets(maint, 0), tDays)), max: 6000, reason: 'hold' };
  const frac = goal.input.age < 18 ? energy.MAX_DEFICIT_FRACTION_MINOR : energy.MAX_DEFICIT_FRACTION;
  let min = tdee * (1 - frac);
  if ((goal.input.sessionsPerWeek || 0) > 0) min = Math.max(min, energy.EA_THRESHOLD * n.fatFreeMass.kg + n.needs.exercise.dailyAvgKcal);
  return { min: Math.ceil(min / 10) * 10, max: 6000, reason: null };
}
function overrideTargets(goal, base, ov, hold) {
  const { tDays } = trainingDaysOf(goal, hold);
  const delta = ov.kcal - intakeAvgOf(base, tDays);
  const w = goal.input.currentWeight;
  const f = (d) => d && energy.dayMacros({ kcal: Math.max(0, d.kcal + delta), weightKg: w, proteinG: d.proteinG, carbTargetG: Math.max(0, (d.carbG || 0) + (delta * 0.6) / 4) });
  return { trainingDay: f(base.trainingDay), restDay: f(base.restDay), adjustmentKcal: base.adjustmentKcal, maintenanceHold: base.maintenanceHold,
    override: { kcal: ov.kcal, startsOn: ov.startsOn, endsOn: ov.endsOn } };
}
function setCalorieOverride(db, userId, body = {}, today, seed = 1) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL', status: 400, message: 'اعمل الهدف الأول.' };
  if (body.clear === true) {
    db.clearCalorieOverride(userId);
    return { ...buildState(db, userId, today), planRefreshed: refreshPlanIfTargetsChanged(db, userId, today, seed) };
  }
  const kcal = Number(body.kcal); const days = Number(body.days ?? OVERRIDE_MAX_DAYS);
  if (!Number.isInteger(kcal) || kcal < 800 || kcal > 6000) return { error: 'VALIDATION', status: 400, message: 'اكتب السعرات رقم صحيح من 800 لـ 6000.' };
  if (!Number.isInteger(days) || days < 1 || days > OVERRIDE_MAX_DAYS) return { error: 'VALIDATION', status: 400, message: 'المدة من يوم لـ 7 أيام بس.' };
  const hold = holdFor(db, userId, goal);
  const lim = overrideLimits(goal, hold);
  if (kcal < lim.min) {
    return { error: 'BELOW_SAFE_MIN', status: 400, min: lim.min, message: lim.reason === 'hold'
      ? `الخطة متوقفة على الثبات دلوقتي، فمينفعش سعرات أقل من ${lim.min}. كمّل الفحص الصحي أو الإقرار الأول.`
      : `أقل رقم مسموح ليك ${lim.min} سعرة في اليوم (حدود الأمان: عجز ≤${Math.round((goal.input.age < 18 ? energy.MAX_DEFICIT_FRACTION_MINOR : energy.MAX_DEFICIT_FRACTION) * 100)}% من الاحتياج وتوافر طاقة كافي).` };
  }
  db.setCalorieOverride(userId, kcal, today, addDays(today, days - 1));
  return { ...buildState(db, userId, today), planRefreshed: refreshPlanIfTargetsChanged(db, userId, today, seed) };
}
function calorieOverrideInfo(db, userId, goal, today) {
  const hold = holdFor(db, userId, goal);
  const ov = db.getCalorieOverride ? db.getCalorieOverride(userId) : null;
  const active = !!ov && today >= ov.startsOn && today <= ov.endsOn;
  return { active, ...(active ? ov : {}), min: overrideLimits(goal, hold).min, maxDays: OVERRIDE_MAX_DAYS };
}

// Applies an accepted calorie adjustment to the day targets (changes carbohydrate only,
// so protein and minimum fat are never reduced by an adjustment).
function adjustedTargets(nutrition, adj) {
  const f = (d) => d && ({ ...d, kcal: d.kcal + adj, carbG: Math.max(0, Math.round(d.carbG + adj / 4)) });
  return { trainingDay: f(nutrition.trainingDay), restDay: f(nutrition.restDay), adjustmentKcal: adj };
}

// Guard: a new total adjustment must keep the deficit ≤25 % of TDEE and EA ≥30 kcal/kg FFM.
function guardAdjustment(goal, newTotal) {
  const n = goal.plan.nutrition;
  const intake = n.intakeAvg + newTotal;
  const deficit = n.needs.tdeeAvg - intake;
  const problems = [];
  const maxFrac = goal.input.age < 18 ? energy.MAX_DEFICIT_FRACTION_MINOR : energy.MAX_DEFICIT_FRACTION;
  if (isGain(goal)) {
    const cap = require('./engine/gain').GAIN_GOALS[goal.input.primaryGoal].surplusMaxFraction;
    if (-deficit / n.needs.tdeeAvg > cap) problems.push(`التعديل يخلي الفائض أكبر من ${Math.round(cap * 100)}% من الاحتياج.`);
    if (deficit > 0) problems.push('التعديل يقلب خطة الزيادة لعجز سعرات.');
    return { ok: problems.length === 0, problems, newIntakeAvg: intake };
  }
  if (deficit / n.needs.tdeeAvg > maxFrac) problems.push(`التعديل يجعل العجز أكبر من ${Math.round(maxFrac * 100)}% من الاحتياج؛ يحتاج مراجعة أخصائي تغذية رياضية.`);
  if ((goal.input.sessionsPerWeek || 0) > 0) {
    const ea = (intake - n.needs.exercise.dailyAvgKcal) / n.fatFreeMass.kg;
    if (ea < 30) problems.push(`التعديل يخفض توافر الطاقة إلى ${round(ea, 1)} سعرة/كجم كتلة خالية من الدهون (أقل من 30).`);
  }
  return { ok: problems.length === 0, problems, newIntakeAvg: intake };
}

function computeRows(db, userId, goal) {
  return buildProgress({ goal, entries: db.weights(userId, goal.id), checkins: db.checkins(userId, goal.id) });
}

// readOnly: used when someone else (coach / dietitian / parent) views the athlete — viewing must not write
// projection changes into the athlete's own history.
function buildState(db, userId, today, { readOnly = false } = {}) {
  const goal = db.activeGoal(userId);
  if (!goal) return { goal: null };
  const rows = computeRows(db, userId, goal);
  const timeline = buildTimeline({ goal, rows, previousProjection: goal.lastProjection });
  if (!readOnly && timeline.projection.completionDate !== goal.lastProjection) {
    db.setProjection(userId, goal.id, timeline.projection.completionDate);
    // log only meaningful shifts (≥ 7 days) so the history isn't flooded by every weigh-in
    if (timeline.projection.changeText && Math.abs(timeline.projection.changeDays) >= 7) {
      db.addAdjustment(userId, goal.id, { kind: 'projection', action: 'date_changed', reasons: [timeline.projection.changeText], status: 'info' });
    }
  }
  const adjustments = db.adjustments(userId, goal.id);
  const hold = holdFor(db, userId, goal);
  const targets = currentTargets(db, userId, goal, hold, today);
  const mealPlans = {
    training: targets.trainingDay ? buildDayPlan(targets.trainingDay, { type: 'training', variant: 0 }) : null,
    rest: targets.restDay ? buildDayPlan(targets.restDay, { type: 'rest', variant: 1 }) : null,
  };
  const last = [...rows].reverse().find((r) => r.avgWeight != null);
  const planWeight = goal.input.currentWeight;
  const recalcSuggested = !!last && Math.abs(last.avgWeight - planWeight) >= Math.max(2, planWeight * 0.03);
  return {
    goal: { id: goal.id, input: goal.input, startDate: goal.startDate, startWeight: goal.startWeight, targetWeight: goal.targetWeight,
      weeklyRateKg: goal.weeklyRateKg, calorieAdjustment: goal.calorieAdjustment, createdAt: goal.createdAt },
    plan: goal.plan,
    targets,
    calorieOverride: readOnly ? undefined : calorieOverrideInfo(db, userId, goal, today),
    rows,
    timeline,
    evaluation: evaluate({ rows, targetRateKg: goal.weeklyRateKg, today, adjustments, direction: isGain(goal) ? 'gain' : 'loss' }),
    adjustments,
    pending: adjustments.filter((a) => a.status === 'pending').pop() || null,
    weights: db.weights(userId, goal.id),
    mealPlans,
    recalcSuggested,
    hold,
    planReview: planReviewState(db, userId, goal, targets, goal.plan),
    calcVersion: goal.plan.calcVersion || null,
    today,
  };
}

function proposeAdjustment(db, userId, today) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  const rows = computeRows(db, userId, goal);
  const ev = evaluate({ rows, targetRateKg: goal.weeklyRateKg, today, adjustments: db.adjustments(userId, goal.id), direction: isGain(goal) ? 'gain' : 'loss' });
  if (ev.kcalChange !== 0 && holdFor(db, userId, goal).hold) {
    return { evaluation: { ...ev, action: 'blocked_by_hold', kcalChange: 0, reasons: ['الخطة على سعرات الثبات بسبب نتيجة الفحص الصحي؛ مفيش تعديل سعرات لحد مراجعة مختص.'] } };
  }
  if (ev.kcalChange !== 0) {
    if (ev.kcalChange < 0) {
      const g = guardAdjustment(goal, goal.calorieAdjustment + ev.kcalChange);
      if (!g.ok) {
        return { evaluation: { ...ev, action: 'blocked_by_guard', kcalChange: 0, reasons: [...ev.reasons, ...g.problems, 'لن نقترح تقليلًا إضافيًا. الأفضل قبول معدل أبطأ أو مراجعة متخصص.'] } };
      }
    }
    db.expirePending(userId, goal.id);
    const id = db.addAdjustment(userId, goal.id, { kind: 'calories', action: ev.action, kcalChange: ev.kcalChange, reasons: ev.reasons });
    return { evaluation: ev, proposalId: Number(id) };
  }
  return { evaluation: ev };
}

function decideAdjustment(db, userId, id, decision, note) {
  const a = db.adjustment(userId, id);
  if (!a || a.status !== 'pending') return { error: 'NOT_PENDING' };
  const goal = db.activeGoal(userId);
  if (!goal || goal.id !== a.goal_id) return { error: 'NOT_PENDING' };
  if (decision === 'accepted') {
    const total = goal.calorieAdjustment + a.kcal_change;
    const g = guardAdjustment(goal, total);
    if (!g.ok) return { error: 'GUARD', problems: g.problems };
    db.setCalorieAdjustment(userId, goal.id, total);
  }
  db.decideAdjustment(userId, id, decision, note);
  return { ok: true };
}

// Re-estimates needs from the latest weekly average weight (weight changed → needs changed).
function recalculate(db, userId, today) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  const rows = computeRows(db, userId, goal);
  const last = [...rows].reverse().find((r) => r.avgWeight != null);
  if (!last) return { error: 'NO_DATA' };
  const body = { ...goal.input, currentWeight: last.avgWeight, startDate: today, targetDate: null, weeklyRateKg: null };
  if (reached(goal, last.avgWeight)) return { error: 'TARGET_REACHED' };
  const v = validateGoalInput(body, { today });
  if (Object.keys(v.errors).length) return { error: 'VALIDATION', errors: v.errors };
  const plan = createPlan(v.value, today, { selfWaiver: !!(db.getSelfWaiver && db.getSelfWaiver(userId)) });
  const input = { ...goal.input, currentWeight: last.avgWeight };
  db.updateGoalPlan(userId, goal.id, input, plan);
  db.setCalorieAdjustment(userId, goal.id, 0);
  db.addAdjustment(userId, goal.id, { kind: 'recalc', action: 'recalculated', status: 'accepted',
    reasons: [`أعيد حساب الاحتياجات على متوسط الوزن الحالي ${last.avgWeight} كجم بدل ${goal.input.currentWeight} كجم. متوسط السعرات الجديد ${plan.nutrition.intakeAvg} سعرة/يوم، وأُلغيت التعديلات السابقة لأنها مضمنة في الحساب الجديد.`] });
  return { ok: true };
}

// ---- preferences & weekly plan ----
function prefsOpts(goal) {
  return { sessionsPerWeek: goal ? goal.input.sessionsPerWeek || 0 : 0, minutesPerSession: goal ? goal.input.minutesPerSession || 60 : 60 };
}
function getPrefs(db, userId) {
  const goal = db.activeGoal(userId);
  return weekplan.validatePrefs(db.getPrefs(userId) || {}, prefsOpts(goal)).value;
}
function prefsOptions() {
  const L = listRecipes();
  const { SPORT_NUTRITION, SEASON_PHASES } = require('./engine/energy');
  return { proteinTypes: Object.fromEntries(Object.entries(L.proteinTypes).filter(([k]) => k !== 'mixed')), allergens: L.allergens,
    carbSources: Object.fromEntries(Object.entries(weekplan.CARB_SOURCES).map(([k, v]) => [k, v.ar])), days: weekplan.DAY_AR,
    seasonPhases: Object.fromEntries(Object.entries(SEASON_PHASES).map(([k, v]) => [k, v.ar])),
    sports: Object.fromEntries(Object.entries(SPORT_NUTRITION).map(([k, v]) => [k, v.ar])),
    addable: L.recipes.filter((r) => ['drink', 'sauce'].includes(r.plan.role) || (r.plan.slots.includes('snack') && r.plan.role !== 'main') || r.plan.role === 'dessert')
      .map((r) => ({ id: r.id, ar: r.ar, role: r.plan.role, kcal: r.perServing.kcal, protein: r.perServing.protein, carb: r.perServing.carb, fat: r.perServing.fat, allergens: r.plan.allergens, fasting: r.plan.fasting })) };
}
function savePrefs(db, userId, body) {
  const goal = db.activeGoal(userId);
  const v = weekplan.validatePrefs(body, prefsOpts(goal));
  if (Object.keys(v.errors).length) return { error: 'VALIDATION', errors: v.errors };
  db.setPrefs(userId, v.value);
  return { prefs: v.value };
}
function latestWeight(db, userId, goal) {
  const rows = computeRows(db, userId, goal);
  const last = [...rows].reverse().find((r) => r.avgWeight != null);
  return last ? last.avgWeight : goal.input.currentWeight;
}
function athleteOf(db, userId, goal) {
  return { age: goal.input.age, sex: goal.input.sex, sport: goal.input.sport, seasonPhase: goal.input.isAthlete === false ? null : goal.input.seasonPhase || 'pre_season', isAthlete: goal.input.isAthlete !== false, sessionsPerWeek: goal.input.sessionsPerWeek || 0,
    minutesPerSession: goal.input.minutesPerSession || 60, trainingDays: goal.plan.nutrition.trainingDays || 0, weightKg: latestWeight(db, userId, goal) };
}
const targetsKey = (t) => JSON.stringify([t.trainingDay, t.restDay]);
function getWeekPlan(db, userId, today) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  const plan = db.weekPlan(userId, goal.id);
  const targets = currentTargets(db, userId, goal, undefined, today);
  const prefs = getPrefs(db, userId);
  const comp = db.getCompetition(userId);
  const compDates = comp ? comp.plan.days.map((d) => d.date) : [];
  const scheduled = Object.values(prefs.schedule).reduce((t, l) => t + l.length, 0);
  return { plan, prefs, hasSavedPrefs: !!db.getPrefs(userId), options: prefsOptions(), competitionDates: compDates, sleep: weekplan.sleepAdvice(prefs, goal.input.age),
    scheduleNote: goal.input.sessionsPerWeek && scheduled !== goal.input.sessionsPerWeek
      ? `جدولك فيه ${scheduled} حصة في الأسبوع، والهدف محسوب على ${goal.input.sessionsPerWeek}. السعرات اليومية بتتظبط حسب جدولك، بس يُفضل تحدّث عدد الحصص في الهدف.` : null,
    stale: plan ? (plan.targetsKey !== targetsKey(targets) ? 'targets' : JSON.stringify(plan.prefs) !== JSON.stringify(prefs) ? 'prefs' : null) : null };
}
// Current week plan of another household member (only the dish ids are read from it; see household.js).
function currentPlanOf(db, userId) {
  const g = db.activeGoal(userId);
  return g ? db.weekPlan(userId, g.id) : null;
}
function newWeekPlan(db, userId, today, seed) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  const targets = currentTargets(db, userId, goal, undefined, today);
  let plan;
  const hh = db.householdOf ? household.menuFor(db, userId, (uid) => currentPlanOf(db, uid)) : null;
  try {
    plan = weekplan.generateWeekPlan({ targets, prefs: getPrefs(db, userId), startDate: today, seed, athlete: athleteOf(db, userId, goal), household: hh,
      dataMode: (typeof process !== 'undefined' && process.env && process.env.EKLNI_FOOD_DATA_MODE) || 'estimates' });
  } catch (e) { if (e.code) return { error: e.code, message: e.message }; throw e; }
  plan.targetsKey = targetsKey(targets);
  db.saveWeekPlan(userId, goal.id, plan);
  return getWeekPlan(db, userId, today);
}
function withPlan(db, userId, reason, fn, today) {
  const goal = db.activeGoal(userId);
  const plan = goal && db.weekPlan(userId, goal.id);
  if (!plan) return { error: 'NO_PLAN' };
  delete plan.versionId;
  try { fn(plan); } catch (e) { if (e.code) return { error: e.code, message: e.message }; throw e; }
  db.saveWeekPlan(userId, goal.id, plan, reason);
  return getWeekPlan(db, userId, today);
}
const swapWeekMeal = (db, userId, dayIndex, slotIdx, seed, today) => withPlan(db, userId, 'swap', (p) => weekplan.swapMeal(p, dayIndex, slotIdx, seed), today);
const addWeekExtra = (db, userId, b, today) => withPlan(db, userId, 'extra_add', (p) => weekplan.addExtra(p, b.day, b.recipeId, b.servings, b.attachTo, b.compensate !== false), today);
const removeWeekExtra = (db, userId, b, today) => withPlan(db, userId, 'extra_remove', (p) => weekplan.removeExtra(p, b.day, b.entryId), today);

function weekSauces(db, userId, day, slot) {
  const goal = db.activeGoal(userId);
  const plan = goal && db.weekPlan(userId, goal.id);
  if (!plan) return { error: 'NO_PLAN' };
  try { return weekplan.sauceSuggestions(plan, day, slot); } catch (e) { if (e.code) return { error: e.code, message: e.message }; throw e; }
}

// ---- printable nutrition file ----
function nutritionFile(db, userId, today, branding, shareOpts = null) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  const plan = db.weekPlan(userId, goal.id);
  if (!plan) return { error: 'NO_PLAN', message: 'اعمل خطة الأسبوع الأول.' };
  const st = buildState(db, userId, today);
  // The person's own name from the goal first; an academy display name only as a fallback.
  const name = goal.input.fullName || (db.membershipsOf ? db.membershipsOf(userId) : []).map((m) => m.displayName).find(Boolean);
  const { renderNutritionDoc } = require('./nutritionDoc');
  return { html: renderNutritionDoc({ st, plan, user: db.userById(userId), branding, hydration: getHydration(db, userId), displayName: name, today,
    ...(shareOpts ? { share: true, shareName: shareOpts.showName ? name || null : null } : {}) }) };
}

// ---- plan versions ----
function weekPlanHistory(db, userId) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  return { versions: db.weekPlanHistory(userId, goal.id) };
}
function restoreWeekPlan(db, userId, id, today) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  const plan = db.weekPlanVersion(userId, goal.id, id);
  if (!plan) return { error: 'NOT_FOUND' };
  db.saveWeekPlan(userId, goal.id, plan, `restored:${id}`);
  return getWeekPlan(db, userId, today);
}

// ---- health screening ----
function getScreening(db, userId) {
  const goal = db.activeGoal(userId);
  const answers = db.getScreening(userId);
  return { answers, result: goal ? holdFor(db, userId, goal) : screening.screen(answers, {}), options: {
    menstrual: screening.MENSTRUAL, conditions: screening.CONDITIONS, conditionsAr: screening.CONDITION_AR,
    impairments: screening.IMPAIRMENTS, eating: screening.EATING } };
}
function saveScreening(db, userId, body, today, seed) {
  const v = screening.validateScreening(body);
  if (Object.keys(v.errors).length) return { error: 'VALIDATION', errors: v.errors };
  db.setScreening(userId, v.value);
  const planRefreshed = today ? refreshPlanIfTargetsChanged(db, userId, today, seed) : false;
  return { ...getScreening(db, userId), planRefreshed };
}
// When the daily targets change (screening, self-responsibility, guardian consent), an existing week plan is
// rebuilt from today so the meals match the new calories; the old one stays in the plan history.
function refreshPlanIfTargetsChanged(db, userId, today, seed = 1) {
  const goal = db.activeGoal(userId);
  const plan = goal && db.weekPlan(userId, goal.id);
  if (!plan || plan.targetsKey === targetsKey(currentTargets(db, userId, goal, undefined, today))) return false;
  return !newWeekPlan(db, userId, today, seed).error;
}

// ---- hydration ----
function getHydration(db, userId) {
  const logs = db.hydrationLogs(userId).map((s) => ({ ...s, result: hydration.assessSession(s) }));
  return { logs, summary: hydration.summarize(logs) };
}
function addHydration(db, userId, body, today) {
  const v = hydration.validateSession(body, { today });
  if (Object.keys(v.errors).length) return { error: 'VALIDATION', errors: v.errors };
  db.addHydration(userId, v.value);
  return getHydration(db, userId);
}
function deleteHydration(db, userId, id) { if (!db.deleteHydration(userId, id)) return { error: 'NOT_FOUND' }; return getHydration(db, userId); }

// ---- reference values for the current athlete ----
function getDri(db, userId) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  return { dri: driFor({ age: goal.input.age, sex: goal.input.sex }) };
}

// ---- season phase (changes the safe rate and carbohydrate targets) ----
function setSeasonPhase(db, userId, phase, today) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  if (goal.input.isAthlete === false) return { error: 'NOT_ATHLETE', message: 'مراحل الموسم للرياضيين بس.' };
  const current = latestWeight(db, userId, goal);
  if (reached(goal, current)) return { error: 'TARGET_REACHED' };
  const v = validateGoalInput({ ...goal.input, seasonPhase: phase, currentWeight: current, startDate: today, targetDate: null, weeklyRateKg: null }, { today });
  if (Object.keys(v.errors).length) return { error: 'VALIDATION', errors: v.errors };
  const plan = createPlan(v.value, today, { selfWaiver: !!(db.getSelfWaiver && db.getSelfWaiver(userId)) });
  db.updateGoalPlan(userId, goal.id, { ...goal.input, seasonPhase: v.value.seasonPhase, currentWeight: current }, plan);
  db.setCalorieAdjustment(userId, goal.id, 0);
  db.addAdjustment(userId, goal.id, { kind: 'recalc', action: 'season_phase', status: 'accepted',
    reasons: [`اتغيرت مرحلة الموسم. المعدل الأسبوعي بقى ${plan.effectiveRateKg} كجم، ومتوسط السعرات ${plan.nutrition.intakeAvg} سعرة/يوم.`] });
  return { ok: true };
}

// ---- championship ----
const competition = require('./engine/competition');
function getCompetition(db, userId) { return { competition: db.getCompetition(userId) }; }
function saveCompetition(db, userId, body, today) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL' };
  const v = competition.validateCompetition(body, today);
  if (Object.keys(v.errors).length) return { error: 'VALIDATION', errors: v.errors };
  const plan = competition.buildCompetitionPlan(v.value, athleteOf(db, userId, goal), getPrefs(db, userId));
  db.setCompetition(userId, { input: v.value, plan });
  return getCompetition(db, userId);
}
function deleteCompetition(db, userId) { db.deleteCompetition(userId); return { competition: null }; }

// Adult self-responsibility (0.7.0): recorded only with every acknowledgement ticked; withdrawable at any time.
const WAIVER_VERSION = 1;
function setSelfWaiver(db, userId, body = {}, today, seed = 1) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL', status: 400, message: 'اعمل الهدف الأول.' };
  if (body.accept === false) { db.clearSelfWaiver(userId); const planRefreshed = refreshPlanIfTargetsChanged(db, userId, today, seed); return { ...buildState(db, userId, today), planRefreshed }; }
  if (!(goal.input.age >= 18)) return { error: 'MINOR', status: 403, message: 'الموافقة على المسؤولية الشخصية للكبار بس (18 سنة أو أكتر)؛ للأقل من 18 لازم موافقة ولي الأمر.' };
  if (body.adult !== true || body.understood !== true || body.responsibility !== true) return { error: 'CONFIRM_REQUIRED', status: 400, message: 'علّم على كل الإقرارات علشان تكمّل على مسؤوليتك.' };
  db.setSelfWaiver(userId, WAIVER_VERSION);
  const planRefreshed = refreshPlanIfTargetsChanged(db, userId, today, seed);
  return { ...buildState(db, userId, today), planRefreshed };
}

// ---- logged intake (audit 2026-10-22, F1): planned ≠ logged ≠ target ----
function intakeWeek(db, userId, today) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL', status: 400, message: 'اعمل الهدف الأول.' };
  const plan = db.weekPlan(userId, goal.id);
  if (!plan) return { error: 'NO_PLAN', status: 400, message: 'اعمل خطة الأسبوع الأول.' };
  const from = plan.days[0].date, to = plan.days[plan.days.length - 1].date;
  const byDate = {};
  for (const l of db.mealLogs(userId, from, to)) (byDate[l.date] ||= []).push(l);
  return { today, ...intake.weekSummary(plan, byDate, (d) => d.targets), statuses: intake.STATUS_AR };
}
function logIntake(db, userId, body = {}, today) {
  const goal = db.activeGoal(userId);
  if (!goal) return { error: 'NO_GOAL', status: 400, message: 'اعمل الهدف الأول.' };
  const plan = db.weekPlan(userId, goal.id);
  const day = plan && plan.days.find((d) => d.date === body.date);
  if (!day) return { error: 'VALIDATION', status: 400, message: 'اليوم ده مش في خطة الأسبوع الحالية.' };
  if (body.date > today) return { error: 'VALIDATION', status: 400, message: 'مينفعش تسجل أكل ليوم لسه ما جاش.' };
  if (body.clear === true) { db.deleteMealLog(userId, body.date, String(body.key || '')); return intakeWeek(db, userId, today); }
  const v = intake.validateLog(body);
  if (Object.keys(v.errors).length) return { error: 'VALIDATION', status: 400, errors: v.errors, message: Object.values(v.errors)[0] };
  const entry = intake.makeEntry(day, String(body.key || ''), v.value.status, v.value.fraction);
  if (!entry) return { error: 'VALIDATION', status: 400, message: 'الوجبة دي مش في اليوم ده.' };
  db.setMealLog(userId, goal.id, body.date, entry.key, entry);
  return intakeWeek(db, userId, today);
}

// ---- dietitian plan review (audit 2026-10-22, F2) ----
// The review is bound to a fingerprint of the targets it was given for: if the targets change (recalculation,
// adjustment, hold, override) the review no longer applies and the plan shows as "not reviewed in its current form".
function planFingerprint(goal, targets) {
  const pick = (d) => d && [d.kcal, d.proteinG, d.carbG, d.fatG];
  const basis = JSON.stringify([goal.id, goal.weeklyRateKg, pick(targets.trainingDay), pick(targets.restDay), !!targets.maintenanceHold, targets.override ? targets.override.kcal : null]);
  // change detection only (not a security hash); pure JS so the browser demo can run it — FNV-1a, two seeds
  const fnv = (str, h) => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); };
  return fnv(basis, 2166136261) + fnv(basis, 3735928559);
}
const REVIEW_AR = { approved: 'وافق الأخصائي', revision_requested: 'الأخصائي طلب تعديل', rejected: 'الأخصائي رفض الخطة', referred: 'الأخصائي حوّل لطبيب/مختص' };
function planReviewState(db, userId, goal, targets, plan) {
  const all = db.planReviews ? db.planReviews(userId, goal.id) : [];
  const last = all[all.length - 1] || null;
  const fp = planFingerprint(goal, targets);
  const needed = !!(plan && plan.requiresProfessional);
  if (!last) return { state: 'none', needed, text: needed ? 'الخطة دي محتاجة مراجعة أخصائي، ولسه ما اتراجعتش.' : 'الخطة ما اتراجعتش من أخصائي.', history: 0 };
  const current = last.fingerprint === fp;
  return { state: current ? 'current' : 'outdated', needed, decision: last.decision, decisionAr: REVIEW_AR[last.decision], note: last.note, at: last.at, calcVersion: last.calcVersion,
    text: current ? `${REVIEW_AR[last.decision]} (${last.at.slice(0, 10)}).` : `آخر مراجعة (${REVIEW_AR[last.decision]}، ${last.at.slice(0, 10)}) كانت على أهداف قديمة؛ الخطة الحالية ما اتراجعتش.`,
    history: all.length };
}

module.exports = { intakeWeek, logIntake, planFingerprint, planReviewState, REVIEW_AR, setCalorieOverride, calorieOverrideInfo, OVERRIDE_MAX_DAYS, setSelfWaiver, WAIVER_VERSION, currentPlanOf, buildState, proposeAdjustment, decideAdjustment, recalculate, guardAdjustment, adjustedTargets,
  getPrefs, savePrefs, getWeekPlan, newWeekPlan, swapWeekMeal, addWeekExtra, removeWeekExtra, prefsOptions,
  setSeasonPhase, getCompetition, saveCompetition, deleteCompetition, weekPlanHistory, restoreWeekPlan, weekSauces, nutritionFile,
  getScreening, saveScreening, getHydration, addHydration, deleteHydration, getDri, currentTargets, holdFor };
