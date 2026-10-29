'use strict';
const { addDays, monthsAndDays, diffDays } = require('./dates');

// Section 2 — Weight loss rate calculator.
// Weight To Lose = Current − Target
// Estimated Weeks = Weight To Lose / Planned weekly rate
// Completion = Start + Estimated Weeks (converted to whole days on the real calendar)
function calcTimeline({ currentWeight, targetWeight, weeklyRateKg, startDate, direction = 'loss' }) {
  const gain = direction === 'gain';
  const change = round(gain ? targetWeight - currentWeight : currentWeight - targetWeight, 2);
  if (!(change > 0)) {
    const e = new Error(gain ? 'الوزن المستهدف يجب أن يكون أعلى من الوزن الحالي في خطة زيادة الوزن.' : 'الوزن المستهدف يجب أن يكون أقل من الوزن الحالي في خطة خسارة الوزن.');
    e.code = gain ? 'TARGET_NOT_ABOVE_CURRENT' : 'TARGET_NOT_BELOW_CURRENT';
    throw e;
  }
  const weightToLose = gain ? null : change;
  if (!(weeklyRateKg > 0)) {
    const e = new Error('المعدل الأسبوعي يجب أن يكون أكبر من صفر.');
    e.code = 'INVALID_RATE';
    throw e;
  }
  const weeks = change / weeklyRateKg;
  const days = Math.ceil(weeks * 7);
  const completionDate = addDays(startDate, days);
  const md = monthsAndDays(startDate, completionDate);
  return {
    direction,
    weightToLose,
    weightToGain: gain ? change : null,
    weightChange: change,
    estimatedWeeks: round(weeks, 1),
    estimatedDays: days,
    calendarMonths: md.months,
    remainderDays: md.days,
    approxMonths: round(days / 30.4375, 1),
    completionDate,
    isEstimate: true,
    note: 'هذه مدة تقديرية حسابية مبنية على معدل ثابت، وليست وعدًا بالوصول في هذا التاريخ؛ تغيرات السوائل والجليكوجين والتكيف الأيضي تجعل المسار الفعلي غير خطي.',
  };
}

// What weekly rate would a user-chosen target date require, and is it within the safe range?
function evaluateTargetDate({ currentWeight, targetWeight, startDate, targetDate, maxSafeRateKg, recommendedRateKg, direction = 'loss' }) {
  const days = diffDays(startDate, targetDate);
  const gain = direction === 'gain';
  const toLose = gain ? targetWeight - currentWeight : currentWeight - targetWeight;
  if (days <= 0) {
    return { feasible: false, code: 'TARGET_DATE_NOT_AFTER_START', message: 'التاريخ المستهدف يجب أن يكون بعد تاريخ البداية.' };
  }
  const requiredRateKg = round(toLose / (days / 7), 2);
  const feasible = requiredRateKg <= maxSafeRateKg + 1e-9;
  const res = { feasible, requiredRateKg, daysAvailable: days };
  if (!feasible) {
    res.code = 'TARGET_DATE_TOO_AGGRESSIVE';
    res.message = `الوصول في هذا التاريخ يتطلب ${gain ? 'زيادة' : 'خسارة'} ${requiredRateKg} كجم أسبوعيًا، وهذا أعلى من الحد الآمن المحدد لحالتك (${round(maxSafeRateKg, 2)} كجم). ${gain ? 'الزيادة الأسرع غالبًا بتبقى دهون زيادة.' : 'لا ننصح بعجز شديد لمجرد اللحاق بموعد.'}`;
    res.alternatives = [
      { label: 'بالمعدل الموصى به', rateKg: recommendedRateKg, ...pick(calcTimeline({ currentWeight, targetWeight, weeklyRateKg: recommendedRateKg, startDate, direction })) },
      { label: 'بأقصى معدل آمن', rateKg: round(maxSafeRateKg, 2), ...pick(calcTimeline({ currentWeight, targetWeight, weeklyRateKg: maxSafeRateKg, startDate, direction })) },
    ];
    // Interim target reachable by the chosen date at the recommended rate
    res.interimTargetWeight = round(currentWeight + (gain ? 1 : -1) * recommendedRateKg * (days / 7), 1);
  }
  return res;
}

function pick(t) {
  return { completionDate: t.completionDate, estimatedWeeks: t.estimatedWeeks };
}

function round(x, d = 1) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

module.exports = { calcTimeline, evaluateTargetDate, round };
