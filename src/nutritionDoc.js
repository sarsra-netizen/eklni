'use strict';
// Printable nutrition file (A4, RTL). The browser's "Save as PDF" turns it into a PDF: this keeps Arabic
// shaping correct without a server-side PDF engine. Branding (signature on every page + faint logo
// watermark) comes from the athlete's academy, when it has set one.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r0 = (x) => (x == null ? '—' : Math.round(x));
const STATE = { raw: 'نيئ', cooked: 'مطهو', ready: 'جاهز' };
const { provenanceOf } = require('./engine/meals');
const REFS = require('./data/references.json').references;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function itemsList(items) {
  return items.filter((i) => i.foodId !== 'water' || i.grams >= 100)
    .map((i) => `${esc(i.ar)} <b>${i.grams}</b> جم${i.state && i.state !== 'ready' ? ` (${STATE[i.state]})` : ''}${i.units ? ` <span class="u">${esc(i.units)}</span>` : ''}`).join(' · ');
}

function mealRow(m) {
  if (m.free) return `<tr><td class="t">${esc(m.time)}</td><td colspan="5"><b>${esc(m.label)}</b> — وجبة حرة: ميزانية حوالي ${r0(m.target && m.target.kcal)} سعرة (هدف، مش أكل محسوب؛ مش داخلة في الإجمالي)</td></tr>`;
  if (m.empty) return `<tr><td class="t">${esc(m.time)}</td><td colspan="5">${esc(m.label)} — —</td></tr>`;
  const extras = (m.extras || []).map((e) => `<div class="x">+ ${esc(e.ar)}: ${itemsList(e.items)}</div>`).join('');
  return `<tr><td class="t">${esc(m.time)}</td>
    <td><b>${esc(m.label)}</b>: ${esc(m.recipeAr)} <span class="u">(${m.servings === 1 ? 'حصة' : `${m.servings} حصة`})</span>
      <div class="ing">${itemsList(m.recipeItems || [])}</div>${extras}</td>
    <td>${r0(m.totals.kcal)}</td><td>${r0(m.totals.protein)}</td><td>${r0(m.totals.carb)}</td><td>${r0(m.totals.fat)}</td></tr>`;
}

