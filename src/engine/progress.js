'use strict';
const { diffDays, addDays } = require('./dates');
const { round } = require('./calculator');

// Section 6 — weekly progress. Weeks are counted from the plan start date.
// A week's weight is the MEAN of its weigh-ins (not a single day's reading).
function weeklyAverages(entries, startDate) {
  const buckets = new Map();
  for (const e of entries) {
    const d = diffDays(startDate, e.date);
    if (d < 0) continue;
    const w = Math.floor(d / 7);
    if (!buckets.has(w)) buckets.set(w, []);
    buckets.get(w).push(e.weightKg);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([week, ws]) => ({
    week,
    from: addDays(startDate, week * 7),
    to: addDays(startDate, week * 7 + 6),
    avgWeight: round(ws.reduce((s, x) => s + x, 0) / ws.length, 2),
    weighIns: ws.length,
  }));
}

function buildProgress({ goal, entries, checkins }) {
  const avgs = weeklyAverages(entries, goal.startDate);
  const byWeek = new Map(checkins.map((c) => [c.week, c]));
  const weeks = new Set([...avgs.map((a) => a.week), ...checkins.map((c) => c.week)]);
  const avgByWeek = new Map(avgs.map((a) => [a.week, a]));
  // loss: +1, gain: −1 — progress is the change in the planned direction
  const sign = goal.targetWeight > goal.startWeight ? -1 : 1;
  const totalToLose = (goal.startWeight - goal.targetWeight) * sign;
  const rows = [];
  let prev = null;
  for (const week of [...weeks].sort((a, b) => a - b)) {
    const a = avgByWeek.get(week);
    const c = byWeek.get(week) || {};
    const avgWeight = a ? a.avgWeight : (c.avgWeight ?? null);
    const row = {
      week,
      from: addDays(goal.startDate, week * 7),
      to: addDays(goal.startDate, week * 7 + 6),
      avgWeight,
      weighIns: a ? a.weighIns : 0,
      lowWeighInCount: a ? a.weighIns < 3 : true,
      changeVsPrev: avgWeight != null && prev?.avgWeight != null ? round(avgWeight - prev.avgWeight, 2) : null,
      changeSinceStart: avgWeight != null ? round(avgWeight - goal.startWeight, 2) : null,
      goalProgressPct: avgWeight != null ? round(Math.max(0, Math.min(100, (((goal.startWeight - avgWeight) * sign) / totalToLose) * 100)), 1) : null,
      waistCm: c.waistCm ?? null,
      bodyFatPct: c.bodyFatPct ?? null,
      bodyFatMethod: c.bodyFatMethod ?? null,
      caloriesAvg: c.caloriesAvg ?? null,
      adherencePct: c.adherencePct ?? null,
      performance: c.performance ?? null,
      hunger: c.hunger ?? null,
      energy: c.energy ?? null,
      sleep: c.sleep ?? null,
      recovery: c.recovery ?? null,
      checklistConfirmed: !!c.checklistConfirmed,
      notes: c.notes ?? null,
    };
    row.interpretation = interpret(row, prev, goal);
    rows.push(row);
    if (avgWeight != null) prev = row;
  }
  return rows;
}

function interpret(row, prev, goal) {
  const out = [];
  if (row.lowWeighInCount) out.push('عدد مرات الوزن هذا الأسبوع أقل من 3؛ المتوسط أقل موثوقية. يُفضل الوزن صباحًا بعد دخول الحمام وقبل الأكل.');
  if (goal.targetWeight > goal.startWeight) {
    if (row.changeVsPrev != null && row.changeVsPrev > 0.8) out.push('زيادة كبيرة في أسبوع واحد غالبًا ماء وجليكوجين وأكل في المعدة، مش عضل أو دهون بالكامل.');
    return out;
  }
  if (row.week === 0 || (prev && prev.week === 0 && row.changeVsPrev != null && row.changeVsPrev < -1)) {
    if (row.changeSinceStart != null && row.changeSinceStart < -(goal.startWeight * 0.01)) {
      out.push('الانخفاض الكبير في البداية غالبًا ماء وجليكوجين ومحتوى الجهاز الهضمي، وليس دهونًا بالكامل.');
    }
  }
  if (row.changeVsPrev != null && row.changeVsPrev > 0.3) {
    out.push('زيادة مؤقتة قد تكون بسبب سوائل (ملح، تدريب جديد، دورة شهرية) أو جليكوجين؛ انظر للاتجاه على عدة أسابيع.');
  }
  return out;
}

// Least-squares slope of weekly averages (kg per week). Negative = losing.
function trendSlope(rows, lastN = 4) {
  const pts = rows.filter((r) => r.avgWeight != null).slice(-lastN);
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((s, r) => s + r.week, 0) / n;
  const my = pts.reduce((s, r) => s + r.avgWeight, 0) / n;
  let num = 0, den = 0;
  for (const r of pts) { num += (r.week - mx) * (r.avgWeight - my); den += (r.week - mx) ** 2; }
  return { slopeKgPerWeek: round(num / den, 3), weeksUsed: n };
}

module.exports = { weeklyAverages, buildProgress, trendSlope };
