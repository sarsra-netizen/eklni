'use strict';
const { round } = require('./calculator');
const { bodyFatInfo, trainingLoad, weeklyTrainingHours, leanness } = require('./rate');

// Section 4/5 — energy needs, deficit, macros, athletic muscle-preservation mode.

const KCAL_PER_KG = 7700; // arithmetic approximation only (not a physiological model)
const MAX_DEFICIT_FRACTION = 0.35; // reviewer decision 2026-10-22 (was 0.25); EA ≥30 still applies
const MAX_DEFICIT_FRACTION_MINOR = 0.15; // app rule for 12–17 y with guardian consent (SCIENCE_REVIEW.md R-W6)
const EA_THRESHOLD = 30; // kcal/kg FFM/day — below this, low energy availability risk

// Non-exercise daily life only (job, steps, chores). Training is added separately
// with NET METs, so sport energy is never counted twice.
const NON_EXERCISE_PAL = { sedentary: 1.2, light: 1.3, active: 1.4, very_active: 1.5 };

// MET values at moderate intensity (Compendium of Physical Activities, rounded).
// Fin swimming has no dedicated compendium entry; treated as vigorous swimming (estimate).
const SPORTS = {
  swimming:     { ar: 'السباحة', met: 7.0 },
  fin_swimming: { ar: 'سباحة الزعانف', met: 8.0, estimate: true },
  strength:     { ar: 'تدريب القوة', met: 5.0 },
  running:      { ar: 'الجري', met: 9.0 },
  cycling:      { ar: 'الدراجات', met: 7.5 },
  endurance:    { ar: 'رياضات التحمل', met: 8.0 },
  team_sports:  { ar: 'الرياضات الجماعية', met: 7.0 },
  general:      { ar: 'نشاط عام', met: 5.0 },
  // added 0.7.0 — values typed from general knowledge, NOT verified (see SCIENCE_REVIEW.md R-E7)
  fencing:      { ar: 'السلاح (المبارزة)', met: 6.0 },
  modern_pentathlon: { ar: 'الخماسي الحديث', met: 7.0, estimate: true },
  triathlon:    { ar: 'الثلاثي (الترايثلون)', met: 8.0, estimate: true },
};
const INTENSITY_FACTOR = { low: 0.75, moderate: 1.0, high: 1.2 };

function fatFreeMass(p) {
  const bf = bodyFatInfo(p);
  if (bf.usable) return { kg: round(p.weightKg * (1 - bf.pct / 100), 1), estimated: bf.reliability === 'low', method: 'من نسبة الدهون' };
  // Boer (1984) lean body mass estimate from height/weight/sex
  const h = p.heightCm, w = p.weightKg;
  const kg = p.sex === 'male' ? 0.407 * w + 0.267 * h - 19.2 : 0.252 * w + 0.473 * h - 48.3;
  return { kg: round(kg, 1), estimated: true, method: 'تقدير Boer من الطول والوزن' };
}

// Resting energy. Order of preference (broad2019, ch.3 / Table 3.1):
//  1) measured RMR (indirect calorimetry) entered by a professional;
//  2) Cunningham (1980): 500 + 22 × LBM, when lean mass comes from a reliable method (DEXA / skinfolds);
//  3) Mifflin-St Jeor (1990) from weight, height, age, sex otherwise.
function bmr(p) {
  if (p.measuredRmr != null) {
    return { kcal: Math.round(p.measuredRmr), equation: 'RMR مقاس (Indirect calorimetry)', key: 'measured', source: 'measured' };
  }
  const bf = bodyFatInfo(p);
  if (bf.usable && (bf.reliability === 'high' || bf.reliability === 'medium')) {
    const ffm = fatFreeMass(p).kg;
    return { kcal: Math.round(500 + 22 * ffm), equation: 'Cunningham 1980 (500 + 22 × الكتلة الخالية من الدهون)', key: 'cunningham', source: 'broad2019' };
  }
  const base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
  return { kcal: Math.round(p.sex === 'male' ? base + 5 : base - 161), equation: 'Mifflin-St Jeor 1990', key: 'mifflin', source: 'broad2019' };
}

