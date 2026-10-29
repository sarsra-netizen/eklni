'use strict';
// Academies, roles and the data-access policy. Everything here runs on the server (the demo runs the
// same file in the browser); the UI only displays what these functions return.
//
// Principles:
//  - Isolation: a user only sees an academy they belong to, and only athletes who are members of
//    that same academy. Every check is (actor, academy, target) — never trusting ids from the client.
//  - Least data: each role gets a fixed set of fields (ROLE_VIEWS). Health data (weights, targets,
//    screening, hydration logs) is visible to a dietitian ONLY after the athlete (or, for a minor,
//    a linked parent) turns sharing on. Coaches and admins never receive weights or screening answers.
//  - Minors (< 18 by the athlete's goal): only a linked parent can turn health sharing on.
//  - The audit log records who did what to whom — never the health data itself.
// These rules are design decisions for review by the academy and a qualified professional.

const service = require('./service');
const pro = require('./pro');

const ROLES = ['admin', 'coach', 'dietitian', 'athlete', 'parent'];
const ROLE_AR = { admin: 'مدير الأكاديمية', coach: 'مدرب', dietitian: 'أخصائي تغذية', athlete: 'لاعب', parent: 'ولي أمر' };
const STAFF = ['admin', 'coach', 'dietitian'];
const CAN_INVITE = { admin: ROLES, coach: ['athlete', 'parent'], dietitian: [], athlete: [], parent: [] };
const INVITE_DAYS = 7;

const err = (code, status, message) => ({ error: code, status, message });
const NOT_FOUND = () => err('NOT_FOUND', 404, 'غير موجود.');

function cleanName(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60);
  return s || null;
}

// ---------- academies & membership ----------
function createAcademy(db, userId, body) {
  const name = cleanName(body.name);
  if (!name || name.length < 2) return err('VALIDATION', 400, 'اكتب اسم الأكاديمية.');
  const id = db.createAcademy(name, userId, cleanName(body.displayName));
  db.audit(id, userId, 'academy_create', null);
  return { academy: db.academy(id), memberships: db.membershipsOf(userId) };
}

function myAcademies(db, userId) {
  const list = db.membershipsOf(userId);
  const byId = new Map();
  for (const m of list) {
    const a = byId.get(m.academyId) || { id: m.academyId, name: m.name, roles: [], displayName: m.displayName };
    a.roles.push(m.role);
    byId.set(m.academyId, a);
  }
  const out = [...byId.values()].map((a) => {
    const extra = {};
    if (a.roles.includes('athlete')) {
      extra.sharing = db.getSharing(a.id, userId);
      extra.sharingControl = sharingControl(db, a.id, userId);
      extra.guardians = db.guardiansOf(a.id, userId).length;
      extra.minorConsent = minorConsentState(db, userId);
    }
    extra.kind = (db.academy(a.id) || {}).kind || 'academy';
    if (a.roles.includes('parent')) extra.children = db.childrenOf(a.id, userId).map((id) => childCard(db, a.id, id));
    return { ...a, rolesAr: a.roles.map((r) => ROLE_AR[r]), canInvite: [...new Set(a.roles.flatMap((r) => CAN_INVITE[r]))], isStaff: a.roles.some((r) => STAFF.includes(r)), ...extra };
  });
  return { academies: out, roles: ROLE_AR };
}

function requireMember(db, userId, academyId) {
  const roles = db.rolesIn(userId, academyId);
  if (!roles.length || !db.academy(academyId)) return { fail: NOT_FOUND() }; // don't reveal other academies exist
  return { roles };
}

function createInvite(db, userId, academyId, body, deps) {
  const { roles, fail } = requireMember(db, userId, academyId);
  if (fail) return fail;
  const role = body.role;
  if (!ROLES.includes(role)) return err('VALIDATION', 400, 'دور غير صحيح.');
  if (!roles.some((r) => CAN_INVITE[r].includes(role))) return err('FORBIDDEN', 403, 'دورك مش مسموحله يدعو بالدور ده.');
  let athleteId = null;
  if (role === 'parent') {
    athleteId = Number(body.athleteId);
    if (!Number.isInteger(athleteId) || !db.rolesIn(athleteId, academyId).includes('athlete')) return err('VALIDATION', 400, 'دعوة ولي الأمر لازم تكون مربوطة بلاعب في نفس الأكاديمية.');
  }
  const code = deps.randomCode();
  db.createInvite(deps.hash(code), academyId, role, userId, deps.nowMs() + INVITE_DAYS * 86400000, athleteId);
  db.audit(academyId, userId, `invite_create:${role}`, athleteId);
  return { code, role, roleAr: ROLE_AR[role], expiresInDays: INVITE_DAYS, note: 'الكود بيظهر مرة واحدة بس، وبيشتغل مرة واحدة خلال 7 أيام.' };
}

