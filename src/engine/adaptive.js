'use strict';
const { trendSlope } = require('./progress');
const { round } = require('./calculator');
const { diffDays } = require('./dates');
const { KCAL_PER_KG } = require('./energy');

// Section 7 — adaptive adjustment engine.
// Produces a PROPOSAL only; nothing changes until the user accepts it.

const CHECKLIST = [
  'هل سجلت كل ما أكلته وشربته (بما في ذلك الزيت والصلصات والمشروبات)؟',
  'هل تُوزن الأطعمة أم تُقدّر بالعين؟ وهل الوزن نيئ أم مطهو كما في الخطة؟',
  'هل تغير نشاطك اليومي (خطوات، عمل) أو حجم التدريب؟',
  'هل هناك سبب لاحتباس السوائل (ملح مرتفع، تدريب جديد، دورة شهرية، قلة النوم، ضغط)؟',
  'هل تزن نفسك في ظروف متشابهة (صباحًا، بعد الحمام، قبل الأكل)؟',
];

function poorWellbeing(c) {
  if (!c) return [];
  const s = [];
  if (c.hunger != null && c.hunger >= 4) s.push('جوع مرتفع');
  if (c.energy != null && c.energy <= 2) s.push('طاقة منخفضة');
  if (c.performance != null && c.performance <= 2) s.push('تراجع الأداء');
  if (c.sleep != null && c.sleep <= 2) s.push('نوم ضعيف');
  if (c.recovery != null && c.recovery <= 2) s.push('تعافٍ ضعيف');
  return s;
}

function evaluate({ rows, targetRateKg, today, adjustments = [], direction = 'loss' }) {
  if (direction === 'gain') return evaluateGain({ rows, targetRateKg, today, adjustments });
  const withWeight = rows.filter((r) => r.avgWeight != null);
  const latest = rows[rows.length - 1] || null;
  const symptoms = poorWellbeing(latest);
  const trend = trendSlope(rows);
  const base = { trend, targetRateKg, symptoms, checklist: [], kcalChange: 0 };

  if (!trend) {
    return { ...base, action: 'insufficient_data', reasons: ['نحتاج متوسطين أسبوعيين على الأقل قبل تقييم الاتجاه. لا يتم تغيير السعرات بناءً على يوم أو أسبوع واحد.'] };
  }
  const observedLoss = -trend.slopeKgPerWeek;
  const ratio = observedLoss / targetRateKg;
  base.observedLossKg = round(observedLoss, 2);
  base.ratio = round(ratio, 2);

  const lastDecrease = [...adjustments].reverse().find((a) => a.status === 'accepted' && a.kcalChange < 0);
  const recentDecrease = lastDecrease && today && diffDays(lastDecrease.decidedAt.slice(0, 10), today) < 14;

  // Faster than planned
  if (ratio > 1.3) {
    if (symptoms.length) {
      const kcal = ratio > 1.6 ? 250 : 150;
      return { ...base, action: 'increase_energy', kcalChange: kcal,
        reasons: [`الخسارة أسرع من المخطط (${base.observedLossKg} مقابل ${targetRateKg} كجم/أسبوع) مع ${symptoms.join('، ')}.`,
          `نقترح زيادة الطاقة نحو ${kcal} سعرة يوميًا، ويُفضل أن تكون كربوهيدرات حول التدريب.`] };
    }
    if (trend.weeksUsed >= 3 && ratio > 1.5) {
      return { ...base, action: 'increase_energy', kcalChange: 150,
        reasons: ['الخسارة أسرع بوضوح من المخطط لعدة أسابيع؛ زيادة بسيطة تقلل خطر فقد العضلات حتى مع عدم وجود أعراض.'] };
    }
    return { ...base, action: 'monitor', reasons: ['الخسارة أسرع من المخطط، لكن الأداء والتعافي جيدان والبيانات قليلة؛ قد يكون جزء منها ماء وجليكوجين. تابع أسبوعًا آخر.'] };
  }

  // On track
  if (ratio >= 0.7) {
    if (symptoms.includes('تراجع الأداء') || symptoms.includes('تعافٍ ضعيف')) {
      return { ...base, action: 'increase_energy', kcalChange: 100,
        reasons: ['الوزن ينخفض بالمعدل المخطط، لكن هناك تراجع في الأداء أو التعافي.', 'نقترح إضافة نحو 100 سعرة كربوهيدرات في أيام التدريب ومراجعة النوم.'] };
    }
    return { ...base, action: 'continue', reasons: ['الوزن ينخفض بالمعدل المخطط مع أداء وتعافٍ مقبولين؛ استمر بالخطة الحالية.'] };
  }

  // Slower than planned (or gaining)
  if (trend.weeksUsed < 3) {
    return { ...base, action: 'monitor', reasons: ['الخسارة أبطأ من المخطط، لكن لا توجد بيانات كافية لعدة أسابيع؛ تابع قبل أي تعديل.'] };
  }
  if (symptoms.length) {
    return { ...base, action: 'check_first', checklist: CHECKLIST,
      reasons: [`الخسارة أبطأ من المخطط، لكن توجد مؤشرات (${symptoms.join('، ')}). تقليل الطعام الآن قد يضر الأداء.`,
        'راجع النوم والتعافي والالتزام أولًا. يمكنك أيضًا قبول معدل أبطأ بدل تقليل الأكل.'] };
  }
  const adherence = latest?.adherencePct;
  if (adherence == null || adherence < 85 || !latest.checklistConfirmed) {
    return { ...base, action: 'check_first', checklist: CHECKLIST,
      reasons: ['الخسارة أبطأ من المخطط لعدة أسابيع.', 'قبل تعديل السعرات: راجع الالتزام ودقة التسجيل والنشاط واحتباس السوائل، وأكّد ذلك في المتابعة الأسبوعية.'] };
  }
  if (recentDecrease) {
    return { ...base, action: 'monitor', reasons: ['تم تقليل السعرات منذ أقل من أسبوعين؛ ننتظر أثر التعديل السابق قبل أي تعديل جديد.'] };
  }
  const gap = Math.max(0, targetRateKg - Math.max(observedLoss, 0));
  const kcal = -Math.min(150, Math.max(100, Math.round(((gap * KCAL_PER_KG) / 7) / 2 / 50) * 50));
  return { ...base, action: 'decrease_energy', kcalChange: kcal,
    reasons: ['الالتزام مرتفع والمراجعة مكتملة والخسارة ما زالت أبطأ من المخطط لعدة أسابيع.',
      `نقترح تقليلًا بسيطًا (${Math.abs(kcal)} سعرة/يوم) من أيام الراحة أولًا. يمكنك رفض الاقتراح واختيار معدل أبطأ بدلًا منه.`] };
}

