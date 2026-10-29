'use strict';
const { round } = require('./calculator');
const { parseDate } = require('./dates');

// Hydration & sweat-rate module.
// Sources (see src/data/references.json):
//  - broad2019 ch.3: keep the fluid deficit below 2 % of body mass; rehydrate ≈125–150 % of the deficit
//    with sodium-containing fluids/food; over-drinking with low sweat rates risks hyponatraemia.
//  - broad2019 ch.5, Fig 5.1: weight loss + dark urine + thirst — two indicators "likely", three "very likely".
//  - barclay2012 ch.2: swimmers don't notice sweating; sports drink 4–8 g CHO/100 mL, 500–700 mg/L sodium.
// The sweat-rate formula is the standard mass-balance:  (pre − post + fluid in − urine out) / hours,
// assuming 1 kg body mass ≈ 1 L sweat (approximation; ignores respiratory/substrate mass losses).

const LIMITS = { minMin: 10, maxMin: 360, maxDeltaKg: 5, maxRateLph: 4 };

function validateSession(b = {}, { today = null } = {}) {
  const errors = {};
  const n = (k) => (b[k] === '' || b[k] == null ? null : Number(b[k]));
  const v = {
    date: typeof b.date === 'string' && parseDate(b.date) ? b.date : null,
    preKg: n('preKg'), postKg: n('postKg'), fluidL: n('fluidL') ?? 0, urineL: n('urineL') ?? 0,
    durationMin: n('durationMin'), environment: ['pool_indoor', 'pool_outdoor', 'open_water', 'land_hot', 'land_mild'].includes(b.environment) ? b.environment : 'pool_indoor',
    note: b.note ? String(b.note).slice(0, 200) : null,
  };
  if (!v.date) errors.date = 'التاريخ مطلوب وصحيح (YYYY-MM-DD).';
  else if (today && v.date > today) errors.date = 'ما ينفعش تسجل حصة بتاريخ لسه ما جاش.';
  for (const [k, lab] of [['preKg', 'الوزن قبل'], ['postKg', 'الوزن بعد']]) {
    if (!(v[k] >= 30 && v[k] <= 250)) errors[k] = `${lab} يجب أن يكون بين 30 و250 كجم.`;
  }
  if (!(v.durationMin >= LIMITS.minMin && v.durationMin <= LIMITS.maxMin)) errors.durationMin = `مدة الحصة بين ${LIMITS.minMin} و${LIMITS.maxMin} دقيقة.`;
  if (!(v.fluidL >= 0 && v.fluidL <= 6)) errors.fluidL = 'السوائل المشروبة بين 0 و6 لتر.';
  if (!(v.urineL >= 0 && v.urineL <= 3)) errors.urineL = 'كمية البول بين 0 و3 لتر.';
  if (!errors.preKg && !errors.postKg && Math.abs(v.preKg - v.postKg) > LIMITS.maxDeltaKg) errors.postKg = 'الفرق بين الوزن قبل وبعد غير منطقي؛ راجع القياس.';
  if (!Object.keys(errors).length) {
    const r = sweatRate(v);
    if (r.sweatRateLph > LIMITS.maxRateLph) errors.fluidL = 'معدل التعرق الناتج أعلى من 4 لتر/ساعة؛ غالبًا في خطأ في الإدخال.';
    if (r.sweatLossL < 0) errors.postKg = 'النتيجة تعطي عرقًا سالبًا؛ راجع الوزن والسوائل والبول.';
  }
  return { value: v, errors };
}

function sweatRate({ preKg, postKg, fluidL = 0, urineL = 0, durationMin }) {
  const hours = durationMin / 60;
  const sweatLossL = preKg - postKg + fluidL - urineL;
  const changeKg = postKg - preKg;
  const changePct = (changeKg / preKg) * 100;
  return {
    sweatLossL: round(sweatLossL, 2),
    sweatRateLph: round(sweatLossL / hours, 2),
    bodyMassChangeKg: round(changeKg, 2),
    bodyMassChangePct: round(changePct, 2),
    replacedPct: sweatLossL > 0 ? Math.round((fluidL / sweatLossL) * 100) : null,
  };
}

