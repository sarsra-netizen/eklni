'use strict';
const { round } = require('./calculator');
const { diffDays } = require('./dates');
const { trainingLoad } = require('./rate');

// 0.7.0 — weight-GAIN goals (reviewer request 2026-10-22).
// Every number in GAIN_GOALS is an APP RULE proposed by the developer and approved by the reviewer
// (أحمد ربيع حسين, 2026-10-22; SCIENCE_REVIEW.md R-G1…R-G6). They are not taken from an uploaded reference.
const GAIN_GOALS = {
  muscle_gain: { ar: 'زيادة الكتلة العضلية', recPct: 0.25, maxPct: 0.5, surplusMaxFraction: 0.15, proteinPerKg: 2.0, fatPct: 0.25 },
  weight_gain: { ar: 'زيادة الدهون والكتلة العضلية', recPct: 0.5, maxPct: 0.75, surplusMaxFraction: 0.20, proteinPerKg: 1.8, fatPct: 0.30 },
  fat_gain:    { ar: 'زيادة الدهون فقط', recPct: 0.75, maxPct: 1.0, surplusMaxFraction: 0.25, proteinPerKg: 1.6, fatPct: 0.35 },
};
const GAIN_MINOR_MAX_PCT = 0.5;      // app rule: under 18, gain no faster than 0.5% of body weight a week
const GAIN_IN_SEASON_MAX_PCT = 0.25; // app rule: in-season / competition within 4 weeks
const GAIN_MIN_PCT = 0.1;

const isGainGoal = (g) => Object.prototype.hasOwnProperty.call(GAIN_GOALS, g);

function recommendGainRate(p, today) {
  const cfg = GAIN_GOALS[p.primaryGoal];
  const reasons = [`${cfg.ar}: المعدل الموصى به ${cfg.recPct}% من الوزن أسبوعيًا وأقصاه ${cfg.maxPct}% (قاعدة تطبيق راجعها أخصائي التغذية).`];
  const flags = ['GAIN'];
  let pct = cfg.recPct, capPct = cfg.maxPct, requiresProfessional = false;
  const cap = (c, why) => { if (c < capPct) capPct = c; reasons.push(why); };
  if (p.age != null && p.age < 18) {
    cap(GAIN_MINOR_MAX_PCT, 'أقل من 18 سنة: الزيادة لحد 0.5% من الوزن أسبوعيًا، والنمو نفسه بيزوّد الوزن.');
    flags.push('MINOR');
    if (p.primaryGoal === 'fat_gain') { requiresProfessional = true; reasons.push('زيادة الدهون فقط لأقل من 18 سنة محتاجة متابعة أخصائي.'); }
  }
  if (p.seasonPhase === 'in_season') cap(GAIN_IN_SEASON_MAX_PCT, 'فترة المنافسات: زيادة بطيئة عشان الأداء والوزن في الفئة.');
  if (p.competitionDate && today) {
    const d = diffDays(today, p.competitionDate);
    if (d >= 0 && d <= 28) { cap(GAIN_IN_SEASON_MAX_PCT, 'المنافسة خلال 4 أسابيع؛ الأولوية للأداء.'); flags.push('COMPETITION_SOON'); }
  }
  if (p.medicalCondition || p.weightMedication) {
    requiresProfessional = true; flags.push('MEDICAL');
    reasons.push('توجد حالة طبية أو أدوية قد تؤثر في الوزن؛ راجع الطبيب قبل تطبيق الخطة.');
  }
  if (p.pregnantOrBreastfeeding) {
    requiresProfessional = true; flags.push('PREGNANCY');
    reasons.push('الحمل أو الرضاعة: الاحتياج بيتحدد بإشراف طبي، والخطة هنا تقريبية.');
  }
  pct = Math.min(pct, capPct);
  const minPct = Math.min(GAIN_MIN_PCT, capPct);
  return {
    direction: 'gain',
    recommendedPct: round(pct, 2),
    recommendedKg: round((pct / 100) * p.weightKg, 2),
    allowedRangePct: [minPct, round(capPct, 2)],
    allowedRangeKg: [round((minPct / 100) * p.weightKg, 2), round((capPct / 100) * p.weightKg, 2)],
    trainingLoad: trainingLoad(p),
    leanness: null,
    requiresProfessional, flags, reasons,
    note: 'معدلات الزيادة هنا قواعد تطبيق راجعها أخصائي التغذية، مش أرقام من مرجع منشور.',
  };
}

// Day macros for a surplus: protein fixed per kg, fat a fixed share of energy, carbohydrate the remainder.
function gainDayMacros({ kcal, weightKg, proteinG, fatPct, carbTargetG }) {
  const fatG = Math.max(0.6 * weightKg, (fatPct * kcal) / 9);
  const carbG = Math.max(0, (kcal - proteinG * 4 - fatG * 9) / 4);
  return require('./energy').annotateMacros({
    kcal: Math.round(kcal), proteinG: Math.round(proteinG), carbG: Math.round(carbG), fatG: Math.round(fatG),
    fiberG: Math.round((kcal / 1000) * 14), carbTargetG: Math.round(carbTargetG), carbShortfall: carbG < carbTargetG - 1,
  }, weightKg);
}