// Energy availability bands (broad2019 ch.4, §4.2): ≥45 adequate; 30–45 reduced (tolerable short-term
// for body-mass loss); <30 low energy availability.
function eaStatus(ea) {
  if (ea == null || !Number.isFinite(ea)) return null;
  if (ea >= 45) return { band: 'adequate', ar: 'كافٍ (≥45)' };
  if (ea >= 30) return { band: 'reduced', ar: 'منخفض نسبيًا (30–45) — مقبول لفترة قصيرة أثناء خسارة الوزن' };
  return { band: 'low', ar: 'منخفض (<30) — خطر نقص توافر الطاقة' };
}

function exerciseEnergy(p) {
  const sport = SPORTS[p.sport] || SPORTS.general;
  const met = sport.met * (INTENSITY_FACTOR[p.intensity] || 1);
  const hours = (p.minutesPerSession || 0) / 60;
  // NET kcal = (MET − 1) × kg × h → subtracts resting energy already in BMR
  const perSession = Math.max(0, (met - 1) * p.weightKg * hours);
  const sessions = p.sessionsPerWeek || 0;
  const weekly = perSession * sessions;
  const trainingDays = Math.min(7, sessions);
  return {
    perSessionKcal: Math.round(perSession),
    weeklyKcal: Math.round(weekly),
    dailyAvgKcal: Math.round(weekly / 7),
    trainingDays,
    perTrainingDayKcal: trainingDays ? Math.round(weekly / trainingDays) : 0,
    metUsed: round(met, 1),
    sportEstimate: !!sport.estimate,
  };
}

// Audit 2026-10-22 (F3): TDEE is an estimate, so a scenario range is shown next to it, built ONLY from the app's
// own tables: one activity level and one training-intensity level lower / higher. It is a scenario range,
// not a statistical confidence interval.
const PAL_ORDER = ['sedentary', 'light', 'active', 'very_active'];
const INT_ORDER = ['low', 'moderate', 'high'];
function shift(order, v, d) { const i = order.indexOf(v); return i < 0 ? v : order[Math.max(0, Math.min(order.length - 1, i + d))]; }
function tdeeRange(p) {
  const at = (d) => {
    const q = { ...p, activityLevel: shift(PAL_ORDER, p.activityLevel || 'sedentary', d), intensity: shift(INT_ORDER, p.intensity || 'moderate', d) };
    const b = bmr(q).kcal;
    return Math.round(b * (NON_EXERCISE_PAL[q.activityLevel] || 1.2) + exerciseEnergy(q).dailyAvgKcal);
  };
  return { low: at(-1), high: at(1), basis: 'سيناريو: مستوى نشاط وشدة تمرين أقل بدرجة / أعلى بدرجة من جداول التطبيق (مش فترة ثقة إحصائية).' };
}

function energyNeeds(p) {
  const b = bmr(p);
  const pal = NON_EXERCISE_PAL[p.activityLevel] || 1.2;
  const nonEx = b.kcal * pal;
  const ex = exerciseEnergy(p);
  return {
    bmr: b.kcal,
    bmrEquation: b.equation,
    bmrKey: b.key,
    bmrSource: b.source,
    nonExercisePAL: pal,
    nonExerciseKcal: Math.round(nonEx),
    exercise: ex,
    tdeeAvg: Math.round(nonEx + ex.dailyAvgKcal),
    tdeeTrainingDay: Math.round(nonEx + ex.perTrainingDayKcal),
    tdeeRestDay: Math.round(nonEx),
    tdeeRange: tdeeRange(p),
    rmrIsPrediction: b.key !== 'measured',
  };
}

// Audit 2026-10-22 (F5): every day target carries its macro-derived energy (Atwater 4/4/9), the gap to the calorie
// target (rounding), g/kg for each macro and fat as % of energy — computed here once, shown everywhere.
const ATWATER = { protein: 4, carb: 4, fat: 9 };
function annotateMacros(d, weightKg) {
  if (!d) return d;
  const macroKcal = Math.round(d.proteinG * ATWATER.protein + d.carbG * ATWATER.carb + d.fatG * ATWATER.fat);
  return { ...d, macroKcal, macroGapKcal: macroKcal - d.kcal,
    proteinGPerKg: weightKg ? round(d.proteinG / weightKg, 2) : null, carbGPerKg: weightKg ? round(d.carbG / weightKg, 2) : null,
    fatGPerKg: weightKg ? round(d.fatG / weightKg, 2) : null, fatPctKcal: d.kcal > 0 ? round((d.fatG * 9 / d.kcal) * 100, 1) : null,
    proteinPctKcal: d.kcal > 0 ? round((d.proteinG * 4 / d.kcal) * 100, 1) : null, carbPctKcal: d.kcal > 0 ? round((d.carbG * 4 / d.kcal) * 100, 1) : null };
}

