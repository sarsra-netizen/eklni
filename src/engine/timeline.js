'use strict';
const { addDays, diffDays } = require('./dates');
const { round, calcTimeline } = require('./calculator');
const { trendSlope } = require('./progress');

// Section 8 — goal timeline: planned line, actual averages, three explicit-rate scenarios,
// and a projection from current data with a stated reason for any change.
const SCENARIOS = [
  { key: 'medium', ar: 'السيناريو المتوسط', factor: 1.0, desc: 'بالمعدل المخطط' },
  { key: 'conservative', ar: 'السيناريو المحافظ', factor: 0.75, desc: '75% من المعدل المخطط' },
  { key: 'slowest', ar: 'السيناريو الأبطأ', factor: 0.5, desc: '50% من المعدل المخطط' },
];

function buildTimeline({ goal, rows, previousProjection }) {
  const rate = goal.weeklyRateKg;
  const gain = goal.targetWeight > goal.startWeight;
  const sign = gain ? -1 : 1; // weight moves by −sign·rate each week
  const direction = gain ? 'gain' : 'loss';
  const toLose = (goal.startWeight - goal.targetWeight) * sign;
  const scenarios = SCENARIOS.map((s) => {
    const r = rate * s.factor;
    const t = calcTimeline({ currentWeight: goal.startWeight, targetWeight: goal.targetWeight, weeklyRateKg: r, startDate: goal.startDate, direction });
    return { ...s, rateKg: round(r, 2), weeks: t.estimatedWeeks, completionDate: t.completionDate };
  });
  const plannedWeeks = Math.ceil(toLose / rate);
  const planned = [];
  for (let w = 0; w <= plannedWeeks; w++) {
    planned.push({ week: w, date: addDays(goal.startDate, w * 7), weight: round(gain ? Math.min(goal.targetWeight, goal.startWeight + rate * w) : Math.max(goal.targetWeight, goal.startWeight - rate * w), 2) });
  }

  const actual = rows.filter((r) => r.avgWeight != null).map((r) => ({ week: r.week, date: r.from, weight: r.avgWeight }));
  const current = actual[actual.length - 1] || null;
  const trend = trendSlope(rows);
  let projection;

  if (!current) {
    projection = { basis: 'plan', completionDate: scenarios[0].completionDate, reason: 'لا توجد قياسات بعد؛ الموعد محسوب من المعدل المخطط.' };
  } else {
    const remaining = (current.weight - goal.targetWeight) * sign;
    const weekEnd = addDays(goal.startDate, current.week * 7 + 3); // mid-week of last averaged week
    if (remaining <= 0) {
      projection = { basis: 'reached', completionDate: weekEnd, reason: 'متوسط الوزن وصل إلى الهدف أو تجاوزه.' };
    } else if (trend && trend.weeksUsed >= 2 && -trend.slopeKgPerWeek * sign >= 0.05) {
      const obs = -trend.slopeKgPerWeek * sign;
      projection = { basis: 'trend', observedRateKg: round(obs, 2), completionDate: addDays(weekEnd, Math.ceil((remaining / obs) * 7)),
        reason: `محسوب من متوسط ${gain ? 'الزيادة' : 'الخسارة'} الفعلي آخر ${trend.weeksUsed} أسابيع (${round(obs, 2)} كجم/أسبوع) مقابل ${rate} كجم/أسبوع مخطط.` };
    } else {
      projection = { basis: 'plan_from_current', completionDate: addDays(weekEnd, Math.ceil((remaining / rate) * 7)),
        reason: trend ? 'الاتجاه الفعلي ثابت تقريبًا؛ لا يمكن التوقع منه، لذا استُخدم المعدل المخطط من الوزن الحالي.' : 'بيانات أسبوع واحد فقط؛ استُخدم المعدل المخطط من الوزن الحالي.' };
    }
  }
  if (previousProjection && previousProjection !== projection.completionDate) {
    const d = diffDays(previousProjection, projection.completionDate);
    projection.changeDays = d;
    projection.changeText = d > 0 ? `تأخر الموعد المتوقع ${d} يومًا. ${projection.reason}` : `تقدم الموعد المتوقع ${-d} يومًا. ${projection.reason}`;
  }
  return {
    startWeight: goal.startWeight,
    currentWeight: current ? current.weight : goal.startWeight,
    targetWeight: goal.targetWeight,
    direction,
    planned, actual, scenarios, projection,
    disclaimer: 'كل التواريخ تقديرات حسابية؛ المسار الفعلي غير خطي ويتأثر بالسوائل والتكيف.',
  };
}

module.exports = { buildTimeline, SCENARIOS };