// Gain goals: same safeguards, mirrored (app rule, SCIENCE_REVIEW.md R-G4). Proposal only.
function evaluateGain({ rows, targetRateKg, today, adjustments = [] }) {
  const latest = rows[rows.length - 1] || null;
  const symptoms = poorWellbeing(latest).filter((x) => x !== 'جوع مرتفع');
  const trend = trendSlope(rows);
  const base = { direction: 'gain', trend, targetRateKg, symptoms, checklist: [], kcalChange: 0 };
  if (!trend) return { ...base, action: 'insufficient_data', reasons: ['نحتاج متوسطين أسبوعيين على الأقل قبل تقييم الاتجاه. لا يتم تغيير السعرات بناءً على يوم أو أسبوع واحد.'] };
  const observedGain = trend.slopeKgPerWeek;
  const ratio = observedGain / targetRateKg;
  base.observedGainKg = round(observedGain, 2);
  base.ratio = round(ratio, 2);
  const lastIncrease = [...adjustments].reverse().find((a) => a.status === 'accepted' && a.kcalChange > 0);
  const recentIncrease = lastIncrease && today && diffDays(lastIncrease.decidedAt.slice(0, 10), today) < 14;

  if (ratio > 1.5) {
    if (trend.weeksUsed < 3) return { ...base, action: 'monitor', reasons: ['الزيادة أسرع من المخطط، بس البيانات لسه قليلة وجزء منها ممكن يكون ماء وجليكوجين. تابع أسبوع كمان.'] };
    return { ...base, action: 'decrease_energy', kcalChange: -150,
      reasons: [`الزيادة أسرع من المخطط لعدة أسابيع (${base.observedGainKg} مقابل ${targetRateKg} كجم/أسبوع)؛ الزيادة الأسرع غالبًا بيبقى أغلبها دهون.`, 'نقترح تقليل 150 سعرة/يوم. تقدر ترفض الاقتراح.'] };
  }
  if (ratio >= 0.7) {
    return { ...base, action: 'continue', reasons: [symptoms.length ? `الوزن بيزيد بالمعدل المخطط، بس فيه ${symptoms.join('، ')}؛ راجع النوم والتعافي.` : 'الوزن بيزيد بالمعدل المخطط؛ استمر بالخطة الحالية.'] };
  }
  if (trend.weeksUsed < 3) return { ...base, action: 'monitor', reasons: ['الزيادة أبطأ من المخطط، لكن البيانات أقل من 3 أسابيع؛ تابع قبل أي تعديل.'] };
  const adherence = latest?.adherencePct;
  if (adherence == null || adherence < 85 || !latest.checklistConfirmed) {
    return { ...base, action: 'check_first', checklist: CHECKLIST,
      reasons: ['الزيادة أبطأ من المخطط لعدة أسابيع.', 'قبل زيادة السعرات: راجع إنك بتاكل كل الوجبات فعلًا ودقة التسجيل والنشاط، وأكّد ده في المتابعة الأسبوعية.'] };
  }
  if (recentIncrease) return { ...base, action: 'monitor', reasons: ['السعرات زادت من أقل من أسبوعين؛ ننتظر أثر التعديل السابق.'] };
  const gap = Math.max(0, targetRateKg - Math.max(observedGain, 0));
  const kcal = Math.min(200, Math.max(100, Math.round(((gap * KCAL_PER_KG) / 7) / 2 / 50) * 50));
  return { ...base, action: 'increase_energy', kcalChange: kcal,
    reasons: ['الالتزام عالي والمراجعة مكتملة والزيادة لسه أبطأ من المخطط لعدة أسابيع.', `نقترح زيادة ${kcal} سعرة/يوم (يُفضل كربوهيدرات وبروتين حوالين التمرين).`] };
}

module.exports = { evaluate, evaluateGain, CHECKLIST };