function proteinPerKg(p, deficitFraction) {
  let g = 1.8;
  if ((SPORT_NUTRITION[p.sport] || {}).proteinMin) g = Math.max(g, SPORT_NUTRITION[p.sport].proteinMin);
  const athlete = (p.sessionsPerWeek || 0) >= 3 || p.athleteMode;
  if (athlete || p.primaryGoal === 'preserve_muscle') g = Math.max(g, 2.0);
  const lean = leanness(p);
  if (lean === 'lean' || lean === 'very_lean' || deficitFraction >= 0.2) g = 2.2;
  return Math.min(g, 2.4);
}

// Carbohydrate by training volume (lower end of sports-nutrition ranges because of the deficit).
// Sport and season adjust carbohydrate (g/kg) on top of training load.
const SPORT_NUTRITION = {
  swimming: { carbAdj: 0.5, kind: 'endurance', ar: 'السباحة' },
  fin_swimming: { carbAdj: 0.5, kind: 'endurance', ar: 'سباحة الزعانف' },
  running: { carbAdj: 0.5, kind: 'endurance', ar: 'الجري' },
  cycling: { carbAdj: 0.5, kind: 'endurance', ar: 'الدراجات' },
  endurance: { carbAdj: 1, kind: 'endurance', ar: 'رياضات التحمل' },
  team_sports: { carbAdj: 0, kind: 'intermittent', ar: 'الرياضات الجماعية' },
  strength: { carbAdj: -0.5, kind: 'strength', proteinMin: 2.0, ar: 'تدريب القوة' },
  general: { carbAdj: 0, kind: 'general', ar: 'نشاط عام' },
  fencing: { carbAdj: 0, kind: 'intermittent', ar: 'السلاح (المبارزة)' },
  modern_pentathlon: { carbAdj: 0.5, kind: 'intermittent', ar: 'الخماسي الحديث' },
  triathlon: { carbAdj: 1, kind: 'endurance', ar: 'الثلاثي (الترايثلون)' },
};
const SEASON_PHASES = {
  off_season: { ar: 'خارج الموسم', carbAdj: -0.5, maxRatePct: 1.0 },
  pre_season: { ar: 'فترة الإعداد', carbAdj: 0, maxRatePct: 0.75 },
  in_season: { ar: 'فترة المنافسات', carbAdj: 0.5, maxRatePct: 0.4 },
  transition: { ar: 'الراحة الانتقالية', carbAdj: -0.5, maxRatePct: 0.75 },
};
// App rule (see SCIENCE_REVIEW.md R-C1): base training-day carbohydrate (g/kg) by load, during a deficit.
const CARB_BASE = { low: 3, moderate: 4, high: 5, very_high: 6 };
function carbPerKg(load, trainingDay, p = {}) {
  const t = CARB_BASE[load];
  const sport = SPORT_NUTRITION[p.sport] || SPORT_NUTRITION.general;
  const phase = SEASON_PHASES[p.seasonPhase] || SEASON_PHASES.pre_season;
  const train = Math.max(2.5, t + sport.carbAdj + phase.carbAdj);
  return trainingDay ? train : Math.max(2, train - 1.5);
}

function dayMacros({ kcal, weightKg, proteinG, carbTargetG }) {
  const fatMinG = Math.max(0.6 * weightKg, (0.2 * kcal) / 9);
  const proteinKcal = proteinG * 4;
  let carbG = carbTargetG;
  let fatG = (kcal - proteinKcal - carbG * 4) / 9;
  let carbShortfall = false;
  if (fatG < fatMinG) {
    fatG = fatMinG;
    carbG = Math.max(0, (kcal - proteinKcal - fatG * 9) / 4);
    carbShortfall = carbG < carbTargetG - 1;
  }
  return annotateMacros({
    kcal: Math.round(kcal),
    proteinG: Math.round(proteinG),
    carbG: Math.round(carbG),
    fatG: Math.round(fatG),
    fiberG: Math.round((kcal / 1000) * 14),
    carbTargetG: Math.round(carbTargetG),
    carbShortfall,
  }, weightKg);
}