// Interprets one session. Returns flags + advice; never a diagnosis.
function assessSession(s) {
  const r = sweatRate(s);
  const flags = [];
  const advice = [];
  const deficitKg = Math.max(0, -r.bodyMassChangeKg);
  if (r.bodyMassChangePct <= -2) {
    flags.push({ code: 'LOSS_OVER_2PCT', level: 'warn', text: `خسرت ${Math.abs(r.bodyMassChangePct)}% من وزنك في الحصة (2% أو أكتر) — ده بيأثر على الأداء.` });
  } else if (r.bodyMassChangePct < -1) {
    flags.push({ code: 'LOSS_1_2PCT', level: 'info', text: `خسرت ${Math.abs(r.bodyMassChangePct)}% من وزنك في الحصة؛ حاول تشرب أكتر شوية أثناء الحصة الجاية.` });
  }
  if (r.bodyMassChangeKg > 0) {
    flags.push({ code: 'GAINED_WEIGHT', level: 'warn', text: 'وزنك زاد بعد الحصة: شربت أكتر من اللي عرقته. الإفراط في الشرب ممكن يكون خطر (نقص الصوديوم في الدم)؛ اشرب على قد احتياجك.' });
  }
  if (deficitKg > 0) {
    advice.push(`بعد الحصة: اشرب حوالي ${round(deficitKg * 1.25, 1)}–${round(deficitKg * 1.5, 1)} لتر على مدار الساعات الجاية (125–150% من الفاقد)، ويفضل مع أكل أو مشروب فيه ملح (لبن، مشروب رياضي، وجبة).`);
  }
  // App rule (derived, not from a reference): to stay under a 2 % loss next time, drink between
  // (expected sweat − 2 % body mass) and the expected sweat — never more than the sweat itself.
  const h = s.durationMin / 60;
  const expected = r.sweatRateLph * h;
  const lo = Math.max(0, expected - 0.02 * s.preKg);
  if (expected > 0) {
    advice.push(`في حصة بنفس المدة والظروف: اشرب من ${round(lo, 1)} إلى ${round(expected, 1)} لتر أثناءها (ما تزودش عن العرق نفسه).`);
  }
  if (s.durationMin > 60) advice.push('الحصة أطول من ساعة: مشروب رياضي (4–8 جم كربوهيدرات لكل 100 مل، وصوديوم 500–700 ملجم/لتر) أو سناك كربوهيدرات مفيد، واشطف بقّك بمية بعده.');
  else advice.push('الحصة أقل من ساعة: المية كفاية غالبًا.');
  return { ...r, flags, advice, method: 'mass-balance: (قبل − بعد + سوائل − بول) ÷ الساعات؛ 1 كجم ≈ 1 لتر' };
}

// Weight / Urine / Thirst likelihood (broad2019, Fig 5.1).
function wutCheck({ weightDown, urineDark, thirsty }) {
  const n = [weightDown, urineDark, thirsty].filter(Boolean).length;
  const level = n >= 3 ? 'very_likely' : n === 2 ? 'likely' : n === 1 ? 'possible' : 'unlikely';
  const text = {
    very_likely: 'الجفاف مرجّح جدًا: اشرب بانتظام النهارده ومع الوجبات، وراجع لون البول.',
    likely: 'الجفاف مرجّح: زوّد السوائل على مدار اليوم ومع الوجبات.',
    possible: 'مؤشر واحد فقط؛ تابع بكرة الصبح.',
    unlikely: 'لا توجد مؤشرات جفاف.',
  }[level];
  return { count: n, level, text };
}

function summarize(sessions) {
  if (!sessions.length) return null;
  const rates = sessions.map((s) => sweatRate(s).sweatRateLph);
  const recent = rates.slice(-5);
  return {
    sessions: sessions.length,
    avgSweatRateLph: round(recent.reduce((a, b) => a + b, 0) / recent.length, 2),
    minLph: Math.min(...recent), maxLph: Math.max(...recent),
    basedOnLast: recent.length,
  };
}

module.exports = { validateSession, sweatRate, assessSession, wutCheck, summarize, LIMITS };