function dayPage(d) {
  const sess = d.sessions.length ? d.sessions.map((s) => `${s.start}–${s.end}`).join(' و ') : 'راحة';
  const added = (d.added || []).map((a) => `<tr><td class="t">${esc(a.time || '')}</td><td>+ ${esc(a.ar)}<div class="ing">${itemsList(a.items)}</div></td><td>${r0(a.totals.kcal)}</td><td>${r0(a.totals.protein)}</td><td>${r0(a.totals.carb)}</td><td>${r0(a.totals.fat)}</td></tr>`).join('');
  return `<section class="page">
  <h2>${esc(d.dayAr)} ${esc(d.date)} <span class="tag">${d.training ? `تمرين: ${esc(sess)}` : 'راحة'}</span>${d.ramadan ? ' <span class="tag">رمضان</span>' : ''}${d.fasting && d.fasting !== 'none' ? ' <span class="tag">صيامي</span>' : ''}</h2>
  <table><thead><tr><th>الوقت</th><th>الوجبة والمكونات (لكل حصة بالجرام)</th><th>سعرات</th><th>بروتين</th><th>كربو</th><th>دهون</th></tr></thead>
  <tbody>${d.meals.map(mealRow).join('')}${added}</tbody>
  <tfoot><tr><th></th><th>إجمالي أكل الخطة المحسوب${d.freeMealBudget ? ` (من غير الوجبة الحرة ~${r0(d.freeMealBudget.kcal)} سعرة)` : ''} (المستهدف ${r0(d.targets.kcal)} سعرة · ${r0(d.targets.proteinG)} ب · ${r0(d.targets.carbG)} ك · ${r0(d.targets.fatG)} د)</th>
  <th>${r0(d.totals.kcal)}</th><th>${r0(d.totals.protein)}</th><th>${r0(d.totals.carb)}</th><th>${r0(d.totals.fat)}</th></tr></tfoot></table>
  ${d.notes && d.notes.length ? `<ul class="notes">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
</section>`;
}

// share: true → version for a share link: no e-mail, no screening/hold reasons, no energy-availability line,
// no personal sweat-rate figures, and no print button script.
const GOAL_AR = { fat_loss: 'خسارة الدهون', preserve_muscle: 'الحفاظ على العضلات', performance: 'تحسين الأداء أثناء خسارة الوزن', muscle_gain: 'زيادة الكتلة العضلية', weight_gain: 'زيادة الدهون والكتلة العضلية', fat_gain: 'زيادة الدهون فقط' };
// Audit 2026-10-22 (D4): RMR and TDEE as separate values, the method, the calculation version and the review state.
function methodsBlock(st, n, share) {
  const nd = n.needs;
  const r = nd.tdeeRange;
  const pr = st.planReview;
  const ref = REFS.find((x) => x.id === nd.bmrSource);
  const rows = [
    `معدل الأيض أثناء الراحة ${nd.bmrKey === 'measured' ? '(مقاس)' : '(متوقع بمعادلة، مش قياس)'}: <b>${r0(nd.bmr)}</b> سعرة — ${esc(nd.bmrEquation)}${ref ? ` · المرجع: ${esc(ref.title)} (${ref.year})` : ''}`,
    `الاحتياج اليومي المقدّر (TDEE): <b>${r0(nd.tdeeAvg)}</b> سعرة${r ? ` · سيناريو ${r0(r.low)}–${r0(r.high)} (${esc(r.basis)})` : ''}`,
    `معامل النشاط خارج التمرين ${nd.nonExercisePAL} · طاقة التمرين ${r0(nd.exercise.dailyAvgKcal)} سعرة/يوم في المتوسط (MET ${nd.exercise.metUsed} صافي)`,
    n.direction === 'gain' ? `الفائض المخطط ${r0(n.dailySurplus)} سعرة/يوم (${n.surplusPctOfTdee}% من الاحتياج)` : `العجز المخطط ${r0(n.dailyDeficit)} سعرة/يوم (${n.deficitPctOfTdee}% من الاحتياج)`,
    `تحويل الوزن: 7700 سعرة/كجم تقريب حسابي للبداية، مش توقع مضمون`,
    `إصدار الحسابات: ${esc(st.calcVersion || 'قبل ترقيم الإصدارات')}`,
  ];
  const review = pr ? `<p><b>مراجعة الأخصائي:</b> ${esc(pr.text)}${!share && pr.note && pr.state !== 'none' ? ` — ${esc(pr.note)}` : ''}</p>` : '';
  if (share) return `<p class="sub">إصدار الحسابات: ${esc(st.calcVersion || 'قبل ترقيم الإصدارات')}</p>${review}`;
  return `<h2>طريقة الحساب</h2><ul class="notes">${rows.map((x) => `<li>${x}</li>`).join('')}</ul>${review}`;
}
function provenanceBlock(plan) {
  const items = (plan.days || []).flatMap((d) => [...d.meals.flatMap((m) => (m.empty || m.free ? [] : [...(m.recipeItems || []), ...(m.extras || []).flatMap((e) => e.items)])), ...(d.added || []).flatMap((a) => a.items)]);
  const p = provenanceOf(items);
  return `<p class="disc"><b>مصادر القيم الغذائية في الخطة دي</b> (نسبة من السعرات): ${p.sources.map((x) => `${esc(x.name)} ${x.kcalPct}%`).join(' · ')}.
 أصناف مراجَعة: ${p.reviewedKcalPct}% من السعرات${p.reviewers.length ? ' (المراجعة متسجلة باسم المراجِع وتاريخها في قاعدة الأصناف)' : ''}${p.proxies.length ? ` · بدائل تقريبية: ${p.proxies.map(esc).join('، ')}` : ''}.</p>`;
}
function renderNutritionDoc({ st, plan, user, branding, hydration, displayName, today, share = false, shareName = null }) {
  const n = st.plan.nutrition;
  const sig = branding && branding.signature ? esc(branding.signature) : '';
  const logo = branding && branding.logo && LOGO_RE.test(branding.logo) ? branding.logo : null;
  const day = (d, label) => (d ? `<tr><th>${label}</th><td>${d.kcal}</td><td>${d.proteinG}</td><td>${d.carbG}</td><td>${d.fatG}</td></tr>` : '');
  const hold = !share && st.hold && st.hold.hold
    ? `<div class="hold"><b>الخطة على سعرات الثبات (بدون عجز) لحين مراجعة مختص.</b><br>${st.hold.flags.filter((f) => f.level !== 'info').map((f) => esc(f.text)).join('<br>')}</div>` : '';
  const grocery = (plan.grocery || []).map((g) => `<li>${esc(g.ar)}: <b>${g.grams}</b> جم${g.units ? ` (${esc(g.units)})` : ''}</li>`).join('');
  const hyd = !share && hydration && hydration.summary
    ? `<p>متوسط معدل العرق من آخر ${hydration.summary.basedOnLast} حصص: <b>${hydration.summary.avgSweatRateLph} لتر/ساعة</b>. اشرب أثناء الحصة على قد العرق من غير ما تزوّد عنه، وبعدها 125–150% من الوزن اللي نزل.</p>` : '<p>سجّل وزنك قبل وبعد الحصة في «صحتي ← السوائل والعرق» علشان نحسب احتياجك من السوائل.</p>';
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ملف التغذية — أكلني | Eklni</title>
<style>
@page{size:A4;margin:14mm 12mm 18mm;@bottom-left{content:"صفحة " counter(page) " من " counter(pages);font-size:9px;color:#6b7280}}
body{font-family:"Segoe UI",Tahoma,"Noto Naskh Arabic",sans-serif;color:#111827;font-size:12px;line-height:1.55;margin:0;padding:16px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:15px;border-bottom:2px solid #0e7490;padding-bottom:3px;margin:16px 0 8px}
.sub{color:#6b7280}.who{font-size:15px;margin:2px 0 4px}.tag{font-size:11px;background:#e3f2f5;color:#0e7490;border-radius:10px;padding:1px 8px;font-weight:600}
table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border:1px solid #e5e7eb;padding:4px 5px;vertical-align:top;text-align:center}
td:nth-child(2),th:nth-child(2){text-align:start}th{background:#f3f4f6}td.t{white-space:nowrap;font-weight:700}
.ing{color:#374151;font-size:11px;margin-top:2px}.x{font-size:11px;color:#0e7490}.u{color:#6b7280;font-size:11px}
.est{background:#fffbeb;border:1px solid #d97706;border-radius:8px;padding:6px 10px;margin:8px 0;font-weight:600}.hold{background:#fef2f2;border:1px solid #dc2626;border-radius:8px;padding:8px 10px;margin:8px 0}
.notes{font-size:11px;color:#374151}.grocery{columns:2;font-size:11.5px}.disc{font-size:10.5px;color:#6b7280}
.page{break-inside:avoid;page-break-inside:avoid}.newpage{break-before:page}tr{break-inside:avoid}
.wm{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:-1}
.wm img{max-width:55%;max-height:55%;opacity:.06}
.sig{position:fixed;bottom:0;left:0;right:0;text-align:center;font-size:11px;color:#374151;border-top:1px solid #e5e7eb;padding:3px 0;background:#fff}
.bar{position:sticky;top:0;background:#fff;padding:6px 0;border-bottom:1px solid #e5e7eb;margin-bottom:8px}
.bar button{padding:6px 14px;font-size:14px}
@media print{.bar{display:none}body{padding:0 0 22px}}
</style></head><body>
${logo ? `<div class="wm"><img src="${logo}" alt=""></div>` : ''}
${share ? '' : `<div class="bar"><button onclick="window.print()">حفظ PDF / طباعة</button> <span class="sub">اختار «Save as PDF» من نافذة الطباعة.</span></div>`}
<h1>ملف التغذية — أكلني | Eklni</h1>
${(share ? shareName : displayName) || GOAL_AR[st.goal && st.goal.input && st.goal.input.primaryGoal] ? `<div class="who">${(share ? shareName : displayName) ? `الاسم: <b>${esc(share ? shareName : displayName)}</b>` : ''}${GOAL_AR[st.goal && st.goal.input && st.goal.input.primaryGoal] ? `${(share ? shareName : displayName) ? ' · ' : ''}الهدف: <b>${GOAL_AR[st.goal.input.primaryGoal]}</b>` : ''}</div>` : ''}
<div class="sub">${!share && !displayName && user && user.email ? `${esc(user.email)} · ` : ''}${share ? 'نسخة مشاركة للقراءة · ' : ''}الأسبوع من ${esc(plan.startDate)} · تاريخ الإصدار ${esc(today)}</div>
${!share && st.targets && st.targets.override ? `<div class="est">سعرات مخصوصة اختارها الشخص: ${st.targets.override.kcal} سعرة/يوم من ${esc(st.targets.override.startsOn)} لحد ${esc(st.targets.override.endsOn)}، وبعدها بترجع الأهداف العادية.</div>` : ''}
${hold}
${!share && st.hold && st.hold.waiver ? `<div class="est">الخطة فيها عجز سعرات على المسؤولية الشخصية للاعب (${st.hold.completed ? 'رغم علامات في الفحص الصحي' : 'من غير فحص صحي'}). يُنصح بمراجعة مختص.</div>` : ''}
<h2>الأهداف اليومية</h2>
<table><tr><th></th><th>سعرات</th><th>بروتين (جم)</th><th>كربوهيدرات (جم)</th><th>دهون (جم)</th></tr>${day(st.targets.trainingDay, 'يوم تدريب')}${day(st.targets.restDay, 'يوم راحة')}</table>
${share ? '<p class="sub">أيام التدريب بتتظبط حسب مدة الحصص الفعلية في الجدول.</p>' : `<p class="sub">الاحتياج المقدّر ${n.needs.tdeeAvg} سعرة (${esc(n.needs.bmrEquation)}) · توافر الطاقة ${n.energyAvailability}${n.energyAvailabilityStatus ? ` (${esc(n.energyAvailabilityStatus.ar)})` : ''} · البروتين ${n.proteinPerKg} جم/كجم. أيام التدريب بتتظبط حسب مدة الحصص الفعلية في الجدول.</p>`}
${methodsBlock(st, n, share)}
<h2>طريقة التغذية</h2><ul>${(plan.approach || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>السوائل</h2>${hyd}
${plan.days.map(dayPage).join('')}
<section class="newpage"><h2>قائمة المشتريات للأسبوع</h2><ul class="grocery">${grocery}</ul>
${provenanceBlock(plan)}
<p class="disc">الكميات بالجرام للحالة المكتوبة (نيئ/مطهو). السعرات والماكروز محسوبة من الأصناف بالجرام، والأهداف تقديرية من معادلات. الملف تخطيط ولا يغني عن أخصائي تغذية رياضية أو طبيب.</p></section>
<div class="sig">أكلني | Eklni${sig ? ` · ${sig}` : ' — منصة التغذية الذكية'}</div>
</body></html>`;
}

module.exports = { renderNutritionDoc, LOGO_RE };
