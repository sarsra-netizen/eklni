'use strict';
// Personal data export, account deletion and retention (see PRIVACY.md).
// - Export: everything stored about the user, as JSON. Available even when the subscription has expired.
// - Deletion: immediate and irreversible; requires the password and an explicit confirmation word.
// - Retention: backups keep deleted data until they rotate out; the audit log keeps numeric ids only
//   (no names, no health data) for AUDIT_RETENTION_DAYS; expired sessions/invites are purged.

const AUDIT_RETENTION_DAYS = 365;
const CONFIRM_WORD = 'DELETE';

function exportData(db, userId, extra = {}) {
  const user = db.userById(userId);
  const goals = db.allGoals(userId).map((g) => ({ ...g, weights: db.weights(userId, g.id), checkins: db.checkins(userId, g.id), adjustments: db.adjustments(userId, g.id) }));
  return {
    format: 'eklni-export-v1',
    exportedAt: new Date().toISOString(),
    account: { id: user.id, email: user.email, createdAt: user.created_at },
    subscription: db.getSubscription(userId), subscriptionEvents: db.subscriptionEvents(userId),
    goals,
    preferences: db.getPrefs(userId), notificationSettings: db.getNotifications(userId),
    weekPlans: db.allWeekPlans(userId),
    competition: db.getCompetition(userId),
    inbox: db.inbox(userId),
    shareLinks: db.shares(userId),
    household: db.householdOf(userId),
    selfWaiver: db.getSelfWaiver(userId),
    screening: db.getScreening(userId),
    hydration: db.hydrationLogs(userId),
    // added by the 2026-10-22 audit: everything the person logged or that was decided about his plan
    mealLogs: db.mealLogs ? db.mealLogs(userId, '0000-01-01', '9999-12-31') : [],
    planReviews: db.planReviews ? db.allGoals(userId).flatMap((g) => db.planReviews(userId, g.id).map((r) => ({ goalId: g.id, decision: r.decision, note: r.note, at: r.at, calcVersion: r.calcVersion }))) : [],
    calorieOverride: db.getCalorieOverride ? db.getCalorieOverride(userId) : null,
    academies: db.membershipsOf(userId), healthSharing: db.sharingAsAthlete(userId), guardianLinks: db.guardianLinks(userId),
    ...extra,
    notes: 'لا يشمل كلمة المرور (مخزنة مُجزأة) ولا رموز الجلسات.',
  };
}

// Returns { ok } or { error, status, message }.
// verifyPassword is injected (src/auth.js) so this module has no Node built-ins and also runs in the demo.
function deleteAccount(db, userId, body, { verifyPassword, onDeleted } = {}) {
  const u = db.userByEmail(db.userById(userId).email);
  if (!body || body.confirm !== CONFIRM_WORD) return { error: 'CONFIRM_REQUIRED', status: 400, message: `اكتب ${CONFIRM_WORD} للتأكيد. الحذف نهائي ومش بيترجع.` };
  if (!String(u.pass_hash).startsWith('scrypt$')) return { error: 'NEEDS_PASSWORD', status: 409, message: 'حسابك متسجل بجوجل؛ اعمل كلمة مرور الأول من «حسابي» وبعدين امسح الحساب.' };
  if (typeof body.password !== 'string' || body.password.length > 200 || !verifyPassword(body.password, u.pass_hash)) {
    return { error: 'BAD_PASSWORD', status: 403, message: 'كلمة المرور غير صحيحة.' };
  }
  // An academy must never be left without an admin while it still has other members.
  const blocked = [];
  for (const aid of db.adminAcademies(userId)) {
    const members = db.academyMemberCount(aid);
    if (members > 1 && !db.otherAdmin(aid, userId)) blocked.push(db.academy(aid).name);
  }
  if (blocked.length) return { error: 'ACADEMY_NEEDS_ADMIN', status: 409, message: `انت المدير الوحيد في: ${blocked.join('، ')}. عيّن مدير تاني أو شيل الأعضاء الأول.` };
  db.transaction(() => {
    for (const aid of db.academiesCreatedBy(userId)) {
      if (db.academyMemberCount(aid) <= 1) db.deleteAcademy(aid);
      else db.reassignAcademyCreator(aid, db.otherAdmin(aid, userId));
    }
    // academies where the user is the only member but not the creator
    for (const aid of db.adminAcademies(userId)) if (db.academyMemberCount(aid) <= 1) db.deleteAcademy(aid);
    db.deleteInvitesBy(userId);
    if (db.householdOf && db.householdOf(userId)) require('./household').leave(db, userId); // hand the house over or delete it if empty
    db.deleteUser(userId); // cascades to every table that holds the user's data
  });
  if (onDeleted) onDeleted(userId);
  return { ok: true };
}

function maintenance(db, nowMs = Date.now()) {
  return {
    sessions: db.purgeSessions(nowMs),
    audit: db.purgeAudit(new Date(nowMs - AUDIT_RETENTION_DAYS * 86400000).toISOString()),
    invites: db.purgeInvites(nowMs - 30 * 86400000),
    notifications: db.purgeNotifications(new Date(nowMs - 90 * 86400000).toISOString()),
    throttle: db.purgeThrottle(nowMs - 2 * 86400000),
    authTokens: db.purgeAuthTokens(nowMs - 86400000),
    shares: db.purgeShares(nowMs - 7 * 86400000),
    householdInvites: db.purgeHouseholdInvites(nowMs - 30 * 86400000),
  };
}

module.exports = { exportData, deleteAccount, maintenance, AUDIT_RETENTION_DAYS, CONFIRM_WORD };
