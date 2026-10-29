'use strict';
// Notifications: decide what is due (pure), store it in the user's in-app inbox (the delivered channel),
// and optionally forward a minimal text to an external gateway the platform owner configured.
// Saving preferences (PUT /api/notifications) is separate from this delivery job.
//
// Privacy: messages never contain weights, calories or screening answers; external forwarding happens
// only for users who opted in and gave an address, and only to an https endpoint (NOTIFY_WEBHOOK_URL).

const DEFAULTS = { weighInReminder: true, weighInTime: '07:00', weeklyCheckinDay: 5, weeklyCheckinReminder: true, adjustmentAlerts: true,
  externalChannel: false, externalAddress: null };
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ATTEMPTS = 3;

function validateSettings(b = {}) {
  const errors = {};
  const s = {
    weighInReminder: b.weighInReminder === true,
    weighInTime: HM.test(b.weighInTime) ? b.weighInTime : null,
    weeklyCheckinDay: Number.isInteger(b.weeklyCheckinDay) && b.weeklyCheckinDay >= 0 && b.weeklyCheckinDay <= 6 ? b.weeklyCheckinDay : null,
    weeklyCheckinReminder: b.weeklyCheckinReminder === true,
    adjustmentAlerts: b.adjustmentAlerts === true,
    externalChannel: b.externalChannel === true,
    externalAddress: b.externalAddress == null || b.externalAddress === '' ? null : String(b.externalAddress).trim().slice(0, 100),
  };
  if (s.weighInTime == null) errors.weighInTime = 'الوقت بصيغة HH:MM.';
  if (s.weeklyCheckinDay == null) errors.weeklyCheckinDay = 'يوم غير صحيح.';
  if (s.externalChannel && !(s.externalAddress && (/^\+?\d{8,15}$/.test(s.externalAddress) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.externalAddress)))) {
    errors.externalAddress = 'اكتب رقم موبايل (أرقام بس) أو إيميل صحيح.';
  }
  if (!s.externalChannel) s.externalAddress = null; // never keep an address without consent
  return { value: s, errors };
}

// ctx: { date: 'YYYY-MM-DD', hhmm: 'HH:MM', weekday: 0..6 } in the app's time zone.
function dueFor(db, userId, ctx, sub) {
  const s = { ...DEFAULTS, ...(db.getNotifications(userId) || {}) };
  const out = [];
  const goal = db.activeGoal(userId);
  if (sub && sub.daysLeft != null && [5, 3, 1].includes(sub.daysLeft)) {
    out.push({ kind: 'subscription', key: `sub:${sub.endsOn}:${sub.daysLeft}`, title: 'الاشتراك قرب يخلص',
      body: `${sub.state === 'trial' ? 'الفترة التجريبية' : 'اشتراكك'} بيخلص بعد ${sub.daysLeft} ${sub.daysLeft === 1 ? 'يوم' : 'أيام'}. بعدها الأدوات بتتقفل لحد التجديد.` });
  }
  if (!sub || !sub.active || !goal) return out;
  if (s.weighInReminder && ctx.hhmm >= s.weighInTime && !db.weights(userId, goal.id).some((w) => w.date === ctx.date)) {
    out.push({ kind: 'weigh_in', key: `weigh:${ctx.date}`, title: 'وزن النهارده', body: 'سجّل وزنك الصبح بعد الحمام وقبل الأكل.' });
  }
  if (s.weeklyCheckinReminder && ctx.weekday === s.weeklyCheckinDay && ctx.hhmm >= s.weighInTime) {
    out.push({ kind: 'weekly_checkin', key: `checkin:${ctx.date}`, title: 'المراجعة الأسبوعية', body: 'كمّل المراجعة الأسبوعية (الأداء والنوم والجوع والالتزام).' });
  }
  if (s.adjustmentAlerts) {
    const p = db.adjustments(userId, goal.id).filter((a) => a.status === 'pending').pop();
    if (p) out.push({ kind: 'adjustment', key: `adj:${p.id}`, title: 'اقتراح تعديل مستني قرارك', body: 'فيه اقتراح تعديل للسعرات في صفحة التغذية؛ مش هيتطبق غير لما توافق.' });
  }
  return out;
}

// One scheduler tick. Returns counts. `send` (optional) forwards to the external gateway.
async function runDue(db, ctx, { subOf, send = null } = {}) {
  let created = 0; let forwarded = 0; let failed = 0;
  for (const u of db.allUsers()) {
    for (const n of dueFor(db, u.id, ctx, subOf(u.id))) if (db.addNotification(u.id, n)) created += 1;
  }
  if (send) {
    for (const n of db.pendingExternal(MAX_ATTEMPTS)) {
      const s = { ...DEFAULTS, ...(db.getNotifications(n.userId) || {}) };
      if (!s.externalChannel || !s.externalAddress) { db.markExternal(n.id, 'skipped'); continue; }
      try {
        await send({ to: s.externalAddress, title: n.title, body: n.body });
        db.markExternal(n.id, 'sent'); forwarded += 1;
      } catch { db.markExternal(n.id, 'failed'); failed += 1; }
    }
  }
  return { created, forwarded, failed };
}

// https webhook transport (an SMS / WhatsApp / e-mail gateway chosen by the platform owner).
function webhookSender(url, token) {
  return async (msg) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(msg), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`gateway ${res.status}`);
  };
}

module.exports = { DEFAULTS, validateSettings, dueFor, runDue, webhookSender, MAX_ATTEMPTS };
