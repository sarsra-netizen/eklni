'use strict';
const { parseDate, diffDays } = require('./dates');
const { round } = require('./calculator');

// Input validation shared by API and tests. Returns { value, errors, warnings }.

function num(v) {
  if (v === '' || v == null) return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function makeValidator(body) {
  const value = {}; const errors = {};
  const api = {
    number(field, { min, max, required = false, int = false, label }) {
      const n = num(body[field]);
      if (n === undefined) { if (required) errors[field] = `${label} مطلوب.`; else value[field] = null; return; }
      if (Number.isNaN(n)) { errors[field] = `${label} يجب أن يكون رقمًا.`; return; }
      if (int && !Number.isInteger(n)) { errors[field] = `${label} يجب أن يكون عددًا صحيحًا.`; return; }
      if (n < min || n > max) { errors[field] = `${label} يجب أن يكون بين ${min} و${max}.`; return; }
      value[field] = n;
    },
    oneOf(field, options, { required = false, label, fallback = null }) {
      const v = body[field];
      if (v == null || v === '') { if (required) errors[field] = `${label} مطلوب.`; else value[field] = fallback; return; }
      if (!options.includes(v)) { errors[field] = `قيمة ${label} غير صحيحة.`; return; }
      value[field] = v;
    },
    date(field, { required = false, label }) {
      const v = body[field];
      if (v == null || v === '') { if (required) errors[field] = `${label} مطلوب.`; else value[field] = null; return; }
      if (!parseDate(v)) { errors[field] = `${label} غير صحيح (الصيغة YYYY-MM-DD).`; return; }
      value[field] = v;
    },
    bool(field) { value[field] = body[field] === true || body[field] === 'true' || body[field] === 'on' || body[field] === 1; },
    text(field, max) { const v = body[field]; value[field] = v == null || v === '' ? null : String(v).slice(0, max); },
  };
  return { api, value, errors };
}

const SPORT_KEYS = ['swimming', 'fin_swimming', 'strength', 'running', 'cycling', 'endurance', 'team_sports', 'general', 'fencing', 'modern_pentathlon', 'triathlon'];
const DISCIPLINES = { fencing: ['foil', 'epee', 'sabre'], triathlon: ['sprint_tri', 'olympic', 'half', 'full'] };
const LOSS_GOALS = ['fat_loss', 'preserve_muscle', 'performance'];
const GAIN_GOAL_KEYS = ['muscle_gain', 'weight_gain', 'fat_gain'];
const BF_METHODS = ['dexa', 'skinfold', 'bia', 'tape', 'visual'];

function validateGoalInput(body, { today = null } = {}) {
  const { api: v, value, errors } = makeValidator(body || {});
  const warnings = [];
  v.oneOf('sex', ['male', 'female'], { required: true, label: 'الجنس' });
  v.number('age', { min: 12, max: 90, required: true, int: true, label: 'العمر' });
  v.number('heightCm', { min: 120, max: 230, required: true, label: 'الطول' });
  v.number('currentWeight', { min: 30, max: 250, required: true, label: 'الوزن الحالي' });
  v.number('targetWeight', { min: 30, max: 250, required: true, label: 'الوزن المستهدف' });
  v.number('bodyFatPct', { min: 3, max: 60, label: 'نسبة الدهون الحالية' });
  v.oneOf('bodyFatMethod', BF_METHODS, { label: 'طريقة قياس الدهون' });
  v.number('targetBodyFatPct', { min: 3, max: 60, label: 'نسبة الدهون المستهدفة' });
  v.number('waistCm', { min: 40, max: 200, label: 'محيط الخصر الحالي' });
  v.number('targetWaistCm', { min: 40, max: 200, label: 'محيط الخصر المستهدف' });
  v.number('weeklyRateKg', { min: 0.01, max: 3, label: 'المعدل الأسبوعي' });
  v.date('startDate', { required: true, label: 'تاريخ البداية' });
  v.date('targetDate', { label: 'التاريخ المستهدف' });
  v.oneOf('primaryGoal', [...LOSS_GOALS, ...GAIN_GOAL_KEYS], { label: 'الهدف الأساسي', fallback: 'fat_loss' });
  v.oneOf('activityLevel', ['sedentary', 'light', 'active', 'very_active'], { label: 'مستوى النشاط اليومي', fallback: 'light' });
  v.oneOf('sport', SPORT_KEYS, { label: 'نوع الرياضة', fallback: 'general' });
  v.number('sessionsPerWeek', { min: 0, max: 14, int: true, label: 'عدد الحصص أسبوعيًا' });
  v.number('minutesPerSession', { min: 0, max: 300, label: 'مدة الحصة' });
  v.oneOf('intensity', ['low', 'moderate', 'high'], { label: 'شدة التدريب', fallback: 'moderate' });
  v.date('competitionDate', { label: 'موعد المنافسة' });
  v.number('recentWeeklyChangeKg', { min: -5, max: 5, label: 'معدل تغير الوزن السابق' });
  for (const f of ['hunger', 'energy', 'sleep', 'adherence']) v.number(f, { min: 1, max: 5, int: true, label: f });
  v.bool('medicalCondition'); v.bool('weightMedication'); v.bool('pregnantOrBreastfeeding');
  v.number('mealsPerDay', { min: 2, max: 6, int: true, label: 'عدد الوجبات' });
  v.number('measuredRmr', { min: 800, max: 5000, label: 'معدل الأيض المقاس' });
  v.oneOf('discipline', [...new Set(Object.values(DISCIPLINES).flat())], { label: 'التخصص' });
  v.oneOf('swimDiscipline', ['sprint', 'middle', 'distance', 'open_water', 'mono', 'bi_fins', 'apnea'], { label: 'تخصص السباحة' });
  v.oneOf('seasonPhase', ['off_season', 'pre_season', 'in_season', 'transition'], { label: 'مرحلة الموسم', fallback: 'pre_season' });
  // 0.7.0: athlete or not (missing = athlete, for goals made before this field existed); the person's name for reports.
  value.isAthlete = !(body.isAthlete === false || body.isAthlete === 'false' || body.isAthlete === 0);
  value.fullName = body.fullName == null ? null : String(body.fullName).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60) || null;
  if (!value.isAthlete) {
    // not an athlete: general activity only — no sport, discipline, season phase or competition
    Object.assign(value, { sport: 'general', discipline: null, swimDiscipline: null, seasonPhase: null, competitionDate: null });
    delete errors.discipline; delete errors.swimDiscipline; delete errors.seasonPhase; delete errors.competitionDate; delete errors.sport;
  }

  if (!errors.discipline && value.discipline && !(DISCIPLINES[value.sport] || []).includes(value.discipline)) errors.discipline = 'التخصص ده مش تبع الرياضة المختارة.';
  if (Object.keys(errors).length) return { value, errors, warnings };

  value.sessionsPerWeek ??= 0; value.minutesPerSession ??= 0;
  if (value.bodyFatPct != null && !value.bodyFatMethod) value.bodyFatMethod = 'visual';
  const gain = GAIN_GOAL_KEYS.includes(value.primaryGoal);
  value.direction = gain ? 'gain' : 'loss';
  if (gain && value.targetWeight <= value.currentWeight) {
    errors.targetWeight = 'الوزن المستهدف يجب أن يكون أعلى من الوزن الحالي في خطة زيادة الوزن.';
  } else if (!gain && value.targetWeight >= value.currentWeight) {
    errors.targetWeight = 'الوزن المستهدف يجب أن يكون أقل من الوزن الحالي في خطة خسارة الوزن.';
  }
  // Start date window (app rule): up to 1 year back (late logging of a plan already running), 60 days ahead.
  if (today && value.startDate) {
    const d = diffDays(today, value.startDate);
    if (d < -365) errors.startDate = 'تاريخ البداية أقدم من سنة؛ ابدأ خطة جديدة من تاريخ قريب.';
    else if (d > 60) errors.startDate = 'تاريخ البداية بعد أكتر من 60 يوم؛ اختار تاريخ أقرب.';
  }
  // Measured RMR sanity check against Mifflin-St Jeor (app rule): it must be a plausible value for this body.
  if (value.measuredRmr != null && value.heightCm && value.currentWeight && value.age) {
    const est = 10 * value.currentWeight + 6.25 * value.heightCm - 5 * value.age + (value.sex === 'male' ? 5 : -161);
    const ratio = value.measuredRmr / est;
    value.measuredRmrRatio = round(ratio, 2);
    if (ratio < 0.6 || ratio > 1.6) errors.measuredRmr = `القيمة المقاسة (${value.measuredRmr}) بعيدة جدًا عن المتوقع لحجم جسمك (حوالي ${Math.round(est)}). راجع القياس أو سيبه فاضي.`;
    else if (ratio < 0.8 || ratio > 1.25) { warnings.push(`معدل الأيض المقاس يختلف ${Math.round(Math.abs(ratio - 1) * 100)}% عن المعادلة؛ اتأكد إن القياس اتعمل بالبروتوكول الصحيح (صايم ومرتاح).`); value.requiresProfessional = true; }
  }
  if (value.targetDate && value.startDate && value.targetDate <= value.startDate) {
    errors.targetDate = 'التاريخ المستهدف يجب أن يكون بعد تاريخ البداية.';
  }

  if (gain) return gainTargetChecks(value, errors, warnings);

  // Safety of the target itself — not BMI alone for athletes.
  const male = value.sex === 'male';
  const essentialMin = male ? 6 : 14;   // % — floor we refuse to plan below
  const responsibleMin = male ? 8 : 16; // % — lowest target BF the app will set
  const h = value.heightCm / 100;
  const targetBmi = value.targetWeight / (h * h);
  if (value.bodyFatPct != null) {
    const ffm = value.currentWeight * (1 - value.bodyFatPct / 100);
    const impliedBf = (1 - ffm / value.targetWeight) * 100; // if ALL lost weight were fat
    value.impliedTargetBodyFatPct = round(impliedBf, 1);
    if (impliedBf < essentialMin) {
      errors.targetWeight = `الوزن المستهدف يتطلب نسبة دهون أقل من ${essentialMin}% حتى لو كانت كل الخسارة دهونًا؛ هذا الهدف غير آمن. اختر وزنًا أعلى.`;
    } else if (impliedBf < responsibleMin) {
      warnings.push('الوصول لهذا الوزن يعني نسبة دهون منخفضة جدًا؛ يجب أن يكون بإشراف أخصائي تغذية رياضية.');
      value.requiresProfessional = true;
    }
  } else if (targetBmi < 17.5) {
    errors.targetWeight = `الوزن المستهدف يعطي مؤشر كتلة ${round(targetBmi, 1)}؛ هذا منخفض بدرجة غير آمنة. اختر وزنًا أعلى أو قِس نسبة الدهون أولًا.`;
  } else if (targetBmi < 18.5) {
    warnings.push(`مؤشر الكتلة للوزن المستهدف ${round(targetBmi, 1)} منخفض. بدون قياس نسبة الدهون لا يمكن الحكم على مناسبته؛ يُنصح بمراجعة متخصص.`);
    value.requiresProfessional = true;
  }
  if (value.targetBodyFatPct != null) {
    if (value.bodyFatPct == null) { errors.targetBodyFatPct = 'لا يمكن تحديد نسبة دهون مستهدفة دون معرفة النسبة الحالية.'; }
    else if (value.targetBodyFatPct >= value.bodyFatPct) { errors.targetBodyFatPct = 'نسبة الدهون المستهدفة يجب أن تكون أقل من الحالية.'; }
    else if (value.targetBodyFatPct < responsibleMin) { errors.targetBodyFatPct = `لا يحدد التطبيق نسبة دهون مستهدفة أقل من ${responsibleMin}% لهذا الجنس.`; }
  }
  if ((value.currentWeight - value.targetWeight) / value.currentWeight > 0.2) {
    warnings.push('الهدف يتجاوز 20% من الوزن الحالي؛ يُفضل تقسيمه إلى مراحل مع فترات ثبات (Maintenance) بينها.');
  }
  return { value, errors, warnings };
}

