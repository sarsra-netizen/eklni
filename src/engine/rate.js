'use strict';
const { round } = require('./calculator');
const { diffDays } = require('./dates');

// Section 3 — Personalized weekly loss rate.
// Starts from a conservative reference (0.5–1 % body weight / week for some adults)
// and only moves DOWN (slower) for leanness, high training load, upcoming competition,
// poor recovery signals, youth/older age, or medical flags. Never above 1 %/week.

const ABS_MIN_PCT = 0.1;   // smallest custom rate accepted (%/week)
const ABS_MAX_PCT = 1.0;   // hard ceiling for any plan in this app (%/week)
const WAIVER_MAX_KG = 0.9; // with the adult self-responsibility acknowledgement (reviewer decision 2026-10-22)
// App rule (SCIENCE_REVIEW.md R-W3): max weekly loss (% body mass) by season phase.
const PHASE_CAP = { off_season: 1.0, pre_season: 0.75, in_season: 0.4, transition: 0.75 };

const BF_RELIABILITY = { dexa: 'high', skinfold: 'medium', bia: 'low', tape: 'low', visual: 'low' };

function bodyFatInfo(p) {
  if (p.bodyFatPct == null) return { usable: false, reliability: 'none' };
  const reliability = BF_RELIABILITY[p.bodyFatMethod] || 'low';
  return { usable: true, reliability, pct: p.bodyFatPct };
}

function leanness(p) {
  const bf = bodyFatInfo(p);
  if (!bf.usable) return 'unknown';
  const male = p.sex === 'male';
  if (bf.pct < (male ? 10 : 17)) return 'very_lean';
  if (bf.pct < (male ? 13 : 21)) return 'lean';
  if (bf.pct > (male ? 25 : 33)) return 'higher';
  return 'moderate';
}

function weeklyTrainingHours(p) {
  return ((p.sessionsPerWeek || 0) * (p.minutesPerSession || 0)) / 60;
}

function trainingLoad(p) {
  const h = weeklyTrainingHours(p);
  if (h >= 12 || (h >= 8 && p.intensity === 'high') || (p.sessionsPerWeek || 0) >= 10) return 'very_high';
  if (h >= 7 || (h >= 5 && p.intensity === 'high')) return 'high';
  if (h >= 3) return 'moderate';
  return 'low';
}

