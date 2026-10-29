'use strict';
// In-browser stand-in for src/server.js + src/db.js. Same engines, same service layer,
// same routes; data lives in this browser only (localStorage, with an in-memory fallback).
const { validateGoalInput, validateWeightEntry, validateCheckin } = require('../src/engine/validate');
const { createPlan } = require('../src/engine/planner');
const { recommendRate } = require('../src/engine/rate');
const { SPORTS } = require('../src/engine/energy');
const { SCENARIOS } = require('../src/engine/timeline');
const { foodsMeta, listRecipes } = require('../src/engine/meals');
const { addDays, addMonths } = require('../src/engine/dates');
const { wutCheck } = require('../src/engine/hydration');
const REFS = require('../src/data/references.json');
const { foodQuality } = require('../src/engine/meals');
const academy = require('../src/academy');
const subscription = require('../src/subscription');
const account = require('../src/account');
const notify = require('../src/notify');
const pro = require('../src/pro');
const service = require('../src/service');
const { renderReport, renderCsv } = require('../src/report');

const KEY = 'eklni-demo-v3';
const MOBILE = typeof window !== 'undefined' && !!window.__EKLNI_MOBILE__;
const NATIVE = () => (typeof window !== 'undefined' && window.EklniAndroid && typeof window.EklniAndroid.saveFile === 'function' ? window.EklniAndroid : null);
const USER = { id: 1, email: 'تجربة على هذا الجهاز', created_at: new Date().toISOString() };

function today() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
const now = () => new Date().toISOString();

// ---------- store (same interface as src/db.js; several in-browser "users" for the team demo) ----------
const userStore = () => ({ goals: [], weights: [], checkins: [], adjustments: [], notif: null, prefs: null, weekplans: [], competition: null, screening: null, hydration: [] });
const empty = () => ({ seq: 100, users: { 1: userStore() }, people: { 1: { email: MOBILE ? 'أنت' : 'أنت (تجربة)' } }, academies: [], memberships: [], invites: [], guardians: [], sharing: [], audit: [], example: false });
let S = load();
function load() {
  try { const raw = localStorage.getItem(KEY); if (raw) { const d = JSON.parse(raw); if (d.users) return { ...empty(), ...d }; } } catch { /* storage unavailable */ }
  return null;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* keep in memory only */ } }
const nextId = () => S.seq++;
const st = (u) => { const k = Number(u) || 1; S.users[k] = S.users[k] || userStore(); return S.users[k]; };
const clone = (x) => JSON.parse(JSON.stringify(x));