// Gain goals (app rules, SCIENCE_REVIEW.md R-G5): target BMI ≥30 needs a specialist; a target-fat % above the
// current one only for goals that add fat; a gain above 15% of body weight is better split into stages.
function gainTargetChecks(value, errors, warnings) {
  const h = value.heightCm / 100;
  const targetBmi = value.targetWeight / (h * h);
  value.targetBmi = round(targetBmi, 1);
  if (targetBmi >= 30) {
    warnings.push(`مؤشر الكتلة للوزن المستهدف ${round(targetBmi, 1)}؛ الهدف ده لازم يكون بمتابعة طبيب وأخصائي تغذية.`);
    value.requiresProfessional = true;
  }
  if (value.targetBodyFatPct != null) {
    if (value.bodyFatPct == null) errors.targetBodyFatPct = 'لا يمكن تحديد نسبة دهون مستهدفة دون معرفة النسبة الحالية.';
    else if (value.primaryGoal === 'muscle_gain' && value.targetBodyFatPct > value.bodyFatPct) errors.targetBodyFatPct = 'في زيادة الكتلة العضلية نسبة الدهون المستهدفة ما تبقاش أعلى من الحالية؛ اختار «زيادة الدهون والكتلة العضلية».';
  }
  if ((value.targetWeight - value.currentWeight) / value.currentWeight > 0.15) {
    warnings.push('الزيادة المطلوبة أكتر من 15% من وزنك؛ الأفضل تقسيمها لمراحل مع فترات ثبات بينها.');
  }
  return { value, errors, warnings };
}