// Builds the starting nutrition plan for a weekly loss rate.
function buildPlan(p, weeklyRateKg) {
  const gain = require('./gain');
  if (gain.isGainGoal(p.primaryGoal)) return gain.buildGainPlan(p, weeklyRateKg, module.exports);
  const needs = energyNeeds(p);
  const warnings = [];
  let requiresProfessional = false;
  const ffm = fatFreeMass(p);

  const rawDeficit = (weeklyRateKg * KCAL_PER_KG) / 7;
  let deficit = rawDeficit;
  const limits = [];

  const minor = p.age != null && p.age < 18;
  const frac = minor ? MAX_DEFICIT_FRACTION_MINOR : MAX_DEFICIT_FRACTION;
  const maxByFraction = needs.tdeeAvg * frac;
  if (minor && weeklyRateKg > 0) {
    requiresProfessional = true;
    warnings.push('لاعب أقل من 18 سنة: العجز محدود بـ 15% من الاحتياج والمعدل بـ 0.5% من الوزن أسبوعيًا، ويُنصح بمتابعة أخصائي تغذية رياضية.');
  }
  if (deficit > maxByFraction) {
    deficit = maxByFraction;
    limits.push('FRACTION');
    requiresProfessional = true;
    warnings.push(`العجز المحسوب (${Math.round(rawDeficit)} سعرة/يوم) يتجاوز ${Math.round(frac * 100)}% من احتياجك؛ خُفّض إلى ${Math.round(maxByFraction)} سعرة. العجز الأكبر يحتاج مراجعة أخصائي تغذية رياضية.`);
  }
  // Energy availability guard for anyone who trains: intake must leave ≥30 kcal/kg FFM after exercise.
  if ((p.sessionsPerWeek || 0) > 0) {
    const minIntake = EA_THRESHOLD * ffm.kg + needs.exercise.dailyAvgKcal;
    const maxByEA = needs.tdeeAvg - minIntake;
    if (deficit > maxByEA) {
      deficit = Math.max(0, maxByEA);
      limits.push('ENERGY_AVAILABILITY');
      warnings.push('العجز المطلوب كان سيخفض توافر الطاقة (Energy Availability) عن 30 سعرة لكل كجم كتلة خالية من الدهون، وهذا يرتبط بمخاطر صحية وتراجع الأداء (RED-S)؛ لذلك قُلّل العجز تلقائيًا. أي عجز أكبر يحتاج إشراف أخصائي تغذية رياضية.');
    }
  }

  const intakeAvg = needs.tdeeAvg - deficit;
  const ea = (intakeAvg - needs.exercise.dailyAvgKcal) / ffm.kg;
  const deficitFraction = deficit / needs.tdeeAvg;
  const effectiveRateKg = (deficit * 7) / KCAL_PER_KG;

  // Periodize: smaller deficit on training days, larger (capped) on rest days, same weekly total.
  const tDays = needs.exercise.trainingDays;
  const rDays = 7 - tDays;
  let trainDeficit = deficit, restDeficit = deficit;
  if (tDays > 0 && rDays > 0) {
    trainDeficit = deficit * 0.7;
    restDeficit = (deficit * 7 - trainDeficit * tDays) / rDays;
    const restCap = needs.tdeeRestDay * 0.25;
    if (restDeficit > restCap) {
      restDeficit = restCap;
      trainDeficit = (deficit * 7 - restDeficit * rDays) / tDays;
    }
  }

  const load = trainingLoad(p);
  const protPerKg = proteinPerKg(p, deficitFraction);
  const proteinG = protPerKg * p.weightKg;

  const trainingDay = tDays > 0 ? dayMacros({
    kcal: needs.tdeeTrainingDay - trainDeficit, weightKg: p.weightKg, proteinG,
    carbTargetG: carbPerKg(load, true, p) * p.weightKg,
  }) : null;
  const restDay = rDays > 0 ? dayMacros({
    kcal: needs.tdeeRestDay - restDeficit, weightKg: p.weightKg, proteinG,
    carbTargetG: carbPerKg(load, false, p) * p.weightKg,
  }) : null;

  if (trainingDay && trainingDay.carbShortfall) {
    warnings.push('السعرات في أيام التدريب لا تكفي لتغطية احتياج الكربوهيدرات المناسب لحجم تدريبك؛ يُفضل اختيار معدل خسارة أبطأ.');
  }
  if (ea < 35 && !limits.includes('ENERGY_AVAILABILITY') && (p.sessionsPerWeek || 0) > 0) {
    warnings.push('توافر الطاقة قريب من الحد الأدنى؛ راقب الأداء والتعافي والدورة الشهرية (للإناث).');
  }
  if (ffm.estimated) warnings.push(`الكتلة الخالية من الدهون مقدّرة (${ffm.method})؛ الحسابات تقريبية.`);
  if (needs.exercise.sportEstimate) warnings.push(`طاقة التمرين لـ«${(SPORTS[p.sport] || {}).ar}» مقدّرة (MET تقديري من غير قيمة مرجعية خاصة)؛ الحساب تقريبي.`);

  const mealsPerDay = 4;
  return {
    needs,
    fatFreeMass: ffm,
    kcalPerKgFactor: KCAL_PER_KG,
    requestedRateKg: weeklyRateKg,
    rawDailyDeficit: Math.round(rawDeficit),
    dailyDeficit: Math.round(deficit),
    deficitPctOfTdee: round(deficitFraction * 100, 1),
    effectiveRateKg: round(effectiveRateKg, 2),
    deficitLimited: limits,
    intakeAvg: Math.round(intakeAvg),
    energyAvailability: round(ea, 1),
    energyAvailabilityStatus: (p.sessionsPerWeek || 0) > 0 ? eaStatus(ea) : null,
    proteinPerKg: protPerKg,
    proteinPerMealG: Math.round(proteinG / mealsPerDay),
    mealsPerDay,
    trainingDay,
    restDay,
    trainingDays: tDays,
    requiresProfessional,
    warnings,
    athleteGuidance: athleteGuidance(p, load),
    note: 'معامل 7700 سعرة/كجم تقريب حسابي للبداية فقط؛ الخطة تُعاد معايرتها حسب متوسط الوزن الفعلي.',
  };
}

