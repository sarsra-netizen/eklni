'use strict';
// Exportable progress report (printable HTML → "Save as PDF" from the browser) and CSV export.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (x, d = 1) => (x == null ? '—' : Number(x).toFixed(d));
const GOALS = { fat_loss: 'خسارة الدهون', preserve_muscle: 'الحفاظ على العضلات', performance: 'تحسين الأداء أثناء خسارة الوزن', muscle_gain: 'زيادة الكتلة العضلية', weight_gain: 'زيادة الدهون والكتلة العضلية', fat_gain: 'زيادة الدهون فقط' };
const STATUS = { pending: 'بانتظار القرار', accepted: 'مقبول', rejected: 'مرفوض', superseded: 'استُبدل', info: 'معلومة' };

function chartSvg(t) {
  const W = 640, H = 260, L = 44, R = 12, T = 14, B = 30;
  const pts = [...t.planned, ...t.actual];
  const maxW = Math.max(...t.planned.map((p) => p.week), ...t.actual.map((p) => p.week), 1);
  const ys = pts.map((p) => p.weight).concat([t.targetWeight]);
  const lo = Math.floor(Math.min(...ys) - 0.5), hi = Math.ceil(Math.max(...ys) + 0.5);
  const x = (w) => L + (w / maxW) * (W - L - R);
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const line = (arr) => arr.map((p, i) => `${i ? 'L' : 'M'}${x(p.week).toFixed(1)},${y(p.weight).toFixed(1)}`).join(' ');
  let grid = '';
  for (let v = lo; v <= hi; v += Math.max(1, Math.round((hi - lo) / 5))) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e7eb"/><text x="${L - 6}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="#6b7280">${v}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="مخطط الوزن" style="direction:ltr">${grid}
  <line x1="${L}" x2="${W - R}" y1="${y(t.targetWeight)}" y2="${y(t.targetWeight)}" stroke="#15803d" stroke-dasharray="4 4"/>
  <path d="${line(t.planned)}" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="6 4"/>
  ${t.actual.length ? `<path d="${line(t.actual)}" fill="none" stroke="#0e7490" stroke-width="2.5"/>${t.actual.map((p) => `<circle cx="${x(p.week)}" cy="${y(p.weight)}" r="3.5" fill="#0e7490"/>`).join('')}` : ''}
  <text x="${(W + L) / 2}" y="${H - 6}" font-size="11" text-anchor="middle" fill="#6b7280">الأسبوع</text></svg>`;
}

// Audit 2026-10-22 (F1): target, planned and logged intake side by side; days without a complete log are labelled,
// never filled from the target.
function intakeSection(w) {
  if (!w || !w.days) return '';
  const cell = (t) => (t ? `${t.kcal}` : '—');
  const rows = w.days.map((d) => `<tr><td>${esc(d.date)}</td><td>${d.target ? d.target.kcal : '—'}</td><td>${cell(d.planned)}</td><td>${cell(d.logged)}</td><td>${esc(d.statusAr)}</td></tr>`).join('');
  return `<h2>الأكل: الهدف والمخطط والمسجّل (الأسبوع الحالي)</h2>
<table><tr><th>اليوم</th><th>الهدف (سعرة)</th><th>المخطط (أكل الخطة)</th><th>المسجّل (اللي اتاكل)</th><th>حالة التسجيل</th></tr>${rows}</table>
<p class="note">أيام متسجلة كاملة: ${w.completeDays} · ناقصة: ${w.partialDays} · من غير تسجيل: ${w.unloggedDays}. ${w.avgLoggedKcalCompleteDays != null ? `متوسط المسجّل في الأيام الكاملة ${w.avgLoggedKcalCompleteDays} سعرة مقابل هدف ${w.avgTargetKcalCompleteDays}.` : ''} ${esc(w.note)}</p>`;
}

function renderReport(st, user, branding, intakeWeek = null) {
  const sig = branding && branding.signature ? esc(branding.signature) : '';
  const logo = branding && branding.logo && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(branding.logo) ? branding.logo : null;
  const g = st.goal, p = st.plan, nut = p.nutrition, t = st.timeline;
  const rows = st.rows.map((r) => `<tr><td>${r.week + 1}</td><td>${r.from}</td><td>${n(r.avgWeight, 2)}</td><td>${r.weighIns}</td><td>${n(r.changeVsPrev, 2)}</td><td>${n(r.changeSinceStart, 2)}</td><td>${n(r.goalProgressPct, 0)}%</td><td>${n(r.waistCm)}</td><td>${r.adherencePct ?? '—'}</td><td>${r.performance ?? '—'}</td><td>${r.sleep ?? '—'}</td></tr>`).join('');
  const adj = st.adjustments.map((a) => `<tr><td>${esc(a.createdAt.slice(0, 10))}</td><td>${a.kcalChange ? (a.kcalChange > 0 ? '+' : '') + a.kcalChange : '—'}</td><td>${esc(STATUS[a.status] || a.status)}</td><td>${a.reasons.map(esc).join('<br>')}</td></tr>`).join('');
  const day = (d, label) => d ? `<tr><th>${label}</th><td>${d.kcal}</td><td>${d.proteinG}</td><td>${d.carbG}</td><td>${d.fatG}</td><td>${d.fiberG}</td></tr>` : '';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>تقرير التقدم — أكلني | Eklni</title>
<style>
@page{size:A4;margin:14mm 12mm 18mm;@bottom-left{content:"صفحة " counter(page) " من " counter(pages);font-size:9px;color:#6b7280}}
body{font-family:"Segoe UI",Tahoma,"Noto Naskh Arabic",sans-serif;color:#111827;max-width:900px;margin:0 auto;padding:24px;line-height:1.6}
h1{font-size:22px;margin:0}h2{font-size:16px;border-bottom:2px solid #0e7490;padding-bottom:4px;margin-top:28px}
.sub{color:#6b7280;font-size:13px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.kpi{border:1px solid #e5e7eb;border-radius:8px;padding:10px}.kpi b{display:block;font-size:20px}.kpi span{font-size:12px;color:#6b7280}
table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{border:1px solid #e5e7eb;padding:5px 6px;text-align:center}th{background:#f3f4f6}
.warn{background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:8px 12px;font-size:13px}
.note{font-size:12px;color:#6b7280}.legend span{margin-inline-end:14px;font-size:12px}
.hold{background:#fef2f2;border:1px solid #dc2626;border-radius:8px;padding:8px 12px;font-size:13px}
.sig{text-align:center;font-size:12px;color:#374151;border-top:1px solid #e5e7eb;padding-top:4px;margin-top:24px}

.wm{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:-1}.wm img{max-width:55%;max-height:55%;opacity:.06}
@media print{.noprint{display:none}body{padding:0 0 28px}.sig{position:fixed;bottom:0;left:0;right:0;background:#fff;margin:0}}
</style></head><body>
${logo ? `<div class="wm"><img src="${logo}" alt=""></div>` : ''}
<button class="noprint" onclick="window.print()" style="float:left;padding:6px 14px">طباعة / حفظ PDF</button>
<h1>أكلني | Eklni — تقرير خطة ${nut.direction === 'gain' ? 'زيادة' : 'خسارة'} الوزن</h1>
<div class="sub">${g.input.fullName ? `الاسم: <b>${esc(g.input.fullName)}</b> · ` : ''}${esc(user?.email || '')} · تاريخ التقرير ${esc(st.today)} · بداية الخطة ${esc(g.startDate)} · الهدف: ${esc(GOALS[g.input.primaryGoal] || '')}</div>
${st.hold && st.hold.hold ? `<div class="hold"><b>الخطة على سعرات الثبات (بدون عجز) لحين مراجعة مختص.</b><br>${st.hold.flags.filter((f) => f.level !== 'info').map((f) => esc(f.text)).join('<br>')}</div>` : ''}
<h2>الملخص</h2>
<div class="grid">
<div class="kpi"><span>الوزن الابتدائي</span><b>${n(g.startWeight)} كجم</b></div>
<div class="kpi"><span>متوسط الوزن الحالي</span><b>${n(t.currentWeight)} كجم</b></div>
<div class="kpi"><span>الوزن المستهدف</span><b>${n(g.targetWeight)} كجم</b></div>
<div class="kpi"><span>الموعد المتوقع (تقديري)</span><b>${esc(t.projection.completionDate)}</b></div>
</div>
<p class="note">${esc(t.projection.reason)} — ${esc(t.disclaimer)}</p>
<h2>المخطط الزمني</h2>
<div class="legend"><span style="color:#94a3b8">— — الخط المخطط</span><span style="color:#0e7490">● متوسط الوزن الأسبوعي الفعلي</span><span style="color:#15803d">- - الوزن المستهدف</span></div>
${chartSvg(t)}
<table><tr><th>السيناريو</th><th>المعدل (كجم/أسبوع)</th><th>المدة (أسبوع)</th><th>التاريخ التقريبي</th></tr>
${t.scenarios.map((s) => `<tr><td>${esc(s.ar)} (${esc(s.desc)})</td><td>${s.rateKg}</td><td>${s.weeks}</td><td>${s.completionDate}</td></tr>`).join('')}</table>
<h2>الأهداف الغذائية الحالية</h2>
<table><tr><th></th><th>سعرات</th><th>بروتين (جم)</th><th>كربوهيدرات (جم)</th><th>دهون (جم)</th><th>ألياف (جم)</th></tr>
${day(st.targets.trainingDay, 'يوم تدريب')}${day(st.targets.restDay, 'يوم راحة')}</table>
<p class="note">معدل الأيض أثناء الراحة ${nut.needs.bmrKey === 'measured' ? 'المقاس' : 'المتوقع (معادلة، مش قياس)'} ${nut.needs.bmr} سعرة · الاحتياج اليومي المقدّر ${nut.needs.tdeeAvg} سعرة${nut.needs.tdeeRange ? ` (سيناريو ${nut.needs.tdeeRange.low}–${nut.needs.tdeeRange.high})` : ''} (${esc(nut.needs.bmrEquation)}) · ${nut.direction === 'gain' ? `الفائض ${nut.dailySurplus} سعرة/يوم (${nut.surplusPctOfTdee}%)` : `العجز ${nut.dailyDeficit} سعرة/يوم (${nut.deficitPctOfTdee}%)`} · تعديلات مقبولة: ${st.targets.adjustmentKcal} سعرة · توافر الطاقة ${nut.energyAvailability} سعرة/كجم كتلة خالية من الدهون${nut.energyAvailabilityStatus ? ` (${esc(nut.energyAvailabilityStatus.ar)})` : ''}.</p>
${p.requiresProfessional ? '<div class="warn">هذه الخطة تحتاج مراجعة أخصائي تغذية رياضية أو طبيب قبل التطبيق.</div>' : ''}
<p class="note">إصدار الحسابات: ${esc(st.calcVersion || 'قبل ترقيم الإصدارات')}${st.planReview ? ` · مراجعة الأخصائي: ${esc(st.planReview.text)}${st.planReview.note && st.planReview.state !== 'none' ? ` — ${esc(st.planReview.note)}` : ''}` : ''}</p>
${intakeSection(intakeWeek)}
<h2>المتابعة الأسبوعية</h2>
<table><tr><th>أسبوع</th><th>من</th><th>متوسط الوزن</th><th>عدد القياسات</th><th>تغير أسبوعي</th><th>منذ البداية</th><th>تحقيق الهدف</th><th>الخصر</th><th>التزام %</th><th>أداء</th><th>نوم</th></tr>${rows || '<tr><td colspan="11">لا توجد بيانات</td></tr>'}</table>
<p class="note">التغير في الوزن يشمل الدهون والماء والجليكوجين ومحتوى الجهاز الهضمي؛ لا يمكن تحديد الدهون المفقودة بدقة من الوزن وحده.</p>
<h2>سجل التعديلات</h2>
<table><tr><th>التاريخ</th><th>تغيير السعرات</th><th>الحالة</th><th>السبب</th></tr>${adj || '<tr><td colspan="4">لا توجد تعديلات</td></tr>'}</table>
<h2>المراجع المستخدمة في الحسابات</h2>
<ul class="note">
<li>Broad E. (ed.). Sports Nutrition for Paralympic Athletes, 2nd ed. CRC Press, 2019 — معادلات RMR (Table 3.1)، توافر الطاقة (§4.2)، الترطيب.</li>
<li>Barclay & McDonald. Nutrition for Swimmers, 2012 — توقيت الوجبات والسوائل للسباحين.</li>
<li>U.S. DHHS & USDA. 2015–2020 Dietary Guidelines for Americans, Appendix 7 — RDA.</li>
<li>Gropper, Smith & Carr. Advanced Nutrition and Human Metabolism, 8th ed., Cengage — UL.</li>
</ul>
<p class="note">أكلني (Eklni) أداة تخطيط تقديرية ولا تغني عن تقييم أخصائي تغذية رياضية أو طبيب. الأهداف محسوبة من معادلات (تقديرية)، والقيم الغذائية للأصناف من USDA والمعهد القومي للتغذية، ومراجعتها متسجلة في قاعدة الأصناف.</p>
<div class="sig">أكلني | Eklni — منصة التغذية الذكية${sig ? ` · ${sig}` : ''}</div>
</body></html>`;
}

function renderCsv(st) {
  const cols = ['week', 'from', 'to', 'avgWeight', 'weighIns', 'changeVsPrev', 'changeSinceStart', 'goalProgressPct', 'waistCm', 'bodyFatPct', 'caloriesAvg', 'adherencePct', 'performance', 'hunger', 'energy', 'sleep', 'recovery'];
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return '﻿' + [cols.join(','), ...st.rows.map((r) => cols.map((c) => q(c === 'week' ? r.week + 1 : r[c])).join(','))].join('\n') + '\n';
}

module.exports = { renderReport, renderCsv };
