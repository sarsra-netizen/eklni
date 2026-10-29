'use strict';
// Professional (dietitian) accounts — kept separate from the platform user subscription:
//  - the PLATFORM subscription unlocks the user's own tools (plans, tracking, files);
//  - the PRO status = verified credentials + an active PRO subscription, and it is what unlocks the
//    clinical view of athletes who consented to share health data.
// Neither one implies the other. Verification is a human decision by the platform owner (the app does
// not check any licensing register) and is recorded with who decided and when.
const { addDays, addMonths, diffDays } = require('./engine/dates');

const err = (code, status, message) => ({ error: code, status, message });
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function proStatus(db, userId, today) {
  const p = db.getProfessional(userId);
  const s = db.getProSub(userId);
  const subActive = !!s && s.status !== 'canceled' && s.endsOn >= today;
  const verified = !!p && p.status === 'verified';
  return {
    applied: !!p, verification: p ? p.status : 'none', licenseNo: p ? p.licenseNo : null, issuer: p ? p.issuer : null, decisionNote: p ? p.note : null,
    subscription: s ? { active: subActive, endsOn: s.endsOn, daysLeft: subActive ? diffDays(today, s.endsOn) + 1 : 0 } : { active: false, endsOn: null, daysLeft: 0 },
    clinicalAccess: verified && subActive,
  };
}

function apply(db, userId, body) {
  const licenseNo = clean(body.licenseNo, 40);
  const issuer = clean(body.issuer, 100);
  if (licenseNo.length < 3 || issuer.length < 3) return err('VALIDATION', 400, 'اكتب رقم القيد/الترخيص والجهة اللي أصدرته.');
  const cur = db.getProfessional(userId);
  if (cur && cur.status === 'verified') return err('ALREADY_VERIFIED', 400, 'الحساب موثّق بالفعل.');
  db.setProfessional(userId, { licenseNo, issuer, status: 'pending', decidedBy: null, note: null });
  return { ok: true };
}

function decide(db, ownerId, userId, decision, note) {
  if (!['verified', 'rejected', 'revoked'].includes(decision)) return err('VALIDATION', 400, 'قرار غير صحيح.');
  const p = db.getProfessional(userId);
  if (!p) return err('NOT_FOUND', 404, 'مفيش طلب توثيق.');
  if (decision === 'revoked' && p.status !== 'verified') return err('VALIDATION', 400, 'الإلغاء للحسابات الموثّقة بس.');
  db.setProfessional(userId, { ...p, status: decision, decidedBy: ownerId, note: clean(note, 200) || null });
  return { ok: true };
}

function extend(db, ownerId, userId, months, today) {
  if (!Number.isInteger(months) || months < 1 || months > 12) return err('VALIDATION', 400, 'عدد الشهور من 1 لـ 12.');
  const s = db.getProSub(userId);
  const continuing = s && s.status !== 'canceled' && s.endsOn >= today;
  const from = continuing ? addDays(s.endsOn, 1) : today;
  const endsOn = addDays(addMonths(from, months), -1);
  db.setProSub(userId, { status: 'active', startsOn: continuing ? s.startsOn : today, endsOn, by: ownerId });
  return { ok: true, endsOn };
}

module.exports = { proStatus, apply, decide, extend };