function acceptInvite(db, userId, body, deps) {
  const code = String(body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,20}$/.test(code)) return err('VALIDATION', 400, 'الكود غير صحيح.');
  const inv = db.inviteByHash(deps.hash(code));
  if (!inv || inv.used_by != null || inv.expires_at < deps.nowMs()) return err('INVALID_INVITE', 400, 'الكود غير صحيح أو مستخدم أو منتهي.');
  if (inv.role === 'parent' && inv.athlete_id === userId) return err('VALIDATION', 400, 'اللاعب ما ينفعش يبقى ولي أمر نفسه.');
  if (!db.useInvite(deps.hash(code), userId)) return err('INVALID_INVITE', 400, 'الكود اتستخدم.');
  db.addMembership(inv.academy_id, userId, inv.role, cleanName(body.displayName));
  if (inv.role === 'parent') db.linkGuardian(inv.academy_id, userId, inv.athlete_id);
  db.audit(inv.academy_id, userId, `member_join:${inv.role}`, inv.role === 'parent' ? inv.athlete_id : null);
  return myAcademies(db, userId);
}

function listMembers(db, userId, academyId) {
  const { roles, fail } = requireMember(db, userId, academyId);
  if (fail) return fail;
  if (!roles.some((r) => STAFF.includes(r))) return err('FORBIDDEN', 403, 'قائمة الأعضاء للإدارة والمدربين والأخصائيين بس.');
  const showEmail = roles.includes('admin');
  const byUser = new Map();
  for (const m of db.members(academyId)) {
    const u = byUser.get(m.userId) || { userId: m.userId, roles: [], displayName: null, email: showEmail ? m.email : null, since: m.createdAt.slice(0, 10) };
    u.roles.push(m.role);
    u.displayName = u.displayName || m.displayName;
    byUser.set(m.userId, u);
  }
  return { members: [...byUser.values()].map((u) => ({ ...u, displayName: u.displayName || 'بدون اسم', rolesAr: u.roles.map((r) => ROLE_AR[r]) })) };
}

function removeMember(db, userId, academyId, targetId, body) {
  const { roles, fail } = requireMember(db, userId, academyId);
  if (fail) return fail;
  const self = targetId === userId;
  if (!self && !roles.includes('admin')) return err('FORBIDDEN', 403, 'المدير بس يقدر يشيل أعضاء.');
  if (body.confirm !== true) return err('CONFIRM_REQUIRED', 400, 'الإزالة بتلغي المشاركة وروابط ولي الأمر؛ أكّد الأول.');
  const targetRoles = db.rolesIn(targetId, academyId);
  if (!targetRoles.length) return NOT_FOUND();
  if (targetRoles.includes('admin') && db.countRole(academyId, 'admin') <= 1) return err('LAST_ADMIN', 400, 'لازم يفضل مدير واحد على الأقل.');
  db.removeMembership(academyId, targetId);
  db.audit(academyId, userId, self ? 'member_leave' : 'member_remove', targetId);
  return self ? myAcademies(db, userId) : listMembers(db, userId, academyId);
}

// ---------- guardians for athletes without an academy, and weight-loss consent for minors ----------
// The athlete gets a private "family" group (kind = 'family') and a one-time parent invite code.
function inviteGuardian(db, userId, body, deps) {
  let aid = db.familyOf(userId);
  if (!aid) {
    aid = db.createAcademy(`عائلة ${cleanName(body.displayName) || 'اللاعب'}`, userId, cleanName(body.displayName));
    db.setAcademyKind(aid, 'family');
    db.addMembership(aid, userId, 'athlete', cleanName(body.displayName));
    db.audit(aid, userId, 'family_create', null);
  }
  return { academyId: aid, ...createInvite(db, userId, aid, { role: 'parent', athleteId: userId }, deps) };
}

function setMinorConsent(db, userId, academyId, body) {
  const { roles, fail } = requireMember(db, userId, academyId);
  if (fail) return fail;
  const athleteId = Number(body.athleteId);
  if (!roles.includes('parent') || !Number.isInteger(athleteId) || !db.isGuardian(academyId, userId, athleteId)) {
    return err('FORBIDDEN', 403, 'ولي الأمر المربوط باللاعب بس هو اللي يوافق.');
  }
  const age = athleteAge(db, athleteId);
  if (age != null && age >= 18) return err('VALIDATION', 400, 'اللاعب فوق 18 سنة ومش محتاج موافقة ولي أمر.');
  if (body.allowWeightLoss === true) {
    if (body.understood !== true) return err('CONFIRM_REQUIRED', 400, 'لازم تأكد إنك قريت التنبيه قبل الموافقة.');
    db.setMinorConsent(athleteId, userId, academyId);
  } else db.clearMinorConsent(athleteId);
  db.audit(academyId, userId, body.allowWeightLoss === true ? 'minor_consent_on' : 'minor_consent_off', athleteId);
  return myAcademies(db, userId);
}