const db = {
  userById: (u) => (Number(u) === 1 || !u ? USER : { id: u, email: (S.people[u] || {}).email }),
  saveGoal(u, input, plan) {
    const U = st(u);
    U.goals.forEach((g) => { g.active = 0; });
    const id = nextId();
    U.goals.push({ id, created_at: now(), active: 1, input, plan, start_date: input.startDate, start_weight: input.currentWeight,
      target_weight: input.targetWeight, weekly_rate_kg: plan.effectiveRateKg, calorie_adjustment: 0, last_projection: plan.timeline.completionDate });
    save(); return id;
  },
  activeGoal(u) {
    const g = [...st(u).goals].reverse().find((x) => x.active);
    if (!g) return null;
    return { id: g.id, createdAt: g.created_at, input: g.input, plan: g.plan, startDate: g.start_date, startWeight: g.start_weight,
      targetWeight: g.target_weight, weeklyRateKg: g.weekly_rate_kg, calorieAdjustment: g.calorie_adjustment, lastProjection: g.last_projection };
  },
  updateGoalPlan(u, goalId, input, plan) { const g = st(u).goals.find((x) => x.id === goalId); if (g) { g.input = input; g.plan = plan; save(); } },
  setProjection(u, goalId, date) { const g = st(u).goals.find((x) => x.id === goalId); if (g) { g.last_projection = date; save(); } },
  setCalorieAdjustment(u, goalId, kcal) { const g = st(u).goals.find((x) => x.id === goalId); if (g) { g.calorie_adjustment = kcal; save(); } },
  upsertWeight(u, goalId, date, kg) {
    const U = st(u); const w = U.weights.find((x) => x.goalId === goalId && x.date === date);
    if (w) w.weightKg = kg; else U.weights.push({ goalId, date, weightKg: kg });
    save();
  },
  deleteWeight(u, goalId, date) { const U = st(u); U.weights = U.weights.filter((x) => !(x.goalId === goalId && x.date === date)); save(); },
  weights: (u, goalId) => st(u).weights.filter((x) => x.goalId === goalId).sort((a, b) => (a.date < b.date ? -1 : 1)).map(({ date, weightKg }) => ({ date, weightKg })),
  upsertCheckin(u, goalId, week, data) {
    const U = st(u); const c = U.checkins.find((x) => x.goalId === goalId && x.week === week);
    if (c) c.data = data; else U.checkins.push({ goalId, week, data });
    save();
  },
  checkins: (u, goalId) => st(u).checkins.filter((x) => x.goalId === goalId).sort((a, b) => a.week - b.week).map((c) => ({ ...c.data, week: c.week })),
  addAdjustment(u, goalId, a) {
    const id = nextId();
    st(u).adjustments.push({ id, goal_id: goalId, created_at: now(), kind: a.kind, action: a.action, kcal_change: a.kcalChange || 0,
      reasons: a.reasons || [], status: a.status || 'pending', decided_at: a.status && a.status !== 'pending' ? now() : null, decision_note: null });
    save(); return id;
  },
  adjustment: (u, id) => st(u).adjustments.find((a) => a.id === id) || null,
  decideAdjustment(u, id, status, note) {
    const a = st(u).adjustments.find((x) => x.id === id && x.status === 'pending');
    if (!a) return 0;
    a.status = status; a.decided_at = now(); a.decision_note = note || null; save(); return 1;
  },
  expirePending(u, goalId) { st(u).adjustments.forEach((a) => { if (a.goal_id === goalId && a.status === 'pending') { a.status = 'superseded'; a.decided_at = now(); } }); save(); },
  adjustments: (u, goalId) => st(u).adjustments.filter((a) => a.goal_id === goalId).map((a) => ({ id: a.id, createdAt: a.created_at, kind: a.kind, action: a.action,
    kcalChange: a.kcal_change, reasons: a.reasons, status: a.status, decidedAt: a.decided_at, decisionNote: a.decision_note })),
  getPrefs: (u) => st(u).prefs,
  setPrefs(u, data) { st(u).prefs = data; save(); },
  saveWeekPlan(u, goalId, plan, reason = 'generated') {
    const U = st(u); const id = nextId();
    U.weekplans = [...U.weekplans, { id, goalId, plan: clone(plan), reason, createdAt: now() }];
    const mine = U.weekplans.filter((w) => w.goalId === goalId);
    if (mine.length > 30) { const drop = new Set(mine.slice(0, mine.length - 30).map((w) => w.id)); U.weekplans = U.weekplans.filter((w) => !drop.has(w.id)); }
    save(); return id;
  },
  weekPlan: (u, goalId) => { const w = [...st(u).weekplans].reverse().find((x) => x.goalId === goalId); return w ? { ...clone(w.plan), versionId: w.id } : null; },
  weekPlanVersion: (u, goalId, id) => { const w = st(u).weekplans.find((x) => x.goalId === goalId && x.id === id); return w ? clone(w.plan) : null; },
  weekPlanHistory: (u, goalId) => [...st(u).weekplans].filter((x) => x.goalId === goalId).reverse().map((w) => ({ id: w.id, createdAt: w.createdAt || now(), reason: w.reason || 'generated',
    startDate: w.plan.startDate, avgKcal: w.plan.weekTotals ? Math.round(w.plan.weekTotals.kcal / 7) : null })),
  getCompetition: (u) => (st(u).competition ? clone(st(u).competition) : null),
  setCompetition(u, data) { st(u).competition = data; save(); },
  deleteCompetition(u) { st(u).competition = null; save(); },
  getNotifications: (u) => st(u).notif,
  setNotifications(u, data) { st(u).notif = data; save(); },
  getScreening: (u) => (st(u).screening ? { ...st(u).screening } : null),
  setScreening(u, data) { const U = st(u); U.screening = { ...data, consentAt: (U.screening && U.screening.consentAt) || now(), updatedAt: now() }; save(); },
  addHydration(u, h0) { const id = nextId(); st(u).hydration.push({ ...h0, id }); save(); return id; },
  hydrationLogs: (u) => [...st(u).hydration].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)),
  deleteHydration(u, id) { const U = st(u); const n = U.hydration.length; U.hydration = U.hydration.filter((x) => x.id !== id); save(); return n - U.hydration.length; },

  // academies (mirror of the SQL methods)
  createAcademy(name, u, displayName) { const id = nextId(); S.academies.push({ id, name, createdAt: now(), createdBy: u, kind: 'academy' }); db.addMembership(id, u, 'admin', displayName); return id; },
  academy: (id) => S.academies.find((a) => a.id === id) || null,
  membershipsOf: (u) => S.memberships.filter((m) => m.userId === u).map((m) => ({ academyId: m.academyId, name: db.academy(m.academyId).name, role: m.role, displayName: m.displayName })),
  rolesIn: (u, aid) => S.memberships.filter((m) => m.userId === u && m.academyId === aid).map((m) => m.role),
  addMembership(aid, u, role, displayName) {
    const m = S.memberships.find((x) => x.academyId === aid && x.userId === u && x.role === role);
    if (m) { if (displayName) m.displayName = displayName; } else S.memberships.push({ academyId: aid, userId: u, role, displayName: displayName || null, createdAt: now() });
    save();
  },
  removeMembership(aid, u) {
    S.memberships = S.memberships.filter((m) => !(m.academyId === aid && m.userId === u));
    S.guardians = S.guardians.filter((g) => !(g.academyId === aid && (g.parentId === u || g.athleteId === u)));
    S.sharing = S.sharing.filter((x) => !(x.academyId === aid && x.athleteId === u));
    save();
  },
  members: (aid) => S.memberships.filter((m) => m.academyId === aid).map((m) => ({ userId: m.userId, email: (db.userById(m.userId) || {}).email, role: m.role, displayName: m.displayName, createdAt: m.createdAt })),
  countRole: (aid, role) => S.memberships.filter((m) => m.academyId === aid && m.role === role).length,
  createInvite(hash, aid, role, by, exp, athleteId) { S.invites.push({ code_hash: hash, academy_id: aid, role, athlete_id: athleteId || null, created_by: by, expires_at: exp, used_by: null }); save(); },
  inviteByHash: (hash) => { const i = S.invites.find((x) => x.code_hash === hash); return i ? { ...i } : null; },
  useInvite(hash, u) { const i = S.invites.find((x) => x.code_hash === hash && x.used_by == null); if (!i) return 0; i.used_by = u; save(); return 1; },
  linkGuardian(aid, p, a) { if (!db.isGuardian(aid, p, a)) S.guardians.push({ academyId: aid, parentId: p, athleteId: a }); save(); },
  isGuardian: (aid, p, a) => S.guardians.some((g) => g.academyId === aid && g.parentId === p && g.athleteId === a),
  childrenOf: (aid, p) => S.guardians.filter((g) => g.academyId === aid && g.parentId === p).map((g) => g.athleteId),
  setAcademyKind(aid, kind) { const a = db.academy(aid); if (a) { a.kind = kind; save(); } },
  familyOf: (u) => { const a = S.academies.find((x) => x.kind === 'family' && x.createdBy === u && db.rolesIn(u, x.id).length); return a ? a.id : null; },
  mealLogs: (u, from, to) => Object.values((S.mealLogs || {})[u] || {}).filter((l) => l.date >= from && l.date <= to).sort((a, b) => (a.date + a.key).localeCompare(b.date + b.key)).map((l) => ({ ...l })),
  setMealLog(u, goalId, date, key, entry) { S.mealLogs ||= {}; S.mealLogs[u] ||= {}; S.mealLogs[u][`${date}|${key}`] = { ...entry, date, key, goalId, loggedAt: now() }; save(); },
  deleteMealLog(u, date, key) { const m = (S.mealLogs || {})[u] || {}; const had = !!m[`${date}|${key}`]; delete m[`${date}|${key}`]; if (had) save(); return had ? 1 : 0; },
  addPlanReview() { throw new Error('plan review needs the server'); },
  planReviews: () => [],
  getCalorieOverride: (u) => ((S.overrides || {})[u] ? { ...S.overrides[u] } : null),
  setCalorieOverride(u, kcal, startsOn, endsOn) { S.overrides = { ...(S.overrides || {}), [u]: { kcal, startsOn, endsOn, createdAt: now() } }; save(); },
  clearCalorieOverride(u) { const had = !!(S.overrides || {})[u]; if (had) { delete S.overrides[u]; save(); } return had ? 1 : 0; },
  getSelfWaiver: (u) => ((S.waivers || {})[u] ? { ...S.waivers[u] } : null),
  setSelfWaiver(u, version) { S.waivers = { ...(S.waivers || {}), [u]: { acceptedAt: now(), version } }; save(); },
  clearSelfWaiver(u) { const had = !!(S.waivers || {})[u]; if (had) { delete S.waivers[u]; save(); } return had ? 1 : 0; },
  getMinorConsent: (a) => { const c = (S.minorConsents || {})[a]; return c ? { ...c } : null; },
  setMinorConsent(a, guardianId, academyId) { S.minorConsents = { ...(S.minorConsents || {}), [a]: { guardianId, academyId, grantedAt: now() } }; save(); },
  clearMinorConsent(a) { const had = !!(S.minorConsents || {})[a]; if (had) { delete S.minorConsents[a]; save(); } return had ? 1 : 0; },
  // export (mirror of the SQL methods)
  allGoals: (u) => st(u).goals.map((g) => ({ id: g.id, createdAt: g.created_at, active: !!g.active, startDate: g.start_date, input: g.input, plan: g.plan })),
  allWeekPlans: (u) => st(u).weekplans.map((w) => ({ id: w.id, goalId: w.goalId, createdAt: w.createdAt || null, reason: w.reason || 'generated', plan: w.plan })),
  sharingAsAthlete: (u) => S.sharing.filter((x) => x.athleteId === u).map((x) => ({ academyId: x.academyId, shareHealth: !!x.v.shareHealth, decidedAt: x.v.decidedAt })),
  guardianLinks: (u) => S.guardians.filter((g) => g.parentId === u || g.athleteId === u).map((g) => ({ ...g })),
  shares: () => [],
  guardiansOf: (aid, a) => S.guardians.filter((g) => g.academyId === aid && g.athleteId === a).map((g) => g.parentId),
  getSharing: (aid, a) => { const x = S.sharing.find((y) => y.academyId === aid && y.athleteId === a); return x ? { ...x.v } : { shareHealth: false, decidedBy: null, decidedAt: null }; },
  setSharing(aid, a, share, by) { S.sharing = S.sharing.filter((y) => !(y.academyId === aid && y.athleteId === a)); S.sharing.push({ academyId: aid, athleteId: a, v: { shareHealth: !!share, decidedBy: by, decidedAt: now() } }); save(); },
  getSubscription: (u) => (S.subs || {})[u] || null,
  setSubscription(u, x) { S.subs = { ...(S.subs || {}), [u]: { plan: x.plan, status: x.status, startsOn: x.startsOn, endsOn: x.endsOn } }; save(); },
  subscriptionEvent(u, action, months, endsOn, by, note) { S.subEvents = [...(S.subEvents || []), { u, at: now(), action, months: months || 0, endsOn: endsOn || null, note: note || null }]; save(); },
  subscriptionEvents: (u) => (S.subEvents || []).filter((e) => e.u === u).reverse().map(({ at, action, months, endsOn, note }) => ({ at, action, months, endsOn, note })),
  userByEmail: (e) => { if (e === USER.email) return { id: 1, email: e }; const k = Object.keys(S.people).find((id) => S.people[id].email === e); return k ? { id: Number(k), email: e } : null; },
  allUsers: () => Object.entries(S.people).map(([id, p]) => ({ id: Number(id), email: Number(id) === 1 ? USER.email : p.email })),
  addNotification(u, n) { S.notes = S.notes || []; if (S.notes.some((x) => x.u === u && x.key === n.key)) return 0; S.notes.push({ id: nextId(), u, kind: n.kind, key: n.key, title: n.title, body: n.body, createdAt: now(), readAt: null }); save(); return 1; },
  inbox: (u) => (S.notes || []).filter((x) => x.u === u).slice(-50).reverse().map(({ id, kind, title, body, createdAt, readAt }) => ({ id, kind, title, body, createdAt, readAt })),
  unreadCount: (u) => (S.notes || []).filter((x) => x.u === u && !x.readAt).length,
  markRead(u, id) { const n = (S.notes || []).find((x) => x.u === u && x.id === id && !x.readAt); if (!n) return 0; n.readAt = now(); save(); return 1; },
  markAllRead(u) { (S.notes || []).forEach((x) => { if (x.u === u) x.readAt = x.readAt || now(); }); save(); },
  getProfessional: (u) => (S.pros || {})[u] || null,
  setProfessional(u, p) { S.pros = { ...(S.pros || {}), [u]: { licenseNo: p.licenseNo, issuer: p.issuer, status: p.status, note: p.note || null } }; save(); },
  professionals: () => Object.entries(S.pros || {}).map(([u, p]) => ({ userId: Number(u), email: db.userById(Number(u)).email, ...p })),
  getProSub: (u) => (S.proSubs || {})[u] || null,
  setProSub(u, x) { S.proSubs = { ...(S.proSubs || {}), [u]: { status: x.status, startsOn: x.startsOn, endsOn: x.endsOn } }; save(); },
  pendingExternal: () => [],
  markExternal() {},
  getBranding: (aid) => (S.branding || {})[aid] || null,
  setBranding(aid, b) { S.branding = { ...(S.branding || {}), [aid]: { signature: b.signature, logo: b.logo } }; save(); },
  audit(aid, actor, action, target) { S.audit.push({ id: nextId(), at: now(), academyId: aid, actorId: actor, action, targetId: target ?? null }); if (S.audit.length > 400) S.audit.shift(); save(); },
  auditLog: (aid) => S.audit.filter((e) => e.academyId === aid).slice(-200).reverse().map(({ id, at, actorId, action, targetId }) => ({ id, at, actorId, action, targetId })),
};