function athleteGuidance(p, load) {
  if (p.isAthlete === false) {
    return [
      'وزّع البروتين على 3–4 وجبات في اليوم بدل وجبة كبيرة واحدة.',
      'تمارين المقاومة (حتى 2–3 مرات في الأسبوع) بتساعد تحافظ على العضلات أثناء العجز.',
      'لا تحكم على نجاح الخطة بالوزن وحده؛ راقب محيط الخصر والطاقة والجوع والنوم.',
    ];
  }
  const g = [
    'وزّع البروتين على 4 وجبات تقريبًا (كل 3–5 ساعات) بدلًا من وجبة كبيرة واحدة.',
    'ضع معظم الكربوهيدرات قبل وبعد الحصص التدريبية المهمة.',
    'استمر في تدريب المقاومة للحفاظ على القوة والكتلة العضلية أثناء العجز.',
    'لا تحكم على نجاح الخطة بالوزن وحده؛ راقب الأداء والتعافي والجوع والنوم ومحيط الخصر.',
  ];
  if (load === 'high' || load === 'very_high') g.push('في أيام الحمل المرتفع أو الحصتين، اجعل اليوم قريبًا من الاتزان بدلًا من العجز.');
  if (p.sport === 'swimming' || p.sport === 'fin_swimming') g.push('لحصص السباحة الصباحية المبكرة: وجبة كربوهيدرات خفيفة قبل الحصة (موز أو تمر) ووجبة بروتين وكربوهيدرات بعدها.');
  g.push(...(SPORT_GUIDE[p.sport] || []));
  if ((p.sport === 'swimming' || p.sport === 'fin_swimming') && SWIM_DISCIPLINES[p.swimDiscipline]) g.push(...SWIM_DISCIPLINES[p.swimDiscipline].guide);
  const disc = (SPORT_DISCIPLINES[p.sport] || {})[p.discipline];
  if (disc) g.push(...disc.guide);
  const ph = SEASON_PHASES[p.seasonPhase];
  if (ph) g.push(...PHASE_GUIDE[p.seasonPhase]);
  return g;
}