function minorConsentState(db, athleteId) {
  const c = db.getMinorConsent(athleteId);
  const active = !!c && db.isGuardian(c.academyId, c.guardianId, athleteId);
  return { active, grantedAt: active ? c.grantedAt : null };
}

// ---------- consent to share health data ----------
function athleteAge(db, athleteId) {
  const g = db.activeGoal(athleteId);
  return g ? g.input.age : null;
}
function sharingControl(db, academyId, athleteId) {
  const age = athleteAge(db, athleteId);
  if (age == null) return { by: 'nobody', reason: 'كمّل هدفك الأول (العمر مطلوب لتحديد مين يوافق).' };
  if (age < 18) return { by: 'guardian', reason: 'اللاعب أقل من 18 سنة: ولي الأمر المربوط هو اللي يوافق على المشاركة.' };
  return { by: 'athlete', reason: null };
}
function setSharing(db, userId, academyId, body) {
  const { roles, fail } = requireMember(db, userId, academyId);
  if (fail) return fail;
  const athleteId = body.athleteId == null ? userId : Number(body.athleteId);
  if (!db.rolesIn(athleteId, academyId).includes('athlete')) return NOT_FOUND();
  const ctl = sharingControl(db, academyId, athleteId);
  const allowed = (ctl.by === 'athlete' && athleteId === userId && roles.includes('athlete'))
    || (ctl.by === 'guardian' && roles.includes('parent') && db.isGuardian(academyId, userId, athleteId));
  if (!allowed) return err('FORBIDDEN', 403, ctl.reason || 'مش مسموح.');
  db.setSharing(academyId, athleteId, body.shareHealth === true, userId);
  db.audit(academyId, userId, body.shareHealth === true ? 'sharing_on' : 'sharing_off', athleteId);
  return myAcademies(db, userId);
}

// ---------- what each role may see about an athlete ----------
function childCard(db, academyId, athleteId) {
  const m = db.members(academyId).find((x) => x.userId === athleteId && x.role === 'athlete');
  const age = athleteAge(db, athleteId);
  return { userId: athleteId, displayName: (m && m.displayName) || 'لاعب', age, sharing: db.getSharing(academyId, athleteId), sharingControl: sharingControl(db, academyId, athleteId),
    minorConsent: age == null || age < 18 ? minorConsentState(db, athleteId) : null };
}

function viewLevel(db, viewerId, viewerRoles, academyId, athleteId, today) {
  if (viewerId === athleteId) return 'self';
  const share = db.getSharing(academyId, athleteId).shareHealth;
  // clinical = the athlete consented AND the dietitian is verified with an active professional subscription
  if (viewerRoles.includes('dietitian')) return share && pro.proStatus(db, viewerId, today).clinicalAccess ? 'clinical' : 'coach';
  if (viewerRoles.includes('parent') && db.isGuardian(academyId, viewerId, athleteId)) return 'guardian';
  if (viewerRoles.includes('coach')) return 'coach';
  if (viewerRoles.includes('admin')) return 'admin';
  return null;
}

function basic(goal) {
  if (!goal) return { hasGoal: false };
  const i = goal.input;
  return { hasGoal: true, sport: i.sport, swimDiscipline: i.swimDiscipline || i.discipline || null, seasonPhase: i.seasonPhase || null,
    sessionsPerWeek: i.sessionsPerWeek, minutesPerSession: i.minutesPerSession, competitionDate: i.competitionDate || null };
}