// ---------- example plan shown on first open ----------
function seedExample() {
  S = empty();
  S.example = true;
  const t = today();
  const start = addDays(t, -27);
  const v = validateGoalInput({ sex: 'male', age: 24, heightCm: 178, currentWeight: 82, targetWeight: 76, bodyFatPct: 18, bodyFatMethod: 'skinfold',
    startDate: start, sport: 'fin_swimming', sessionsPerWeek: 5, minutesPerSession: 75, intensity: 'moderate', activityLevel: 'light', primaryGoal: 'preserve_muscle', swimDiscipline: 'mono' });
  const plan = createPlan(v.value, start);
  plan.inputWarnings = v.warnings;
  db.setScreening(1, { consent: true, menstrual: null, eating: [], boneStressInjury: false, recurrentIllness: false, persistentFatigue: false, performanceDrop: false,
    unintendedWeightLoss: false, conditions: [], medications: false, supplements: false, impairment: 'none', pregnantOrBreastfeeding: false, professionalClearance: false });
  const goalId = db.saveGoal(1, v.value, plan);
  db.addHydration(1, { date: addDays(t, -6), preKg: 80.9, postKg: 80.1, fluidL: 0.5, urineL: 0, durationMin: 90, environment: 'pool_indoor', note: null });
  db.addHydration(1, { date: addDays(t, -2), preKg: 80.6, postKg: 79.5, fluidL: 0.3, urineL: 0, durationMin: 75, environment: 'pool_outdoor', note: null });
  const noise = [0.2, -0.1, 0.3, 0, -0.2, 0.1, 0.2, -0.1, 0.1, -0.2, 0.2, 0];
  [0, 2, 4, 7, 9, 11, 14, 16, 18, 21, 23, 25].forEach((d, i) => {
    db.upsertWeight(1, goalId, addDays(start, d), +(82 - 0.055 * d + noise[i]).toFixed(1));
  });
  db.upsertCheckin(1, goalId, 2, { week: 2, waistCm: 86, adherencePct: 85, performance: 4, hunger: 3, energy: 4, sleep: 3, recovery: 4, checklistConfirmed: true });
  db.upsertCheckin(1, goalId, 3, { week: 3, waistCm: 85.5, adherencePct: 90, performance: 4, hunger: 3, energy: 4, sleep: 4, recovery: 4, checklistConfirmed: true });
  service.savePrefs(db, 1, { proteins: { chicken: 2, beef: 1, fish: 2, seafood: 1, eggs: 1, legumes: 1, dairy: 1 }, mealsPerDay: 5,
    wakeTime: '06:30', sleepTime: '23:00',
    schedule: { 6: [{ start: '06:00', duration: 75 }, { start: '18:00', duration: 90 }], 1: [{ start: '18:00', duration: 90 }], 3: [{ start: '18:00', duration: 90 }], 4: [{ start: '17:00', duration: 75 }] } });
  service.newWeekPlan(db, 1, t, 20261020);
  seedTeam(t);
  pro.apply(db, 1, { licenseNo: 'DEMO-0001', issuer: 'مثال (نسخة تجريبية)' });
  pro.decide(db, 1, 1, 'verified', 'مثال');
  pro.extend(db, 1, 1, 1, t);
  db.setSubscription(1, { plan: 'monthly', status: 'active', startsOn: t, endsOn: addDays(addMonths(t, 1), -1) });
  db.subscriptionEvent(1, 'extend', 1, addDays(addMonths(t, 1), -1), null, 'مثال');
  [2, 3, 4, 5].forEach((u, i) => db.setSubscription(u, { plan: 'monthly', status: i === 2 ? 'trial' : 'active', startsOn: addDays(t, -20), endsOn: addDays(t, [10, 25, 3, -2][i]) }));
  save();
}