const SPORT_GUIDE = {
  swimming: ['السباح بيعرق في الماء من غير ما يحس؛ اشرب قبل وبعد الحصة واوزن نفسك قبل وبعد لمعرفة السوائل المفقودة.', 'الكربوهيدرات أعلى في أيام الحصص الطويلة والمزدوجة.'],
  fin_swimming: ['سباحة الزعانف فيها مجهود عالي للرجلين؛ الكربوهيدرات قبل الحصة مهمة للسرعات.', 'السوائل: اشرب قبل وبعد الحصة حتى لو مش حاسس بعطش.'],
  running: ['الجري بيرفع احتياج الحديد (فقد بسيط مع الصدمات والعرق)؛ ركّز على مصادره.', 'تجنب الأكل عالي الألياف قبل الجري بساعتين لتجنب مشاكل المعدة.'],
  cycling: ['في الحصص أكتر من 90 دقيقة: 30–60 جم كربوهيدرات في الساعة (مشروب رياضي أو موز أو تمر).'],
  endurance: ['الحصص الطويلة محتاجة كربوهيدرات أثناء التمرين (30–60 جم/ساعة) ومشروب فيه أملاح.', 'الكربوهيدرات اليومية أعلى من باقي الرياضات.'],
  team_sports: ['التمرين متقطع وسريع؛ وجبة كربوهيدرات قبل التمرين بـ 3 ساعات وسناك قبله بساعة.', 'تعويض السوائل بين الشوطين مهم في الحر.'],
  strength: ['البروتين 2 جم/كجم على الأقل ومتوزع على 4 وجبات؛ 20–40 جم بعد التمرين.', 'الكربوهيدرات أقل من رياضات التحمل لكن متتشالش قبل التمرين.'],
  fencing: ['يوم بطولة السلاح طويل وفيه جولات كتير بفواصل غير ثابتة: جهّز سناكس صغيرة سهلة الهضم (موز، تمر، عيش بالعسل) ومية بين الجولات.', 'الوجبة الأساسية قبل أول جولة بـ 2–4 ساعات، وبلاش أكل تقيل أو جديد يوم البطولة.'],
  modern_pentathlon: ['الخماسي فيه أكتر من مسابقة في نفس اليوم: الأكل بين المسابقات حسب الفاصل (أقل من ساعة سوائل بس، ساعة لساعتين سوائل وسناك صغير، أكتر من كده وجبة خفيفة).', 'مسابقة السباحة والجري محتاجين كربوهيدرات كفاية من اليوم اللي قبله.'],
  triathlon: ['التدريب بيجمع سباحة ودراجة وجري، فالكربوهيدرات اليومية أعلى من أغلب الرياضات.', 'في الحصص والسباقات من ساعة لساعتين ونص: 30–60 جم كربوهيدرات في الساعة، واتدرب على الأكل والشرب على الدراجة قبل السباق.', 'اعمل قياس معدل عرق في السباحة وفي الدراجة/الجري، لأن الاتنين مختلفين.'],
};
// Disciplines of the sports added in 0.7.0 — guidance text only, never numbers (app rule).
const SPORT_DISCIPLINES = {
  fencing: {
    foil: { ar: 'شيش (Foil)', guide: [] },
    epee: { ar: 'سيف مبارزة (Épée)', guide: [] },
    sabre: { ar: 'سلاح سيبر (Sabre)', guide: ['السيبر جولاته قصيرة وانفجارية؛ ركّز على الكربوهيدرات قبل البطولة والتعافي بين الأدوار.'] },
  },
  triathlon: {
    sprint_tri: { ar: 'سبرنت (750م / 20كم / 5كم)', guide: ['السبرنت أقل من ساعة ونص غالبًا؛ وجبة قبله بـ 2–4 ساعات تكفي، ومشروب رياضي أثناء الدراجة اختياري.'] },
    olympic: { ar: 'أولمبي (1.5كم / 40كم / 10كم)', guide: ['الأولمبي ساعتين تقريبًا: 30–60 جم كربوهيدرات في الساعة أثناء الدراجة والجري.'] },
    half: { ar: 'نص آيرونمان (70.3)', guide: ['المسافات الطويلة محتاجة خطة أكل وشرب مكتوبة ومجربة في التدريب، وإشراف أخصائي تغذية رياضية.'] },
    full: { ar: 'آيرونمان كامل', guide: ['الآيرونمان محتاج خطة فردية من أخصائي تغذية رياضية؛ إرشادات التطبيق العامة مش كفاية للمسافة دي.'] },
  },
};
// Swimming sub-disciplines change guidance text only (not the numbers).
// Fuel-during-exercise figures come from broad2019 Table 3.3; the rest from barclay2012 ch.2.
const SWIM_DISCIPLINES = {
  sprint: { ar: 'سرعات (50–100م)', guide: ['السرعات: السباقات قصيرة فالأكل أثناء السباق مش مطلوب؛ المهم وجبة قبلها بـ 2–4 ساعات وسناك قبلها بساعة، والتعافي بين التصفيات.'] },
  middle: { ar: 'مسافات متوسطة (200–400م)', guide: ['المسافات المتوسطة: نفس قواعد يوم السباق، ومع أكتر من سباق في اليوم ركّز على التعافي السريع بين السباقات.'] },
  distance: { ar: 'مسافات طويلة (800–1500م)', guide: ['المسافات الطويلة: حجم التدريب عالي فالكربوهيدرات اليومية أعلى؛ في الحصص اللي أكتر من ساعة استخدم مشروب رياضي.'] },
  open_water: { ar: 'مياه مفتوحة', guide: ['المياه المفتوحة: في السباقات من ساعة لساعتين ونص الإرشاد 30–60 جم كربوهيدرات في الساعة؛ جرّب طريقة الشرب من نقاط الإمداد في التدريب الأول.', 'الحرارة والبرد بيأثروا على احتياج السوائل؛ اعمل قياس معدل تعرق في ظروف شبه السباق.'] },
  mono: { ar: 'زعانف «مونو»', guide: ['زعانف «مونو»: المجهود العضلي عالي في الرجلين والجذع؛ الكربوهيدرات قبل الحصص السريعة مهمة، والبروتين بعد الحصة (20–25 جم).'] },
  bi_fins: { ar: 'زعانف مزدوجة (Bi-fins)', guide: ['الزعانف المزدوجة: نفس قواعد سباحة الزعانف؛ قِس معدل التعرق لأن الحصص بتبقى طويلة.'] },
  apnea: { ar: 'غطس (Apnea)', guide: ['الغطس (Apnea): تجنب وجبة كبيرة أو مشروبات غازية قبل الحصة مباشرة؛ خلي الوجبة قبلها بـ 2–4 ساعات.'] },
};