function athleteView(db, viewerId, academyId, athleteId, today) {
  const { roles, fail } = requireMember(db, viewerId, academyId);
  if (fail) return fail;
  if (!db.rolesIn(athleteId, academyId).includes('athlete')) return NOT_FOUND();
  const level = viewLevel(db, viewerId, roles, academyId, athleteId, today);
  if (!level) return NOT_FOUND();
  const member = db.members(academyId).find((x) => x.userId === athleteId && x.role === 'athlete');
  const goal = db.activeGoal(athleteId);
  const out = { userId: athleteId, displayName: (member && member.displayName) || 'لاعب', level, levelAr: LEVEL_AR[level], ...basic(goal) };
  if (level === 'admin') return out;

  if (goal) {
    const hold = service.holdFor(db, athleteId, goal);
    const checkins = db.checkins(athleteId, goal.id).slice(-4);
    // wellness & training only — no body composition, waist or calories for coaches
    out.wellness = checkins.map((c) => ({ week: c.week + 1, performance: c.performance ?? null, energy: c.energy ?? null, sleep: c.sleep ?? null,
      recovery: c.recovery ?? null, adherencePct: c.adherencePct ?? null }));
    out.needsReview = hold.hold; // a yes/no; reasons are not shown to coaches
  }
  const hyd = service.getHydration(db, athleteId).summary;
  out.hydration = hyd ? { avgSweatRateLph: hyd.avgSweatRateLph, sessions: hyd.sessions } : null;
  if (level === 'coach') {
    const shared = db.getSharing(academyId, athleteId).shareHealth;
    out.healthHidden = roles.includes('dietitian')
      ? (shared ? 'اللاعب موافق على المشاركة، بس عرض البيانات الصحية محتاج حساب أخصائي موثّق باشتراك أخصائي ساري.' : 'البيانات الصحية مش متشاركة: محتاجة موافقة اللاعب (أو ولي الأمر لو أقل من 18 سنة).')
      : 'عرض المدرب مش بيشمل الوزن ولا السعرات ولا الفحص الصحي. لو فيه «يحتاج مراجعة» يبقى الأخصائي هو اللي يتابع.';
    return out;
  }

  const st = goal ? service.buildState(db, athleteId, today, { readOnly: true }) : null;
  if (goal) {
    out.targets = st.targets;
    out.holdFlags = st.hold.flags.filter((f) => f.level !== 'info').map((f) => ({ level: f.level, text: f.text }));
    out.referral = st.hold.referral;
    out.energyAvailability = { value: st.plan.nutrition.energyAvailability, status: st.plan.nutrition.energyAvailabilityStatus };
  }
  if (level === 'guardian') return out;

  // clinical (dietitian with consent) or self
  if (goal) {
    out.goal = { startWeight: st.goal.startWeight, targetWeight: st.goal.targetWeight, weeklyRateKg: st.goal.weeklyRateKg, input: st.goal.input };
    out.weeks = st.rows.map((r) => ({ week: r.week + 1, avgWeight: r.avgWeight, waistCm: r.waistCm ?? null, bodyFatPct: r.bodyFatPct ?? null }));
    out.projection = st.timeline.projection.completionDate;
    out.adjustments = st.adjustments.map((a) => ({ at: a.createdAt.slice(0, 10), kcalChange: a.kcalChange, status: a.status, reasons: a.reasons }));
    out.planReview = st.planReview;
    out.calcVersion = st.calcVersion;
    out.canReview = level === 'clinical';
    out.requiresProfessional = !!st.plan.requiresProfessional;
  }
  out.screening = db.getScreening(athleteId);
  out.hydrationLogs = service.getHydration(db, athleteId).logs.slice(-10);
  return out;
}
const LEVEL_AR = { self: 'بياناتي', clinical: 'عرض أخصائي (بموافقة)', guardian: 'عرض ولي الأمر', coach: 'عرض المدرب (بدون بيانات صحية)', admin: 'عرض الإدارة (أساسي)' };

function roster(db, viewerId, academyId, today) {
  const { roles, fail } = requireMember(db, viewerId, academyId);
  if (fail) return fail;
  let ids;
  if (roles.some((r) => STAFF.includes(r))) ids = db.members(academyId).filter((m) => m.role === 'athlete').map((m) => m.userId);
  else if (roles.includes('parent')) ids = db.childrenOf(academyId, viewerId);
  else return err('FORBIDDEN', 403, 'مش مسموح.');
  const athletes = ids.map((id) => {
    const v = athleteView(db, viewerId, academyId, id, today);
    const last = v.wellness && v.wellness[v.wellness.length - 1];
    return { userId: id, displayName: v.displayName, level: v.level, sport: v.sport, swimDiscipline: v.swimDiscipline, hasGoal: v.hasGoal,
      needsReview: v.needsReview ?? null, lastWellness: last || null, avgSweatRateLph: v.hydration ? v.hydration.avgSweatRateLph : null,
      healthShared: db.getSharing(academyId, id).shareHealth };
  });
  db.audit(academyId, viewerId, 'view_roster', null);
  return { academy: db.academy(academyId), roles, athletes };
}

function viewAthlete(db, viewerId, academyId, athleteId, today) {
  const v = athleteView(db, viewerId, academyId, athleteId, today);
  if (!v.error) db.audit(academyId, viewerId, `view_athlete:${v.level}`, athleteId);
  return v;
}

