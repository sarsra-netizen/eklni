'use strict';
// «البيت»: people who live together get the same dishes (and sides) for the meals they choose to share,
// e.g. breakfast — each person's grams stay calculated from his own targets.
// Privacy: members see each other's display name and whether they have a plan this week, never targets,
// weights, health answers or portions. Joining with a code is the member's consent to share dish names.
const weekplan = require('./engine/weekplan');
const KINDS = ['breakfast', 'lunch', 'dinner'];
const KIND_AR = { breakfast: 'الفطار', lunch: 'الغدا', dinner: 'العشا' };
const MAX_MEMBERS = 8;
const INVITE_DAYS = 7;
const clean = (v, n = 40) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

function create(db, userId, body) {
  if (db.householdOf(userId)) return { error: 'ALREADY_MEMBER', status: 409, message: 'انت في بيت بالفعل؛ اخرج منه الأول.' };
  const name = clean(body.name) || 'بيتنا';
  const id = db.createHousehold(name, userId);
  db.addHouseholdMember(id, userId, clean(body.displayName) || null);
  return state(db, userId);
}

function invite(db, userId, deps) {
  const h = db.householdOf(userId);
  if (!h) return { error: 'NOT_MEMBER', status: 404 };
  if (db.householdMembers(h.id).length >= MAX_MEMBERS) return { error: 'FULL', status: 400, message: `البيت فيه ${MAX_MEMBERS} أفراد بالفعل.` };
  const code = deps.randomCode();
  const expiresAt = deps.nowMs() + INVITE_DAYS * 86400000;
  db.createHouseholdInvite(deps.hash(code), h.id, userId, expiresAt);
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

function join(db, userId, body, deps) {
  if (db.householdOf(userId)) return { error: 'ALREADY_MEMBER', status: 409, message: 'انت في بيت بالفعل؛ اخرج منه الأول.' };
  const code = String(body.code || '').trim().toUpperCase();
  const inv = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(code) ? db.householdInviteByHash(deps.hash(code)) : null;
  if (!inv || inv.used_by != null || inv.expires_at < deps.nowMs()) return { error: 'BAD_CODE', status: 400, message: 'الكود غلط أو استخدم قبل كده أو انتهى.' };
  if (db.householdMembers(inv.household_id).length >= MAX_MEMBERS) return { error: 'FULL', status: 400, message: 'البيت ده مليان.' };
  if (!db.useHouseholdInvite(deps.hash(code), userId)) return { error: 'BAD_CODE', status: 400, message: 'الكود استخدم قبل كده.' };
  db.addHouseholdMember(inv.household_id, userId, clean(body.displayName) || null);
  return state(db, userId);
}

function leave(db, userId) {
  const h = db.householdOf(userId);
  if (!h) return { error: 'NOT_MEMBER', status: 404 };
  db.removeHouseholdMember(h.id, userId);
  if (!db.householdMembers(h.id).length) db.deleteHousehold(h.id);
  else if (h.created_by === userId) db.setHouseholdOwner(h.id, db.householdMembers(h.id)[0].userId);
  return { household: null };
}

// Only the person who manages the house (creator, or the next member) changes which meals are shared.
function settings(db, userId, body) {
  const h = db.householdOf(userId);
  if (!h) return { error: 'NOT_MEMBER', status: 404 };
  if (h.created_by !== userId) return { error: 'FORBIDDEN', status: 403, message: 'مسؤول البيت بس هو اللي يغيّر الوجبات المشتركة.' };
  const kinds = Array.isArray(body.sharedMeals) ? [...new Set(body.sharedMeals.filter((k) => KINDS.includes(k)))] : null;
  if (!kinds) return { error: 'VALIDATION', status: 400, message: 'اختار وجبة أو أكتر.' };
  if (body.name !== undefined) db.renameHousehold(h.id, clean(body.name) || h.name);
  db.setHouseholdMeals(h.id, kinds);
  return state(db, userId);
}

function removeMember(db, userId, memberId) {
  const h = db.householdOf(userId);
  if (!h) return { error: 'NOT_MEMBER', status: 404 };
  if (h.created_by !== userId || memberId === userId) return { error: 'FORBIDDEN', status: 403 };
  if (!db.householdMembers(h.id).some((m) => m.userId === memberId)) return { error: 'NOT_FOUND', status: 404 };
  db.removeHouseholdMember(h.id, memberId);
  return state(db, userId);
}

// Members are ordered by joining time; the menu for a day comes from the earliest member (other than me)
// whose current plan covers that day. So whoever plans first sets the menu, and the rest follow.
function menuFor(db, userId, planOf) {
  const h = db.householdOf(userId);
  if (!h || !h.sharedMeals.length) return null;
  const menu = {};
  let from = 0;
  for (const m of db.householdMembers(h.id)) {
    if (m.userId === userId) continue;
    const plan = planOf(m.userId);
    if (!plan) continue;
    const mm = weekplan.householdMenu(plan, h.sharedMeals);
    let used = false;
    for (const [date, day] of Object.entries(mm)) {
      for (const [kind, spec] of Object.entries(day)) {
        if (!menu[date]) menu[date] = {};
        if (!menu[date][kind]) { menu[date][kind] = spec; used = true; }
      }
    }
    if (used) from += 1;
  }
  return Object.keys(menu).length ? { name: h.name, menu, sources: from } : { name: h.name, menu: {}, sources: 0 };
}

function state(db, userId, planOf = null) {
  const h = db.householdOf(userId);
  if (!h) return { household: null };
  return { household: { id: h.id, name: h.name, sharedMeals: h.sharedMeals, sharedMealsAr: h.sharedMeals.map((k) => KIND_AR[k]), manager: h.created_by === userId,
    members: db.householdMembers(h.id).map((m) => ({ id: m.userId, displayName: m.displayName || (m.userId === userId ? 'أنا' : 'فرد من البيت'), me: m.userId === userId,
      manager: m.userId === h.created_by, hasPlan: planOf ? !!planOf(m.userId) : undefined })) } };
}

// One shopping list for the house: the weekly grocery lists of every member who has a plan, added up.
// Only totals per food are returned (no per-person amounts).
function grocery(db, userId, planOf) {
  const h = db.householdOf(userId);
  if (!h) return { error: 'NOT_MEMBER', status: 404 };
  const byFood = new Map();
  let people = 0;
  for (const m of db.householdMembers(h.id)) {
    const plan = planOf(m.userId);
    if (!plan || !plan.grocery) continue;
    people += 1;
    for (const g of plan.grocery) {
      const cur = byFood.get(g.foodId) || { foodId: g.foodId, ar: g.ar, group: g.group, state: g.state, grams: 0, unitG: g.unitG || null, unitAr: g.unitAr || null };
      cur.grams += g.grams;
      byFood.set(g.foodId, cur);
    }
  }
  const items = [...byFood.values()].map((g) => ({ ...g, units: g.unitG ? `≈ ${Math.ceil(g.grams / g.unitG)} ${g.unitAr}` : null }))
    .sort((a, b) => (a.group === b.group ? b.grams - a.grams : a.group.localeCompare(b.group, 'ar')));
  return { people, members: db.householdMembers(h.id).length, grocery: items };
}

module.exports = { grocery, create, invite, join, leave, settings, removeMember, menuFor, state, KINDS, KIND_AR, MAX_MEMBERS };
