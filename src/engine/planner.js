'use strict';
const { recommendRate, checkCustomRate } = require('./rate');
const { calcTimeline, evaluateTargetDate, round } = require('./calculator');
const { buildPlan, NON_EXERCISE_PAL, INTENSITY_FACTOR, KCAL_PER_KG } = require('./energy');
const { CALC_VERSION } = require('./version');

// Orchestrates sections 1–5: from validated goal input to a full starting plan.
function createPlan(input, today, opts = {}) {
  const profile = { ...input, weightKg: input.currentWeight, selfWaiver: !!opts.selfWaiver };
  const rec = recommendRate(profile, today);
  const direction = rec.direction || 'loss';
  const warnings = [];
  let requiresProfessional = rec.requiresProfessional || !!input.requiresProfessional;

  let chosenRateKg = rec.recommendedKg;
  let rateSource = 'recommended';
  if (input.weeklyRateKg != null) {
    const chk = checkCustomRate(input.weeklyRateKg, rec, input.currentWeight);
    if (!chk.ok) { const e = new Error(chk.message); e.code = chk.code; e.field = 'weeklyRateKg'; e.recommendation = rec; throw e; }
    if (chk.warning) warnings.push(chk.warning);
    chosenRateKg = input.weeklyRateKg;
    rateSource = 'custom';
  }

  const nutrition = buildPlan(profile, chosenRateKg);
  if (nutrition.requiresProfessional) requiresProfessional = true;
  let effectiveRateKg = chosenRateKg;
  if (nutrition.effectiveRateKg < chosenRateKg - 0.005) {
    effectiveRateKg = Math.max(nutrition.effectiveRateKg, 0.01);
    warnings.push(`لأسباب وقائية، ${direction === 'gain' ? 'الزيادة المطبقة' : 'العجز المطبق'} يقابل معدلًا تقريبيًا ${round(effectiveRateKg, 2)} كجم/أسبوع بدلًا من ${chosenRateKg}؛ الجدول الزمني محسوب على هذا المعدل.`);
  }

  const timeline = calcTimeline({ currentWeight: input.currentWeight, targetWeight: input.targetWeight, weeklyRateKg: effectiveRateKg, startDate: input.startDate, direction });
  let targetDateCheck = null;
  if (input.targetDate) {
    targetDateCheck = evaluateTargetDate({
      currentWeight: input.currentWeight, targetWeight: input.targetWeight, startDate: input.startDate,
      targetDate: input.targetDate, direction,
      // the safe maximum is the lower of the personalised cap and what the deficit guards actually allow
      maxSafeRateKg: Math.min(rec.allowedRangeKg[1], buildPlan(profile, rec.allowedRangeKg[1]).effectiveRateKg),
      recommendedRateKg: Math.min(rec.recommendedKg, buildPlan(profile, rec.recommendedKg).effectiveRateKg),
    });
    if (!targetDateCheck.feasible && targetDateCheck.message) warnings.push(targetDateCheck.message);
  }

  const nd = nutrition.needs;
  // Audit 2026-10-22 (F4): which method and assumptions produced this plan.
  const methods = {
    rmr: { kcal: nd.bmr, equation: nd.bmrEquation, key: nd.bmrKey, source: nd.bmrSource, prediction: nd.bmrKey !== 'measured',
      inputs: { weightKg: input.currentWeight, heightCm: input.heightCm, age: input.age, sex: input.sex, bodyFatPct: input.bodyFatPct ?? null, bodyFatMethod: input.bodyFatMethod ?? null } },
    nonExercise: { activityLevel: input.activityLevel, pal: NON_EXERCISE_PAL[input.activityLevel] || 1.2, rule: 'R-E5' },
    exercise: { sport: input.sport, metUsed: nd.exercise.metUsed, intensity: input.intensity, intensityFactor: INTENSITY_FACTOR[input.intensity] || 1,
      sessionsPerWeek: input.sessionsPerWeek, minutesPerSession: input.minutesPerSession, netMet: true, rule: 'R-E6 / R-E8', source: 'Compendium of Physical Activities (rounded)' },
    tdee: { avg: nd.tdeeAvg, range: nd.tdeeRange, estimate: true },
    energyChange: { kcalPerKg: KCAL_PER_KG, approximation: true, rule: 'R-W4' },
    rules: direction === 'gain' ? ['R-G1', 'R-G2', 'R-G3', 'R-G5'] : ['R-W1', 'R-W2', 'R-W3', 'R-W5', 'R-C1', 'R-C2'],
    fatFreeMass: { kg: nutrition.fatFreeMass.kg, method: nutrition.fatFreeMass.method, estimated: nutrition.fatFreeMass.estimated },
  };
  return {
    calcVersion: CALC_VERSION,
    methods,
    direction,
    recommendation: rec,
    rateSource,
    chosenRateKg,
    effectiveRateKg: round(effectiveRateKg, 2),
    timeline,
    targetDateCheck,
    nutrition,
    requiresProfessional,
    warnings: [...warnings, ...nutrition.warnings],
  };
}

module.exports = { createPlan };