function recommendRate(p, today) {
  const gain = require('./gain');
  if (gain.isGainGoal(p.primaryGoal)) return gain.recommendGainRate(p, today);
  const reasons = [];
  const flags = [];
  let pct = 0.75;           // midpoint of the reference range
  let capPct = ABS_MAX_PCT; // highest rate this person may choose
  let requiresProfessional = false;

  const cap = (c, why) => { if (c < capPct) capPct = c; reasons.push(why); };

  // Leanness: the leaner the athlete, the slower the rate (more lean-mass risk).
  const lean = leanness(p);
  const bf = bodyFatInfo(p);
  if (lean === 'very_lean') {
    cap(0.35, 'نسبة الدهون منخفضة جدًا؛ خسارة الوزن قد تأتي من الكتلة العضلية، لذا المعدل بطيء جدًا.');
    pct = 0.3; requiresProfessional = true;
    flags.push('VERY_LEAN');
  } else if (lean === 'lean') {
    cap(0.5, 'نسبة الدهون منخفضة نسبيًا؛ يُفضل معدل أبطأ للحفاظ على العضلات والأداء.');
    pct = Math.min(pct, 0.45);
  } else if (lean === 'higher') {
    reasons.push('نسبة الدهون أعلى، ويمكن عادةً تحمّل معدل ضمن النطاق المرجعي كاملًا.');
    pct = 0.8;
  } else if (lean === 'unknown') {
    reasons.push('نسبة الدهون غير متوفرة؛ استُخدم معدل متوسط محافظ دون افتراض نسبة دهون.');
  }
  if (bf.usable && bf.reliability === 'low') {
    reasons.push('طريقة قياس الدهون منخفضة الموثوقية؛ اعتُبرت القيمة مؤشرًا تقريبيًا فقط.');
    if (lean === 'lean' || lean === 'very_lean') pct = Math.min(pct, 0.45);
  }

  // Training load: higher volume/intensity → slower.
  const load = trainingLoad(p);
  if (load === 'very_high') { cap(0.6, 'الحمل التدريبي مرتفع جدًا؛ العجز الكبير يضر التعافي والأداء.'); pct -= 0.2; }
  else if (load === 'high') { cap(0.8, 'الحمل التدريبي مرتفع؛ يُفضل معدل أبطأ.'); pct -= 0.1; }

  // Competition proximity.
  if (p.competitionDate && today) {
    const d = diffDays(today, p.competitionDate);
    if (d >= 0 && d <= 28) {
      cap(0.35, 'المنافسة خلال 4 أسابيع؛ الأولوية للأداء لا لخسارة الوزن.');
      pct = Math.min(pct, 0.25);
      flags.push('COMPETITION_SOON');
    } else if (d > 28 && d <= 56) {
      cap(0.5, 'المنافسة خلال 8 أسابيع؛ معدل محافظ لتجنب تراجع الأداء.');
      pct = Math.min(pct, 0.45);
    }
  }

  // Recovery and wellbeing signals (1–5 scales).
  if (p.hunger >= 4) { pct -= 0.1; reasons.push('مستوى الجوع مرتفع؛ خُفّض المعدل لتحسين الاستمرارية.'); }
  if (p.energy != null && p.energy <= 2) { pct -= 0.1; reasons.push('مستوى الطاقة منخفض؛ خُفّض المعدل.'); }
  if (p.sleep != null && p.sleep <= 2) { pct -= 0.1; reasons.push('جودة النوم ضعيفة؛ العجز الكبير مع قلة النوم يزيد فقد العضلات.'); }
  if (p.adherence != null && p.adherence <= 2) { pct -= 0.1; reasons.push('القدرة على الالتزام محدودة؛ معدل أبطأ أسهل في الاستمرار.'); }

  // Weight history: recent rapid loss.
  if (p.recentWeeklyChangeKg != null && p.weightKg && (p.recentWeeklyChangeKg / p.weightKg) * 100 > 1) {
    pct -= 0.1; reasons.push('الوزن كان ينخفض بسرعة مؤخرًا؛ يُفضل إبطاء المعدل.');
  }

  // Age.
  if (p.age != null && p.age < 18) {
    cap(0.5, 'المستخدم أقل من 18 عامًا؛ خسارة الوزن تحتاج إشرافًا متخصصًا لأن النمو أولوية.');
    requiresProfessional = true; flags.push('MINOR');
  } else if (p.age != null && p.age >= 65) {
    cap(0.5, 'العمر 65 أو أكثر؛ معدل أبطأ لحماية الكتلة العضلية والعظام.');
  }

  // Season phase: in-season the priority is performance, so loss is slower.
  const PHASE_AR = { off_season: 'خارج الموسم', pre_season: 'فترة الإعداد', in_season: 'فترة المنافسات', transition: 'الراحة الانتقالية' };
  if (p.seasonPhase && PHASE_CAP[p.seasonPhase] < ABS_MAX_PCT) {
    cap(PHASE_CAP[p.seasonPhase], `${PHASE_AR[p.seasonPhase]}: أقصى معدل ${PHASE_CAP[p.seasonPhase]}% من الوزن أسبوعيًا عشان الأداء والتعافي.`);
    if (p.seasonPhase === 'in_season') pct = Math.min(pct, 0.35);
  }

  // Medical flags.
  if (p.medicalCondition || p.weightMedication) {
    requiresProfessional = true; flags.push('MEDICAL');
    reasons.push('توجد حالة طبية أو أدوية قد تؤثر في الوزن؛ يجب مراجعة الطبيب قبل تطبيق الخطة.');
  }
  if (p.pregnantOrBreastfeeding) {
    requiresProfessional = true; flags.push('PREGNANCY');
    cap(0.25, 'الحمل أو الرضاعة: لا تُستخدم خطة عجز سعرات إلا بإشراف طبي.');
  }

  // Reviewer decision 2026-10-22: with the adult self-responsibility acknowledgement the weekly loss may go up to
  // 0.9 kg (never for minors or pregnancy/breastfeeding). The deficit limit and EA ≥30 still apply in energy.js.
  if (p.selfWaiver && !(p.age < 18) && !p.pregnantOrBreastfeeding && p.weightKg) {
    const waiverPct = (WAIVER_MAX_KG / p.weightKg) * 100;
    if (waiverPct > capPct) { capPct = waiverPct; reasons.push(`بإقرار تحمل المسؤولية: تقدر تختار نزول لحد ${WAIVER_MAX_KG} كجم في الأسبوع؛ حدود العجز وتوافر الطاقة لسه شغالة.`); flags.push('SELF_WAIVER_RATE'); }
  }
  pct = Math.max(0.25, Math.min(pct, capPct));
  if (pct > capPct) pct = capPct;
  const minPct = Math.min(ABS_MIN_PCT, capPct);

  return {
    direction: 'loss',
    recommendedPct: round(pct, 2),
    recommendedKg: round((pct / 100) * p.weightKg, 2),
    allowedRangePct: [minPct, round(capPct, 2)],
    allowedRangeKg: [round((minPct / 100) * p.weightKg, 2), round((capPct / 100) * p.weightKg, 2)],
    trainingLoad: load,
    leanness: lean,
    requiresProfessional,
    flags,
    reasons,
    note: 'النطاق 0.5–1% من الوزن أسبوعيًا مرجع عام لبعض البالغين، وليس قاعدة للجميع.',
  };
}

// Validate a custom rate chosen by the user against the personalized range.
function checkCustomRate(rateKg, rec, weightKg) {
  const pct = (rateKg / weightKg) * 100;
  const [lo, hi] = rec.allowedRangePct;
  if (!(rateKg > 0)) return { ok: false, code: 'INVALID_RATE', message: 'المعدل يجب أن يكون رقمًا موجبًا.' };
  if (pct > hi + 1e-9) {
    return { ok: false, code: 'RATE_ABOVE_SAFE', message: `المعدل المطلوب (${round(pct, 2)}% من الوزن أسبوعيًا) أعلى من الحد الآمن لحالتك (${hi}%).` };
  }
  if (pct < lo - 1e-9) {
    return { ok: false, code: 'RATE_TOO_LOW', message: `المعدل أقل من ${lo}% أسبوعيًا؛ التغير سيكون أصغر من تذبذب الوزن اليومي ويصعب قياسه.` };
  }
  const warn = pct > rec.recommendedPct + 0.15
    ? 'المعدل أعلى من الموصى به لحالتك؛ راقب الأداء والجوع والنوم عن قرب.'
    : null;
  return { ok: true, pct: round(pct, 2), warning: warn };
}

module.exports = { WAIVER_MAX_KG, PHASE_CAP, recommendRate, checkCustomRate, bodyFatInfo, trainingLoad, weeklyTrainingHours, leanness, ABS_MAX_PCT };