// Sample academy: you are admin + coach + dietitian (and an athlete); three athletes and one parent.
const CLEAR = { consent: true, menstrual: null, eating: [], boneStressInjury: false, recurrentIllness: false, persistentFatigue: false, performanceDrop: false,
  unintendedWeightLoss: false, conditions: [], medications: false, supplements: false, impairment: 'none', pregnantOrBreastfeeding: false, professionalClearance: false };
function seedAthlete(uid, email, t, input, screening, wellness, hyd) {
  S.people[uid] = { email };
  const start = addDays(t, -20);
  const v = validateGoalInput({ startDate: start, intensity: 'moderate', activityLevel: 'light', primaryGoal: 'preserve_muscle', ...input });
  db.setScreening(uid, { ...CLEAR, ...screening });
  const gid = db.saveGoal(uid, v.value, createPlan(v.value, start));
  [0, 3, 7, 10, 14, 17].forEach((d) => db.upsertWeight(uid, gid, addDays(start, d), +(input.currentWeight - 0.04 * d).toFixed(1)));
  wellness.forEach((w, i) => db.upsertCheckin(uid, gid, i + 1, { week: i + 1, adherencePct: w[0], performance: w[1], energy: w[2], sleep: w[3], recovery: w[4], hunger: 3, checklistConfirmed: true }));
  hyd.forEach((x, i) => db.addHydration(uid, { date: addDays(t, -2 - i * 3), preKg: input.currentWeight, postKg: +(input.currentWeight - x[0]).toFixed(1), fluidL: x[1], urineL: 0, durationMin: x[2], environment: 'pool_indoor', note: null }));
}
function seedTeam(t) {
  const aid = db.createAcademy('أكاديمية Aqua Fitness', 1, 'ك/ أحمد ربيع');
  db.addMembership(aid, 1, 'coach'); db.addMembership(aid, 1, 'dietitian'); db.addMembership(aid, 1, 'athlete', 'ك/ أحمد ربيع');
  db.setSharing(aid, 1, true, 1);
  db.setBranding(aid, { signature: 'ك/ أحمد ربيع', logo: null });
  seedAthlete(2, 'mariam@example.com', t, { sex: 'female', age: 21, heightCm: 165, currentWeight: 61, targetWeight: 58, bodyFatPct: 24, bodyFatMethod: 'skinfold',
    sport: 'fin_swimming', swimDiscipline: 'mono', sessionsPerWeek: 6, minutesPerSession: 90 }, { menstrual: 'regular' },
    [[90, 4, 4, 4, 4], [85, 4, 3, 4, 4]], [[0.7, 0.4, 90], [0.9, 0.3, 100]]);
  seedAthlete(3, 'omar@example.com', t, { sex: 'male', age: 19, heightCm: 182, currentWeight: 78, targetWeight: 74,
    sport: 'swimming', swimDiscipline: 'distance', sessionsPerWeek: 9, minutesPerSession: 120 }, { persistentFatigue: true, recurrentIllness: true },
    [[80, 3, 2, 3, 2], [70, 2, 2, 2, 2]], [[1.6, 0.5, 120]]);
  seedAthlete(4, 'youssef@example.com', t, { sex: 'male', age: 15, heightCm: 170, currentWeight: 62, targetWeight: 59,
    sport: 'fin_swimming', swimDiscipline: 'bi_fins', sessionsPerWeek: 5, minutesPerSession: 75 }, {},
    [[95, 4, 5, 4, 4]], [[0.5, 0.3, 75]]);
  S.people[5] = { email: 'parent@example.com' };
  db.addMembership(aid, 2, 'athlete', 'مريم'); db.addMembership(aid, 3, 'athlete', 'عمر'); db.addMembership(aid, 4, 'athlete', 'يوسف');
  db.addMembership(aid, 5, 'parent', 'والد يوسف'); db.linkGuardian(aid, 5, 4);
  db.setSharing(aid, 2, true, 2);
  ['academy_create', 'member_join:athlete', 'member_join:parent', 'sharing_on'].forEach((a, i) => db.audit(aid, [1, 2, 5, 2][i], a, a === 'member_join:parent' ? 4 : null));
}
// the mobile app starts empty (no example athlete or team); the web demo starts with the example
if (!S) { if (MOBILE) { S = empty(); save(); } else seedExample(); }