// Same output shape as energy.buildPlan so the week plan, reports and UI keep working.
// dailyDeficit is NEGATIVE for a surplus; dailySurplus is the positive figure.
function buildGainPlan(p, weeklyRateKg, energy) {
  const cfg = GAIN_GOALS[p.primaryGoal];
  const { energyNeeds, fatFreeMass, carbPerKg, eaStatus, KCAL_PER_KG, athleteGuidance, SPORTS } = energy;
  const needs = energyNeeds(p);
  const ffm = fatFreeMass(p);
  const warnings = [];
  let requiresProfessional = false;
  const raw = (weeklyRateKg * KCAL_PER_KG) / 7;
  let surplus = raw;
  const limits = [];
  const maxSurplus = needs.tdeeAvg * cfg.surplusMaxFraction;
  if (surplus > maxSurplus) {
    surplus = maxSurplus; limits.push('SURPLUS_FRACTION');
    warnings.push(`الزيادة المحسوبة (${Math.round(raw)} سعرة/يوم) أكبر من ${Math.round(cfg.surplusMaxFraction * 100)}% من احتياجك؛ اتحددت بـ ${Math.round(maxSurplus)} سعرة.`);
  }
  const intakeAvg = needs.tdeeAvg + surplus;
  const ea = (intakeAvg - needs.exercise.dailyAvgKcal) / ffm.kg;
  const effectiveRateKg = (surplus * 7) / KCAL_PER_KG;
  const tDays = needs.exercise.trainingDays;
  const rDays = 7 - tDays;
  const load = trainingLoad(p);
  const proteinG = cfg.proteinPerKg * p.weightKg;
  const mk = (tdee, trainingDay) => gainDayMacros({ kcal: tdee + surplus, weightKg: p.weightKg, proteinG, fatPct: cfg.fatPct, carbTargetG: carbPerKg(load, trainingDay, p) * p.weightKg });
  const trainingDay = tDays > 0 ? mk(needs.tdeeTrainingDay, true) : null;
  const restDay = rDays > 0 ? mk(needs.tdeeRestDay, false) : null;
  if (p.primaryGoal === 'muscle_gain' && !(p.sessionsPerWeek >= 2)) warnings.push('زيادة الكتلة العضلية محتاجة تمرين مقاومة منتظم (مرتين في الأسبوع على الأقل)؛ من غيره الزيادة هتبقى دهون غالبًا.');
  if (p.primaryGoal === 'fat_gain') warnings.push('هدف زيادة الدهون فقط: تابع محيط الوسط والضغط والسكر مع طبيبك لو الوزن المستهدف عالي.');
  if (ffm.estimated) warnings.push(`الكتلة الخالية من الدهون مقدّرة (${ffm.method})؛ الحسابات تقريبية.`);
  if (needs.exercise.sportEstimate) warnings.push(`طاقة التمرين لـ«${(SPORTS[p.sport] || {}).ar}» مقدّرة؛ الحساب تقريبي.`);
  const mealsPerDay = 4;
  return {
    direction: 'gain',
    needs, fatFreeMass: ffm, kcalPerKgFactor: KCAL_PER_KG,
    requestedRateKg: weeklyRateKg,
    rawDailyDeficit: -Math.round(raw),
    dailyDeficit: -Math.round(surplus),
    dailySurplus: Math.round(surplus),
    deficitPctOfTdee: -round((surplus / needs.tdeeAvg) * 100, 1),
    surplusPctOfTdee: round((surplus / needs.tdeeAvg) * 100, 1),
    effectiveRateKg: round(effectiveRateKg, 2),
    deficitLimited: limits,
    intakeAvg: Math.round(intakeAvg),
    energyAvailability: round(ea, 1),
    energyAvailabilityStatus: (p.sessionsPerWeek || 0) > 0 ? eaStatus(ea) : null,
    proteinPerKg: cfg.proteinPerKg,
    fatPctOfKcal: cfg.fatPct,
    proteinPerMealG: Math.round(proteinG / mealsPerDay),
    mealsPerDay, trainingDay, restDay, trainingDays: tDays,
    requiresProfessional, warnings,
    athleteGuidance: athleteGuidance(p, load),
    note: 'معامل 7700 سعرة/كجم تقريب حسابي للبداية فقط (تكلفة بناء العضل غير تكلفة الدهون)؛ الخطة تتعاير حسب متوسط الوزن الفعلي.',
  };
}

module.exports = { GAIN_GOALS, GAIN_MINOR_MAX_PCT, GAIN_IN_SEASON_MAX_PCT, isGainGoal, recommendGainRate, buildGainPlan, gainDayMacros };
