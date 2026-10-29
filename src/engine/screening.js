'use strict';

// Health screening & referral flags.
// This module does NOT diagnose anything. It turns self-reported answers into
// (a) referral flags with a reason, and (b) one decision: may the app apply a calorie deficit?
// When the answer is no, the app holds the plan at maintenance (energy balance) until a
// qualified professional reviews it.
//
// Basis (see src/data/references.json):
//  - kealy2023: RED-S follows low energy availability; menstrual change is often the first sign → see a professional.
//  - schlenker2015: low energy availability, menstrual irregularity, low bone density; no single weight goal for all.
//  - broad2019: stress fractures / low bone density in athletes; SCI & limb loss → standard RMR equations uncertain;
//    SCI → impaired sweating and thermoregulation.
//  - barclay2012: supplements only on advice of a doctor / sports dietitian; adolescents need energy for growth.
//  - wku_assessment: medical history, medications, supplements, weight history questions.
//  - bernstein2015 / acs_cancer: inherited metabolic disease and cancer treatment need specialised nutrition care.
// The set of questions is an app design choice, not a validated screening instrument.

const MENSTRUAL = ['regular', 'irregular', 'absent', 'hormonal_contraception', 'not_sure'];
const CONDITIONS = ['diabetes', 'heart', 'hypertension', 'kidney', 'gi', 'thyroid', 'metabolic_inherited', 'cancer', 'other'];
const IMPAIRMENTS = ['none', 'sci', 'amputation', 'cp_abi', 'visual', 'other'];
const EATING = ['preoccupied', 'compensate', 'purge', 'loss_of_control'];

const CONDITION_AR = {
  diabetes: 'السكر', heart: 'أمراض القلب', hypertension: 'ضغط الدم', kidney: 'الكلى', gi: 'الجهاز الهضمي',
  thyroid: 'الغدة الدرقية', metabolic_inherited: 'مرض أيضي وراثي', cancer: 'علاج أورام', other: 'حالة مزمنة أخرى',
};

function validateScreening(b = {}) {
  const errors = {};
  const arr = (v, allowed) => (Array.isArray(v) ? [...new Set(v.filter((x) => allowed.includes(x)))] : []);
  const bool = (v) => v === true || v === 'true' || v === 1;
  const value = {
    consent: bool(b.consent),
    menstrual: MENSTRUAL.includes(b.menstrual) ? b.menstrual : null,
    eating: arr(b.eating, EATING),
    boneStressInjury: bool(b.boneStressInjury),
    recurrentIllness: bool(b.recurrentIllness),
    persistentFatigue: bool(b.persistentFatigue),
    performanceDrop: bool(b.performanceDrop),
    unintendedWeightLoss: bool(b.unintendedWeightLoss),
    conditions: arr(b.conditions, CONDITIONS),
    medications: bool(b.medications),
    supplements: bool(b.supplements),
    impairment: IMPAIRMENTS.includes(b.impairment) ? b.impairment : 'none',
    pregnantOrBreastfeeding: bool(b.pregnantOrBreastfeeding),
    professionalClearance: bool(b.professionalClearance),
  };
  if (!value.consent) errors.consent = 'لازم توافق على حفظ إجابات الفحص الصحي علشان نستخدمها في حساب الخطة.';
  return { value, errors };
}