// ---------- routes (mirror src/server.js) ----------
const PRICING = { priceEgp: null, paymentNote: 'نسخة تجريبية: السعر وطريقة الدفع بيتحددوا في إعدادات المنصة.' };
// offline mobile app: everything stays on the phone and there is no account, so there is no subscription lock
const subOf = (u) => (MOBILE ? { active: true, state: 'active', endsOn: null, daysLeft: null } : u === 1 && S.demoLocked ? { active: false, state: 'expired', endsOn: addDays(today(), -1), daysLeft: 0 } : subscription.status(db, u, today()));
const OPEN = [/^\/api\/inbox/, /^\/api\/family\//, /^\/api\/academies\/\d+\/minor-consent$/, /^\/api\/share/, /^\/api\/household/, /^\/api\/account$/, /^\/api\/me$/, /^\/api\/meta$/, /^\/api\/subscription$/, /^\/api\/export\.csv$/, /^\/api\/auth\//, /^\/api\/recipes$/, /^\/api\/owner\//];
const NOTIF_DEFAULT = { weighInReminder: true, weighInTime: '07:00', weeklyCheckinDay: 5, weeklyCheckinReminder: true, adjustmentAlerts: true };
const ok = (body, status = 200) => ({ status, body });
const bad = (body, status = 400) => ({ status, body });
const errs = (v) => Object.keys(v.errors).length;
const out = (r, okStatus = 200) => (r && r.error ? bad(r, r.status || 400) : ok(r, okStatus));
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const inviteDeps = {
  randomCode: () => { const b = new Uint8Array(10); crypto.getRandomValues(b); let c = ''; for (let i = 0; i < 10; i++) c += ALPH[b[i] % ALPH.length]; return `${c.slice(0, 5)}-${c.slice(5)}`; },
  hash: (c) => `invite:${c}`, nowMs: () => Date.now(),
};

// deliver due reminders into the in-app inbox (same engine as the server's scheduler; user 1 only here)
try {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const ctx = { date: today(), hhmm: `${parts.hour}:${parts.minute}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
  for (const n of notify.dueFor(db, 1, ctx, subOf(1))) db.addNotification(1, n);
} catch { /* demo only */ }

const routes = [
  ['POST', /^\/api\/auth\/(register|login)$/, () => ok({ user: USER })],
  ['POST', /^\/api\/auth\/logout$/, () => ok({ ok: true })],
  ['GET', /^\/api\/me$/, () => ok({ user: USER, emailVerified: true, hasPassword: true, signInMethods: [], subscription: subOf(1), isOwner: !S.demoLocked, pricing: PRICING, pro: pro.proStatus(db, 1, today()) })],
  ['GET', /^\/api\/pro$/, () => ok(pro.proStatus(db, 1, today()))],
  ['POST', /^\/api\/pro\/apply$/, (b) => { const r = pro.apply(db, 1, b); return r.error ? bad(r, r.status) : ok(pro.proStatus(db, 1, today())); }],
  ['GET', /^\/api\/owner\/pro$/, () => ok({ professionals: db.professionals().map((p) => ({ ...p, ...pro.proStatus(db, p.userId, today()) })) })],
  ['POST', /^\/api\/owner\/pro\/decision$/, (b) => { const x = db.userByEmail(String(b.email || '').trim()); if (!x) return bad({ error: 'NOT_FOUND' }, 404); const r = pro.decide(db, 1, x.id, b.decision, b.note); return r.error ? bad(r, r.status) : ok(pro.proStatus(db, x.id, today())); }],
  ['POST', /^\/api\/owner\/pro\/subscriptions$/, (b) => { const x = db.userByEmail(String(b.email || '').trim()); if (!x) return bad({ error: 'NOT_FOUND' }, 404); const r = pro.extend(db, 1, x.id, Number(b.months), today()); return r.error ? bad(r, r.status) : ok(pro.proStatus(db, x.id, today())); }],
  ['DELETE', /^\/api\/account$/, (b) => {
    if (b.confirm !== 'DELETE') return bad({ error: 'CONFIRM_REQUIRED', message: 'اكتب DELETE للتأكيد.' });
    S = empty(); save(); setTimeout(() => location.reload(), 300); return ok({ ok: true });
  }],
  ['GET', /^\/api\/subscription$/, () => ok({ subscription: subOf(1), events: db.subscriptionEvents(1), pricing: PRICING })],
  ['GET', /^\/api\/owner\/subscriptions$/, (b, m, u) => {
    const email = u.searchParams.get('email');
    if (email) { const x = db.userByEmail(email.trim().toLowerCase()); return x ? ok({ user: x, subscription: subOf(x.id), events: db.subscriptionEvents(x.id) }) : bad({ error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' }, 404); }
    return ok({ users: db.allUsers().map((x) => ({ ...x, subscription: subOf(x.id) })) });
  }],
  ['POST', /^\/api\/owner\/subscriptions$/, (b) => {
    const x = db.userByEmail(String(b.email || '').trim().toLowerCase());
    if (!x) return bad({ error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' }, 404);
    const r = subscription.extend(db, 1, x.id, Number(b.months), today(), b.note);
    return r.error ? bad(r, r.status) : ok({ user: x, subscription: subOf(x.id), events: db.subscriptionEvents(x.id) });
  }],
  ['POST', /^\/api\/owner\/subscriptions\/cancel$/, (b) => {
    const x = db.userByEmail(String(b.email || '').trim().toLowerCase());
    if (!x) return bad({ error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' }, 404);
    if (x.id === 1) return bad({ error: 'VALIDATION', message: 'في التجربة استخدم زر «جرّب انتهاء الاشتراك» تحت.' });
    const r = subscription.cancel(db, 1, x.id, today(), b.confirm);
    return r.error ? bad(r, r.status) : ok({ user: x, subscription: subOf(x.id), events: db.subscriptionEvents(x.id) });
  }],
  ['GET', /^\/api\/meta$/, () => ok({ appName: 'أكلني', appNameEn: 'Eklni', fullName: 'أكلني | Eklni', tagline: 'منصة التغذية الذكية | Smart Nutrition Platform', today: today(), googleEnabled: false, sports: Object.entries(SPORTS).map(([k, v]) => ({ key: k, ar: v.ar })), scenarios: SCENARIOS, foodsMeta })],
  ['GET', /^\/api\/recipes$/, () => ok(listRecipes())],
  ['POST', /^\/api\/goal\/preview$/, (b) => {
    const v = validateGoalInput(b);
    if (errs(v)) return bad({ error: 'VALIDATION', errors: v.errors });
    try { return ok({ input: v.value, plan: createPlan(v.value, today(), { selfWaiver: !!db.getSelfWaiver(1) }), inputWarnings: v.warnings }); } catch (e) {
      if (e.code) return bad({ error: e.code, errors: { [e.field || 'weeklyRateKg']: e.message }, recommendation: e.recommendation || recommendRate({ ...v.value, weightKg: v.value.currentWeight }, today()) });
      throw e;
    }
  }],
  ['POST', /^\/api\/goal$/, (b) => {
    const v = validateGoalInput(b);
    if (errs(v)) return bad({ error: 'VALIDATION', errors: v.errors });
    let plan;
    try { plan = createPlan(v.value, today(), { selfWaiver: !!db.getSelfWaiver(1) }); } catch (e) { if (e.code) return bad({ error: e.code, errors: { [e.field || 'weeklyRateKg']: e.message } }); throw e; }
    plan.inputWarnings = v.warnings;
    if (S.example) { S.users[1] = userStore(); S.example = false; }
    const goalId = db.saveGoal(1, v.value, plan);
    db.upsertWeight(1, goalId, v.value.startDate, v.value.currentWeight);
    renderBar();
    return ok(service.buildState(db, 1, today()), 201);
  }],
  ['POST', /^\/api\/goal\/recalculate$/, () => {
    const r = service.recalculate(db, 1, today());
    return r.error ? bad(r) : ok(service.buildState(db, 1, today()));
  }],
  ['GET', /^\/api\/state$/, () => ok(service.buildState(db, 1, today()))],
  ['POST', /^\/api\/weights$/, (b) => {
    const goal = db.activeGoal();
    if (!goal) return bad({ error: 'NO_GOAL' });
    const v = validateWeightEntry(b);
    if (errs(v)) return bad({ error: 'VALIDATION', errors: v.errors });
    if (v.value.date < goal.startDate) return bad({ error: 'VALIDATION', errors: { date: 'التاريخ قبل بداية الخطة.' } });
    if (v.value.date > today()) return bad({ error: 'VALIDATION', errors: { date: 'لا يمكن تسجيل وزن بتاريخ مستقبلي.' } });
    db.upsertWeight(1, goal.id, v.value.date, v.value.weightKg);
    return ok(service.buildState(db, 1, today()));
  }],
  ['DELETE', /^\/api\/weights\/(\d{4}-\d{2}-\d{2})$/, (b, m) => {
    const goal = db.activeGoal();
    if (!goal) return bad({ error: 'NO_GOAL' });
    db.deleteWeight(1, goal.id, m[1]);
    return ok(service.buildState(db, 1, today()));
  }],
  ['POST', /^\/api\/checkins$/, (b) => {
    const goal = db.activeGoal();
    if (!goal) return bad({ error: 'NO_GOAL' });
    const v = validateCheckin(b);
    if (errs(v)) return bad({ error: 'VALIDATION', errors: v.errors });
    db.upsertCheckin(1, goal.id, v.value.week, v.value);
    return ok(service.buildState(db, 1, today()));
  }],
  ['POST', /^\/api\/adjustments\/evaluate$/, () => {
    const r = service.proposeAdjustment(db, 1, today());
    return r.error ? bad(r) : ok({ ...r, state: service.buildState(db, 1, today()) });
  }],
  ['POST', /^\/api\/adjustments\/(\d+)\/decision$/, (b, m) => {
    if (!['accepted', 'rejected'].includes(b.decision)) return bad({ error: 'VALIDATION', errors: { decision: 'قرار غير صحيح.' } });
    const r = service.decideAdjustment(db, 1, Number(m[1]), b.decision, typeof b.note === 'string' ? b.note.slice(0, 300) : null);
    return r.error ? bad(r, r.error === 'GUARD' ? 422 : 404) : ok(service.buildState(db, 1, today()));
  }],
  ['GET', /^\/api\/prefs$/, () => ok({ prefs: service.getPrefs(db, 1), options: service.prefsOptions() })],
  ['PUT', /^\/api\/prefs$/, (b) => { const r = service.savePrefs(db, 1, b); return r.error ? bad(r) : ok(r); }],
  ['GET', /^\/api\/weekplan$/, () => { const r = service.getWeekPlan(db, 1, today()); return r.error ? bad(r) : ok(r); }],
  ['POST', /^\/api\/weekplan$/, () => { const r = service.newWeekPlan(db, 1, today(), Math.floor(Math.random() * 2 ** 31)); return r.error ? bad(r) : ok(r); }],
  ['POST', /^\/api\/weekplan\/swap$/, (b) => {
    const day = Number(b.day), slot = Number(b.slot);
    if (!Number.isInteger(day) || !Number.isInteger(slot) || day < 0 || day > 6 || slot < 0 || slot > 7) return bad({ error: 'VALIDATION' });
    const r = service.swapWeekMeal(db, 1, day, slot, Math.floor(Math.random() * 2 ** 31), today());
    return r.error ? bad(r) : ok(r);
  }],
  ['POST', /^\/api\/weekplan\/extras$/, (b) => {
    const r = service.addWeekExtra(db, 1, { day: Number(b.day), recipeId: b.recipeId, servings: b.servings, attachTo: b.attachTo == null ? null : Number(b.attachTo), compensate: b.compensate }, today());
    return r.error ? bad(r) : ok(r);
  }],
  ['DELETE', /^\/api\/weekplan\/extras\/(\d)\/([\w-]+)$/, (b, m) => { const r = service.removeWeekExtra(db, 1, { day: Number(m[1]), entryId: m[2] }, today()); return r.error ? bad(r) : ok(r); }],
  ['PUT', /^\/api\/goal\/season$/, (b) => { const r = service.setSeasonPhase(db, 1, b.seasonPhase, today()); return r.error ? bad(r) : ok(service.buildState(db, 1, today())); }],
  ['GET', /^\/api\/weekplan\/sauces\/(\d)\/(\d{1,2})$/, (b, m) => { const r = service.weekSauces(db, 1, Number(m[1]), Number(m[2])); return r.error ? bad(r) : ok(r); }],
  ['GET', /^\/api\/weekplan\/history$/, () => { const r = service.weekPlanHistory(db, 1); return r.error ? bad(r) : ok(r); }],
  ['POST', /^\/api\/weekplan\/restore\/(\d+)$/, (b, m) => { const r = service.restoreWeekPlan(db, 1, Number(m[1]), today()); return r.error ? bad(r, r.error === 'NOT_FOUND' ? 404 : 400) : ok(r); }],
  ['GET', /^\/api\/screening$/, () => ok(service.getScreening(db, 1))],
  ['PUT', /^\/api\/screening$/, (b) => { const r = service.saveScreening(db, 1, b, today(), Date.now() % 100000); return r.error ? bad(r) : ok(r); }],
  ['GET', /^\/api\/hydration$/, () => ok(service.getHydration(db, 1))],
  ['POST', /^\/api\/hydration$/, (b) => { const r = service.addHydration(db, 1, b); return r.error ? bad(r) : ok(r, 201); }],
  ['DELETE', /^\/api\/hydration\/(\d+)$/, (b, m) => ok(service.deleteHydration(db, 1, Number(m[1])))],
  ['POST', /^\/api\/hydration\/check$/, (b) => ok(wutCheck(b))],
  ['GET', /^\/api\/academies$/, () => ok(academy.myAcademies(db, 1))],
  ['GET', /^\/api\/intake$/, () => out(service.intakeWeek(db, 1, today()))],
  ['PUT', /^\/api\/intake$/, (b) => out(service.logIntake(db, 1, b, today()))],
  ['PUT', /^\/api\/calorie-override$/, (b) => out(service.setCalorieOverride(db, 1, b, today(), Date.now() % 100000))],
  ['DELETE', /^\/api\/calorie-override$/, () => out(service.setCalorieOverride(db, 1, { clear: true }, today(), Date.now() % 100000))],
  ['PUT', /^\/api\/self-waiver$/, (b) => out(service.setSelfWaiver(db, 1, b, today(), Date.now() % 100000))],
  ['POST', /^\/api\/family\/invite$/, (b) => out(academy.inviteGuardian(db, 1, b, inviteDeps), 201)],
  ['PUT', /^\/api\/academies\/(\d+)\/minor-consent$/, (b, m) => out(academy.setMinorConsent(db, 1, Number(m[1]), b))],
  // Share links need a server (a public URL); the demo explains instead of pretending.
  // «البيت» links several real accounts; the demo has one person on one device.
  ['GET', /^\/api\/household$/, () => ok({ household: null })],
  ['POST', /^\/api\/household(\/join)?$/, () => bad({ error: 'DEMO', message: 'ربط البيت محتاج أكتر من حساب، فهو شغال في النسخة الكاملة بس. هناك كل واحد يعمل حسابه، وواحد يعمل «بيت» ويبعت الكود للتاني.' })],
  ['GET', /^\/api\/share$/, () => ok({ links: [] })],
  ['POST', /^\/api\/share$/, () => bad({ error: 'DEMO', message: 'المشاركة بواتس اب وتليجرام والإيميل شغالة في النسخة الكاملة بس (محتاجة سيرفر يعمل الرابط). هنا تقدر تفتح «ملف التغذية PDF» وتحفظه وتبعته.' })],
  ['DELETE', /^\/api\/share\/(\d+)$/, () => bad({ error: 'NOT_FOUND' }, 404)],
  ['POST', /^\/api\/academies$/, (b) => out(academy.createAcademy(db, 1, b), 201)],
  ['POST', /^\/api\/invites\/accept$/, (b) => out(academy.acceptInvite(db, 1, b, inviteDeps))],
  ['POST', /^\/api\/academies\/(\d+)\/invites$/, (b, m) => out(academy.createInvite(db, 1, Number(m[1]), b, inviteDeps), 201)],
  ['GET', /^\/api\/academies\/(\d+)\/members$/, (b, m) => out(academy.listMembers(db, 1, Number(m[1])))],
  ['DELETE', /^\/api\/academies\/(\d+)\/members\/(\d+)$/, (b, m) => out(academy.removeMember(db, 1, Number(m[1]), Number(m[2]), b))],
  ['PUT', /^\/api\/academies\/(\d+)\/sharing$/, (b, m) => out(academy.setSharing(db, 1, Number(m[1]), b))],
  ['GET', /^\/api\/academies\/(\d+)\/athletes$/, (b, m) => out(academy.roster(db, 1, Number(m[1]), today()))],
  ['GET', /^\/api\/academies\/(\d+)\/athletes\/(\d+)$/, (b, m) => out(academy.viewAthlete(db, 1, Number(m[1]), Number(m[2]), today()))],
  ['GET', /^\/api\/academies\/(\d+)\/branding$/, (b, m) => out(academy.getBranding(db, 1, Number(m[1])))],
  ['PUT', /^\/api\/academies\/(\d+)\/branding$/, (b, m) => out(academy.setBranding(db, 1, Number(m[1]), b))],
  ['GET', /^\/api\/academies\/(\d+)\/audit$/, (b, m) => out(academy.auditLog(db, 1, Number(m[1])))],
  ['GET', /^\/api\/dri$/, () => { const r = service.getDri(db, 1); return r.error ? bad(r) : ok(r); }],
  ['GET', /^\/api\/references$/, () => ok({ ...REFS, foodQuality: foodQuality() })],
  ['GET', /^\/api\/competition$/, () => ok(service.getCompetition(db, 1))],
  ['PUT', /^\/api\/competition$/, (b) => { const r = service.saveCompetition(db, 1, b, today()); return r.error ? bad(r) : ok(r); }],
  ['DELETE', /^\/api\/competition$/, () => ok(service.deleteCompetition(db, 1))],
  ['GET', /^\/api\/notifications$/, () => ok({ settings: { ...notify.DEFAULTS, ...(db.getNotifications(1) || {}) }, deliveryImplemented: true, channels: { inapp: true, external: false } })],
  ['PUT', /^\/api\/notifications$/, (b) => {
    const v = notify.validateSettings(b);
    if (Object.keys(v.errors).length || v.value.externalChannel) return bad({ error: 'VALIDATION', errors: { ...v.errors, ...(v.value.externalChannel ? { externalChannel: 'الإرسال الخارجي مش متفعّل في التجربة.' } : {}) } });
    db.setNotifications(1, v.value);
    return ok({ settings: v.value, deliveryImplemented: true, channels: { inapp: true, external: false } });
  }],
  ['GET', /^\/api\/inbox$/, () => ok({ items: db.inbox(1), unread: db.unreadCount(1) })],
  ['POST', /^\/api\/inbox\/(\d+)\/read$/, (b, m) => (db.markRead(1, Number(m[1])) ? ok({ unread: db.unreadCount(1) }) : bad({ error: 'NOT_FOUND' }, 404))],
  ['POST', /^\/api\/inbox\/read-all$/, () => { db.markAllRead(1); return ok({ unread: 0 }); }],
];

const realFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = async function (input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const u = new URL(url, location.href);
  if (!u.pathname.startsWith('/api/') || (typeof input === 'string' && /^https?:/.test(input) && u.origin !== location.origin)) {
    return realFetch(input, init);
  }
  const method = (init.method || 'GET').toUpperCase();
  let body = {};
  try { body = init.body ? JSON.parse(init.body) : {}; } catch { return json({ error: 'BAD_REQUEST' }, 400); }
  const staffRoute = /^\/api\/(academies|invites|pro)/.test(u.pathname);
  if (!OPEN.some((re) => re.test(u.pathname)) && !subOf(1).active && !(staffRoute && !S.demoLocked && pro.proStatus(db, 1, today()).subscription.active)) {
    return json({ error: 'SUBSCRIPTION_REQUIRED', message: 'الاشتراك انتهى.', subscription: subOf(1), pricing: PRICING }, 402);
  }
  for (const [m, re, fn] of routes) {
    const match = re.exec(u.pathname);
    if (match && m === method) {
      try { const r = fn(body, match, u); return json(r.body, r.status); } catch (e) { console.error(e); return json({ error: 'SERVER_ERROR' }, 500); }
    }
  }
  return json({ error: 'NOT_FOUND' }, 404);
};
function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// ---------- report & CSV open in an in-page sheet (the viewer blocks new windows and downloads) ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  kids.flat().forEach((k) => k != null && e.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return e;
}
function openSheet(title, content) {
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = '';
  sheet.append(h('div', { class: 'sheet-head' }, h('strong', {}, title), h('button', { type: 'button', class: 'ghost', onclick: () => { sheet.hidden = true; } }, 'إغلاق')), content);
  sheet.hidden = false;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="/api/"]');
  if (!a) return;
  e.preventDefault();
  if (a.getAttribute('href') === '/api/export.json') {
    const ta = h('textarea', { class: 'sheet-csv', readonly: '', rows: '18', dir: 'ltr', 'aria-label': 'بياناتي JSON' });
    ta.value = JSON.stringify(account.exportData(db, 1), null, 2);
    openSheet('كل بياناتي', h('div', { class: 'sheet-pad' }, NATIVE()
      ? h('button', { type: 'button', class: 'primary', onclick: () => { try { nativeSave(`eklni-my-data-${today()}.json`, ta.value, 'application/json'); } catch { /* shown by the system */ } } }, 'حفظ / مشاركة الملف')
      : h('p', { class: 'small muted' }, 'في النسخة الكاملة بيتنزل ملف JSON؛ هنا تقدر تنسخه.'), ta));
    return;
  }
  if (a.getAttribute('href') !== '/api/export.csv' && !subOf(1).active) return;
  const st = service.buildState(db, 1, today());
  if (!st.goal) return;
  if (a.getAttribute('href') === '/api/nutrition-file') {
    const r = service.nutritionFile(db, 1, today(), academy.brandingFor(db, 1));
    if (r.error) return;
    const frame = h('iframe', { class: 'sheet-frame', title: 'ملف التغذية', sandbox: 'allow-same-origin allow-modals' });
    frame.srcdoc = r.html.replace(/<div class="bar">[\s\S]*?<\/div>/, '');
    const pr = h('button', { type: 'button', class: 'primary', onclick: (e) => window.__eklniDownloadPdf && window.__eklniDownloadPdf(e.currentTarget) }, 'تنزيل PDF');
    const prn = h('button', { type: 'button', onclick: () => { try { frame.contentWindow.print(); } catch { /* blocked */ } } }, 'طباعة');
    openSheet('ملف التغذية', h('div', { class: 'sheet-col' }, h('div', { class: 'sheet-pad' }, pr, ' ', prn), frame));
    return;
  }
  if (a.getAttribute('href') === '/api/report') {
    const frame = h('iframe', { class: 'sheet-frame', title: 'تقرير التقدم', sandbox: '' });
    frame.srcdoc = renderReport(st, USER, academy.brandingFor(db, 1), (() => { const w = service.intakeWeek(db, 1, today()); return w && !w.error ? w : null; })()).replace(/<button class="noprint"[\s\S]*?<\/button>/, '');
    openSheet('تقرير التقدم', frame);
  } else {
    const csv = renderCsv(st).replace(/^﻿/, '');
    const ta = h('textarea', { class: 'sheet-csv', readonly: '', rows: '12', 'aria-label': 'بيانات CSV', dir: 'ltr' });
    ta.value = csv;
    const msg = h('span', { class: 'small muted' }, '');
    const copy = h('button', { type: 'button', class: 'primary', onclick: () => {
      navigator.clipboard.writeText(csv).then(() => { msg.textContent = 'تم النسخ؛ الصقه في Excel أو Google Sheets.'; })
        .catch(() => { ta.focus(); ta.select(); msg.textContent = 'النص متحدد؛ انسخه يدويًا.'; });
    } }, 'نسخ البيانات');
    const nsave = NATIVE() ? h('button', { type: 'button', onclick: () => { try { nativeSave(`eklni-progress-${today()}.csv`, '\ufeff' + csv, 'text/csv'); } catch { /* shown by the system */ } } }, 'حفظ / مشاركة CSV') : null;
    openSheet('بيانات CSV', h('div', { class: 'sheet-pad' }, h('p', { class: 'small muted' }, NATIVE() ? 'احفظ الملف أو شاركه، أو انسخ البيانات.' : 'التنزيل المباشر غير متاح في هذه النسخة؛ انسخ البيانات والصقها في جدول.'), ta, h('div', { class: 'row' }, copy, nsave, msg)));
  }
}, true);

// ---------- nutrition PDF download (app.js calls these hooks) ----------
window.__eklniNutritionHtml = () => {
  if (!subOf(1).active) return null;
  const r = service.nutritionFile(db, 1, today(), academy.brandingFor(db, 1));
  return r.error ? null : r.html;
};
// Saving goes through the page's «downloads» capability (Claude asks the viewer to confirm); a plain link is
// only the fallback outside Claude, where it cannot be confirmed — app.js words its message accordingly.
let downloadsP = null;
const getDownloads = () => downloadsP || (downloadsP = (window.claude && typeof window.claude.use === 'function')
  ? Promise.resolve(window.claude.use('downloads')).catch(() => null) : Promise.resolve(null));
setTimeout(getDownloads, 0);
// Android app: bytes → base64 → native save/share sheet (Files, Google Drive, WhatsApp…)
function nativeSave(name, bytes, mime) {
  const n = NATIVE();
  if (!n) return null;
  const u8 = bytes instanceof Uint8Array ? bytes : typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  const r = n.saveFile(name, btoa(bin), mime);
  if (r !== 'ok') throw Object.assign(new Error(r || 'save'), { code: `PDF-4:native:${r || 'unknown'}` });
  return 'saved';
}
window.__eklniSaveFile = async (name, bytes) => {
  const nv = nativeSave(name, bytes, 'application/pdf');
  if (nv) return nv;
  const dl = await getDownloads();
  if (dl) {
    try { await dl.save({ filename: name, data: new Blob([bytes], { type: 'application/pdf' }) }); return 'saved'; }
    catch (e) {
      if (e && e.code === 'declined') return 'declined';
      if (e && e.code === 'rate_limited') throw new Error('فيه طلب تنزيل مفتوح؛ استنى ثانية وجرّب تاني.');
      throw Object.assign(new Error('save'), { code: `PDF-4:${(e && e.code) || 'unknown'}` });
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'link';
};

// ---------- demo bar ----------
function lockBtn() {
  return h('button', { type: 'button', class: 'ghost small-btn', onclick: () => { S.demoLocked = !S.demoLocked; save(); location.reload(); } },
    S.demoLocked ? 'رجّع الاشتراك' : 'جرّب انتهاء الاشتراك');
}
// Mobile: backup (the whole on-phone store as one JSON file → share to Google Drive, Files…), restore, wipe.
const BACKUP_FORMAT = 'eklni-mobile-backup-v1';
function restoreFrom(text) {
  let d;
  try { d = JSON.parse(text); } catch { return 'الملف مش JSON صحيح.'; }
  if (!d || d.format !== BACKUP_FORMAT || !d.store || !d.store.users || !d.store.users[1]) return 'الملف ده مش نسخة احتياطية من أكلني.';
  S = { ...empty(), ...d.store }; save(); return null;
}
function renderMobileBar(bar) {
  const msg = h('span', { class: 'small', role: 'status' }, '');
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: '', onchange: async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const err = restoreFrom(await f.text());
    if (err) { msg.textContent = err; return; }
    location.reload();
  } });
  const confirmRow = h('div', { class: 'demo-confirm', hidden: '' },
    h('span', {}, 'هتتمسح كل البيانات من الموبايل ده. خد نسخة احتياطية الأول. متأكد؟'),
    h('button', { type: 'button', class: 'danger', onclick: () => { S = empty(); save(); location.reload(); } }, 'امسح'),
    h('button', { type: 'button', class: 'ghost', onclick: () => { confirmRow.hidden = true; } }, 'رجوع'));
  const backup = () => {
    const body = JSON.stringify({ format: BACKUP_FORMAT, savedAt: new Date().toISOString(), store: S });
    try { if (!nativeSave(`eklni-backup-${today()}.json`, body, 'application/json')) msg.textContent = 'الحفظ متاح جوه تطبيق الموبايل بس.'; }
    catch { msg.textContent = 'تعذر الحفظ.'; }
  };
  const det = h('details', { class: 'demo-row mobile-data' }, h('summary', {}, 'بياناتك على الموبايل ده بس · نسخة احتياطية'),
    h('div', { class: 'demo-row' },
      h('button', { type: 'button', class: 'small-btn', onclick: backup }, 'نسخة احتياطية (احفظها على Google Drive)'),
      h('button', { type: 'button', class: 'ghost small-btn', onclick: () => file.click() }, 'استرجاع نسخة'),
      h('button', { type: 'button', class: 'ghost small-btn', onclick: () => { confirmRow.hidden = false; } }, 'مسح البيانات'), file, msg),
    confirmRow);
  bar.append(det);
}
function renderBar() {
  const bar = document.getElementById('demo-bar');
  if (!bar) return;
  bar.innerHTML = '';
  if (MOBILE) { renderMobileBar(bar); return; }
  const confirmRow = h('div', { class: 'demo-confirm', hidden: '' },
    h('span', {}, 'هتتمسح كل البيانات على الجهاز ده. متأكد؟'),
    h('button', { type: 'button', class: 'danger', onclick: () => { S = empty(); save(); location.reload(); } }, 'امسح'),
    h('button', { type: 'button', class: 'ghost', onclick: () => { confirmRow.hidden = true; } }, 'رجوع'));
  if (S.example) {
    bar.append(h('div', { class: 'demo-row' },
      h('span', {}, h('strong', {}, 'بيانات مثال: '), 'سبّاح زعانف «مونو» 82 كجم في الخطة من 4 أسابيع، ومعاه أكاديمية تجريبية فيها 3 لاعبين وولي أمر (المزيد ← الأكاديمية والفريق).'),
      h('button', { type: 'button', class: 'primary', onclick: () => { S.users[1] = userStore(); S.example = false; save(); location.reload(); } }, 'ابدأ خطتك'),
      lockBtn()));
  } else {
    bar.append(h('div', { class: 'demo-row' },
      h('span', {}, 'نسخة تجريبية: بياناتك محفوظة على الجهاز ده بس.'),
      h('button', { type: 'button', class: 'ghost small-btn', onclick: () => { confirmRow.hidden = false; } }, 'مسح البيانات'),
      h('button', { type: 'button', class: 'ghost small-btn', onclick: () => { seedExample(); location.reload(); } }, 'عرض المثال'),
      lockBtn()));
  }
  bar.append(confirmRow);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderBar); else renderBar();