function validateWeightEntry(body) {
  const { api: v, value, errors } = makeValidator(body || {});
  v.date('date', { required: true, label: 'التاريخ' });
  v.number('weightKg', { min: 30, max: 250, required: true, label: 'الوزن' });
  return { value, errors };
}

function validateCheckin(body) {
  const { api: v, value, errors } = makeValidator(body || {});
  v.number('week', { min: 0, max: 520, int: true, required: true, label: 'رقم الأسبوع' });
  v.number('avgWeight', { min: 30, max: 250, label: 'متوسط الوزن' });
  v.number('waistCm', { min: 40, max: 200, label: 'محيط الخصر' });
  v.number('bodyFatPct', { min: 3, max: 60, label: 'نسبة الدهون' });
  v.oneOf('bodyFatMethod', BF_METHODS, { label: 'طريقة القياس' });
  v.number('caloriesAvg', { min: 500, max: 8000, label: 'متوسط السعرات' });
  v.number('adherencePct', { min: 0, max: 100, label: 'نسبة الالتزام' });
  for (const f of ['performance', 'hunger', 'energy', 'sleep', 'recovery']) v.number(f, { min: 1, max: 5, int: true, label: f });
  v.bool('checklistConfirmed');
  v.text('notes', 500);
  return { value, errors };
}

module.exports = { LOSS_GOALS, GAIN_GOAL_KEYS, DISCIPLINES, validateGoalInput, validateWeightEntry, validateCheckin, SPORT_KEYS, BF_METHODS };