// profile: { age, sex }. screening: validated value or null.
function screen(screening, profile = {}) {
  const flags = [];
  const add = (code, level, text, refs) => flags.push({ code, level, text, refs });
  let hold = false;

  // Minors (12–17): a calorie deficit only with the recorded consent of a linked guardian (0.7.0 owner
  // decision). Even then limits are tighter (energy.js) and professional supervision is recommended.
  if (profile.age != null && profile.age < 18) {
    if (profile.guardianConsent) {
      add('MINOR_GUARDIAN_CONSENT', 'amber', 'اللاعب أقل من 18 سنة وولي الأمر وافق على خطة خسارة وزن. العجز بحدود أقل من الكبار، والنمو له الأولوية؛ يُنصح جدًا بمتابعة أخصائي تغذية رياضية، وولي الأمر يقدر يلغي الموافقة في أي وقت.', ['barclay2012']);
    } else {
      hold = true;
      add('MINOR', 'red', 'اللاعب أقل من 18 سنة: مفيش عجز سعرات من غير موافقة ولي الأمر المربوط بالحساب. الخطة على الثبات لحد ما ولي الأمر يوافق، ويُنصح بإشراف أخصائي تغذية رياضية.', ['barclay2012']);
    }
  }
  // 0.7.0 owner decision: an adult may accept the plan on his own responsibility (selfWaiver).
  // It never applies to minors, purging, or pregnancy/breastfeeding, and all calorie limits still apply.
  const adult = profile.age != null && profile.age >= 18;
  const waiver = adult && !!profile.selfWaiver;
  if (!screening && waiver) {
    return { completed: false, hold, deficitAllowed: !hold, waiver: true, flags: [...flags, { code: 'SELF_WAIVER_NO_SCREENING', level: 'amber', text: 'الفحص الصحي ما اتعملش، والخطة فيها عجز سعرات على مسؤوليتك الشخصية. الحدود الآمنة للعجز وتوافر الطاقة لسه شغالة، والأفضل تكمّل الفحص.', refs: [] }], referral: null };
  }
  if (!screening) {
    return { completed: false, hold: true, deficitAllowed: false, waiverAllowed: adult, flags: [...flags, { code: 'SCREENING_MISSING', level: 'amber', text: 'كمّل الفحص الصحي المبدئي الأول؛ لحد ما يتعمل، الخطة على سعرات الثبات (من غير عجز).', refs: [] }], referral: null };
  }

  const s = screening;
  if (profile.sex === 'female') {
    if (s.menstrual === 'absent' || s.menstrual === 'irregular') {
      hold = true;
      add('MENSTRUAL_CHANGE', 'red', s.menstrual === 'absent'
        ? 'الدورة الشهرية منقطعة: ده ممكن يكون علامة على نقص توافر الطاقة (RED-S) أو سبب طبي تاني. لازم مراجعة طبيب قبل أي عجز سعرات.'
        : 'الدورة الشهرية غير منتظمة: ممكن تكون علامة على نقص توافر الطاقة. محتاج مراجعة طبيب أو أخصائي تغذية رياضية قبل أي عجز.', ['kealy2023', 'schlenker2015']);
    } else if (s.menstrual === 'hormonal_contraception') {
      add('HC', 'info', 'وسائل منع الحمل الهرمونية ممكن تخفي تغيرات الدورة؛ الدورة مش مؤشر كافي هنا لتوافر الطاقة.', ['kealy2023']);
    } else if (s.menstrual == null) {
      // The menstrual question is the earliest warning sign of low energy availability; it cannot be skipped.
      hold = true;
      add('MENSTRUAL_UNANSWERED', 'amber', 'سؤال الدورة الشهرية لازم يتجاوب (حتى لو «مش متأكدة») قبل أي خطة عجز.', ['kealy2023']);
    } else if (s.menstrual === 'not_sure') {
      add('MENSTRUAL_TRACK', 'info', 'سجّلي مواعيد الدورة 3 شهور على الأقل؛ أي تغيير فيها مهم يتعرف للمختص.', ['kealy2023']);
    }
  }

  if (s.eating.length) {
    hold = true;
    const urgent = s.eating.includes('purge');
    add(urgent ? 'EATING_URGENT' : 'EATING_CONCERN', 'red', urgent
      ? 'في إجابات عن تقيؤ أو ملينات أو مدرات للتحكم في الوزن: ده محتاج تكلم طبيب أو مختص نفسي/تغذية في أقرب وقت. التطبيق مش هيعمل أي عجز سعرات.'
      : 'في إجابات بتقول إن الأكل أو الوزن شاغلين بالك أو بتعوض الأكل بتقليل أو تمرين زيادة. ده مش تشخيص، بس الأفضل تتكلم مع مختص قبل أي خطة خسارة وزن.', ['schlenker2015']);
  }

  const redsSigns = [s.boneStressInjury && 'كسر إجهادي/إصابة عظام', s.recurrentIllness && 'عدوى متكررة', s.persistentFatigue && 'إرهاق مستمر', s.performanceDrop && 'هبوط في الأداء'].filter(Boolean);
  if (s.boneStressInjury) {
    hold = true;
    add('BONE_STRESS', 'red', 'إصابة عظام/كسر إجهادي: ممكن تكون مرتبطة بنقص توافر الطاقة أو كثافة العظام. محتاج مراجعة طبيب رياضي قبل أي عجز.', ['broad2019', 'schlenker2015']);
  }
  // Reviewer decision 2026-10-22 (أحمد ربيع حسين): referral to a doctor from 3 signs (was 2).
  if (redsSigns.length >= 3) {
    hold = true;
    add('REDS_SIGNS', 'red', `3 علامات أو أكتر ممكن تكون مرتبطة بنقص توافر الطاقة (${redsSigns.join('، ')}). راجع طبيب؛ التطبيق مش بيشخّص، والخطة هتفضل على الثبات لحد المراجعة.`, ['kealy2023', 'broad2019']);
  } else if (redsSigns.length === 2) {
    add('REDS_TWO', 'amber', `علامتين ممكن يكونوا مرتبطين بنقص توافر الطاقة (${redsSigns.join('، ')}). تابعهم، ولو ظهرت علامة تالتة لازم تراجع طبيب.`, ['kealy2023']);
  } else if (redsSigns.length === 1 && !s.boneStressInjury) {
    add('REDS_ONE', 'amber', `فيه علامة واحدة (${redsSigns[0]}). تابعها، ولو استمرت راجع مختص.`, ['kealy2023']);
  }

  if (s.unintendedWeightLoss) {
    hold = true;
    add('UNINTENDED_LOSS', 'red', 'نزول وزن من غير قصد محتاج تقييم طبي قبل أي خطة عجز.', ['wku_assessment']);
  }
  if (s.conditions.length) {
    hold = true;
    const refs = ['wku_assessment'];
    if (s.conditions.includes('metabolic_inherited')) refs.push('bernstein2015');
    if (s.conditions.includes('cancer')) refs.push('acs_cancer');
    add('CHRONIC', 'red', `حالة صحية مزمنة (${s.conditions.map((c) => CONDITION_AR[c]).join('، ')}): الخطة محتاجة موافقة الطبيب المعالج أو أخصائي تغذية علاجية.`, refs);
  }
  if (s.medications) add('MEDICATIONS', 'amber', 'بعض الأدوية بتأثر على الشهية أو الوزن أو السوائل؛ اعرض الخطة على الطبيب.', ['wku_assessment']);
  if (s.supplements) add('SUPPLEMENTS', 'amber', 'المكملات: استخدمها بس بنصيحة طبيب أو أخصائي تغذية رياضية، واتأكد إنها مختبرة ضد المنشطات.', ['barclay2012']);
  if (s.pregnantOrBreastfeeding) {
    hold = true;
    add('PREGNANCY', 'red', 'الحمل أو الرضاعة: لا عجز سعرات إلا بإشراف طبي.', []);
  }
  if (s.impairment !== 'none') {
    add('IMPAIRMENT', 'amber', 'معادلات حساب الأيض مأخوذة من أشخاص بدون إعاقة؛ دقتها أقل في الإصابات الحركية والبتر. يفضل قياس الأيض (RMR) ومتابعة أخصائي.', ['broad2019']);
    if (s.impairment === 'sci') add('SCI_HEAT', 'amber', 'إصابة النخاع الشوكي بتقلل العرق وتنظيم الحرارة؛ خطة السوائل والتبريد لازم تبقى فردية، وخلي بالك من الشرب الزيادة.', ['broad2019']);
  }

  // A professional can clear the hold — except for minors (always maintenance here) and urgent eating flags.
  const clearable = !flags.some((f) => f.code === 'MINOR' || f.code === 'EATING_URGENT');
  if (hold && s.professionalClearance && clearable) {
    hold = false;
    add('CLEARED', 'info', 'تم تسجيل إن مختص راجع الحالة ووافق على الخطة. التطبيق مش بيتحقق من ده؛ المسؤولية على المختص المتابع.', []);
  }

  const noWaiver = flags.some((f) => ['MINOR', 'EATING_URGENT', 'PREGNANCY'].includes(f.code));
  if (hold && waiver && !noWaiver) {
    hold = false;
    add('SELF_WAIVER', 'amber', 'الخطة فيها عجز سعرات على مسؤوليتك الشخصية رغم العلامات اللي فوق. التطبيق مش بيشخّص، والحدود الآمنة لسه شغالة؛ يُنصح جدًا بمراجعة مختص.', []);
  } else if (hold && waiver && noWaiver) {
    add('SELF_WAIVER_BLOCKED', 'info', 'الموافقة على مسؤوليتك مش بتلغي التوقف في الحالة دي (أقل من 18 سنة، أو تقيؤ/ملينات، أو حمل/رضاعة).', []);
  }

  // Gain goals (app rule, SCIENCE_REVIEW.md R-G6): the hold exists to stop a calorie DEFICIT. A surplus plan is not
  // held for REDS signs, bone stress, unintended loss or age; eating-related answers, chronic disease and
  // pregnancy still hold (maintenance) until a specialist clears them.
  if (hold && profile.gain && !flags.some((f) => ['EATING_URGENT', 'EATING_CONCERN', 'CHRONIC', 'PREGNANCY'].includes(f.code))) {
    hold = false;
    add('GAIN_NO_HOLD', 'info', 'هدفك زيادة وزن (فائض سعرات)، فالخطة مش متوقفة؛ العلامات اللي فوق لسه محتاجة متابعة مع مختص.', []);
  }

  const reds = flags.filter((f) => f.level === 'red');
  return {
    completed: true,
    hold,
    deficitAllowed: !hold,
    waiver: waiver && !hold,
    waiverAllowed: adult && !noWaiver,
    flags,
    referral: reds.length ? 'راجع طبيب رياضي أو أخصائي تغذية رياضية معتمد ومعاك نتيجة الفحص دي.' : null,
  };
}

module.exports = { validateScreening, screen, MENSTRUAL, CONDITIONS, IMPAIRMENTS, EATING, CONDITION_AR };
