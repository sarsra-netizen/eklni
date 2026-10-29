'use strict';
// Monthly subscription. A user can use the tools only while their subscription (or trial) covers today.
// Payment itself is NOT processed by the app: the platform owner records a payment received outside
// the app (e.g. bank transfer / wallet) and extends the subscription by whole calendar months.
// Enforcement happens in the server dispatcher (every tool route) — the UI lock screen is only a view.
const { addDays, addMonths, diffDays, parseDate } = require('./engine/dates');

function status(db, userId, today, { owner = false } = {}) {
  if (owner) return { active: true, state: 'owner', endsOn: null, daysLeft: null };
  const s = db.getSubscription(userId);
  if (!s) return { active: false, state: 'none', endsOn: null, daysLeft: null };
  const active = s.status !== 'canceled' && s.endsOn >= today;
  return { active, state: active ? s.status : 'expired', plan: s.plan, endsOn: s.endsOn, startedOn: s.startsOn,
    daysLeft: active ? diffDays(today, s.endsOn) + 1 : 0 };
}

function startTrial(db, userId, today, trialDays) {
  if (!(trialDays > 0)) return;
  db.setSubscription(userId, { plan: 'monthly', status: 'trial', startsOn: today, endsOn: addDays(today, trialDays - 1), by: null });
  db.subscriptionEvent(userId, 'trial', 0, addDays(today, trialDays - 1), null, `${trialDays} days`);
}

// Extend by `months` calendar months. If still active, continue from the current end; otherwise from today.
function extend(db, byUserId, userId, months, today, note) {
  if (!Number.isInteger(months) || months < 1 || months > 12) return { error: 'VALIDATION', status: 400, message: 'عدد الشهور من 1 لـ 12.' };
  const s = db.getSubscription(userId);
  const continuing = s && s.status !== 'canceled' && s.endsOn >= today;
  const from = continuing ? addDays(s.endsOn, 1) : today;
  const endsOn = addDays(addMonths(from, months), -1);
  db.setSubscription(userId, { plan: 'monthly', status: 'active', startsOn: continuing ? s.startsOn : today, endsOn, by: byUserId });
  db.subscriptionEvent(userId, 'extend', months, endsOn, byUserId, note);
  return { ok: true, endsOn };
}

function cancel(db, byUserId, userId, today, confirm) {
  if (confirm !== true) return { error: 'CONFIRM_REQUIRED', status: 400, message: 'الإلغاء بيقفل الأدوات فورًا؛ أكّد الأول.' };
  const s = db.getSubscription(userId);
  if (!s) return { error: 'NOT_FOUND', status: 404, message: 'مفيش اشتراك.' };
  db.setSubscription(userId, { ...s, status: 'canceled', endsOn: addDays(today, -1), by: byUserId });
  db.subscriptionEvent(userId, 'cancel', 0, addDays(today, -1), byUserId, null);
  return { ok: true };
}

const validDate = (d) => !!parseDate(d);
module.exports = { status, startTrial, extend, cancel, validDate };