function auditLog(db, userId, academyId) {
  const { roles, fail } = requireMember(db, userId, academyId);
  if (fail) return fail;
  if (!roles.includes('admin')) return err('FORBIDDEN', 403, 'سجل التدقيق للمدير بس.');
  const names = new Map(db.members(academyId).map((m) => [m.userId, m.displayName || `#${m.userId}`]));
  return { log: db.auditLog(academyId).map((e) => ({ ...e, actor: names.get(e.actorId) || `#${e.actorId}`, target: e.targetId != null ? names.get(e.targetId) || `#${e.targetId}` : null })) };
}

// ---------- report branding (signature on every page + faint logo watermark) ----------
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const LOGO_MAX = 400 * 1024;
function getBranding(db, userId, academyId) {
  const { fail } = requireMember(db, userId, academyId);
  if (fail) return fail;
  return { branding: db.getBranding(academyId) || { signature: null, logo: null } };
}
function setBranding(db, userId, academyId, body) {
  const { roles, fail } = requireMember(db, userId, academyId);
  if (fail) return fail;
  if (!roles.includes('admin')) return err('FORBIDDEN', 403, 'المدير بس يقدر يغيّر الشعار والتوقيع.');
  const signature = cleanName(body.signature);
  let logo = body.logo == null || body.logo === '' ? null : String(body.logo);
  if (logo && (!LOGO_RE.test(logo) || logo.length > LOGO_MAX)) return err('VALIDATION', 400, 'الشعار لازم يكون صورة PNG أو JPG أو WEBP أصغر من 300 كيلوبايت.');
  if (body.keepLogo === true) logo = (db.getBranding(academyId) || {}).logo || null;
  db.setBranding(academyId, { signature, logo });
  db.audit(academyId, userId, 'branding_set', null);
  return getBranding(db, userId, academyId);
}
// The branding used on a user's own files: the first of their academies that has one.
function brandingFor(db, userId) {
  for (const m of db.membershipsOf(userId)) { const b = db.getBranding(m.academyId); if (b && (b.signature || b.logo)) return b; }
  return null;
}

// ---- plan review by a verified dietitian (audit 2026-10-22, F2) ----
// Allowed only at the 'clinical' view level: dietitian role + athlete's (or guardian's) consent to share health
// data + verified credentials + active professional subscription. Enforced here on the server.
const REVIEW_DECISIONS = ['approved', 'revision_requested', 'rejected', 'referred'];
function reviewPlan(db, reviewerId, academyId, athleteId, body = {}, today) {
  const { roles, fail } = requireMember(db, reviewerId, academyId);
  if (fail) return fail;
  if (!db.rolesIn(athleteId, academyId).includes('athlete')) return NOT_FOUND();
  if (reviewerId === athleteId) return err('FORBIDDEN', 403, 'مينفعش تراجع خطتك بنفسك.');
  if (viewLevel(db, reviewerId, roles, academyId, athleteId, today) !== 'clinical') {
    return err('FORBIDDEN', 403, 'مراجعة الخطة للأخصائي الموثّق باشتراك أخصائي ساري، وبعد موافقة اللاعب على مشاركة البيانات الصحية.');
  }
  const decision = body.decision;
  if (!REVIEW_DECISIONS.includes(decision)) return err('VALIDATION', 400, 'القرار: موافقة، أو طلب تعديل، أو رفض، أو إحالة.');
  const note = String(body.note ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 500);
  if (decision !== 'approved' && note.length < 5) return err('VALIDATION', 400, 'اكتب سبب القرار (5 حروف على الأقل).');
  const goal = db.activeGoal(athleteId);
  if (!goal) return err('NO_GOAL', 400, 'اللاعب ملوش خطة.');
  const targets = service.currentTargets(db, athleteId, goal, undefined, today);
  db.addPlanReview({ athleteId, goalId: goal.id, reviewerId, academyId, decision, note: note || null, fingerprint: service.planFingerprint(goal, targets), calcVersion: goal.plan.calcVersion || null });
  db.audit(academyId, reviewerId, `plan_review:${decision}`, athleteId);
  return { ok: true, planReview: service.planReviewState(db, athleteId, goal, targets, goal.plan) };
}

module.exports = { reviewPlan, REVIEW_DECISIONS, inviteGuardian, setMinorConsent, minorConsentState, getBranding, setBranding, brandingFor, ROLES, ROLE_AR, CAN_INVITE, createAcademy, myAcademies, createInvite, acceptInvite, listMembers, removeMember, setSharing, roster, viewAthlete, auditLog };