const PHASE_GUIDE = {
  off_season: ['خارج الموسم أنسب وقت لخسارة الدهون بمعدل أعلى نسبيًا، مع الحفاظ على تمارين القوة.'],
  pre_season: ['فترة الإعداد: خسارة دهون معتدلة، والكربوهيدرات حسب حجم التدريب العالي.'],
  in_season: ['فترة المنافسات: الأولوية للأداء؛ خسارة الوزن بطيئة جدًا أو تتوقف، والكربوهيدرات أعلى.'],
  transition: ['الراحة الانتقالية: التدريب أقل، فالكربوهيدرات أقل؛ مناسب لتصحيح العادات الغذائية.'],
};

module.exports = { annotateMacros, ATWATER, tdeeRange, athleteGuidance, dayMacros, MAX_DEFICIT_FRACTION_MINOR, SPORT_DISCIPLINES, CARB_BASE, MAX_DEFICIT_FRACTION, EA_THRESHOLD, INTENSITY_FACTOR, carbPerKg, SWIM_DISCIPLINES, eaStatus, SPORT_NUTRITION, SEASON_PHASES, SPORT_GUIDE, PHASE_GUIDE, buildPlan, energyNeeds, bmr, fatFreeMass, exerciseEnergy, SPORTS, NON_EXERCISE_PAL, KCAL_PER_KG };
