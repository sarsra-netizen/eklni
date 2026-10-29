'use strict';
// 0.7.0: «البيت» — people living together get the same dishes for the meals they share; grams stay personal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-house-'));
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 'h.db'), today: () => '2026-10-22', trialDays: 30, notifications: false, registerLimitPerHour: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}
const ME = { sex: 'male', age: 28, heightCm: 178, currentWeight: 84, targetWeight: 78, startDate: '2026-10-22', sport: 'swimming', sessionsPerWeek: 5, minutesPerSession: 90 };
const BRO = { sex: 'male', age: 22, heightCm: 170, currentWeight: 66, targetWeight: 64, startDate: '2026-10-22', sport: 'running', sessionsPerWeek: 3, minutesPerSession: 45 };
async function athlete(email, goal) {
  const c = client();
  c.id = (await c('POST', '/api/auth/register', { email, password: 'longpass1' })).body.user.id;
  await c('PUT', '/api/screening', { consent: true });
  await c('POST', '/api/goal', goal);
  return c;
}
const firstOf = (plan, kind) => plan.days.map((d) => d.meals.find((m) => m.slot === kind && !m.timing));

test('household: create, invite, join; one membership per person; bad codes rejected', async () => {
  const a = await athlete('h1@x.test', ME);
  const b = await athlete('h2@x.test', BRO);
  const made = await a('POST', '/api/household', { name: 'بيت ربيع', displayName: 'أحمد' });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.household.sharedMeals, ['breakfast', 'lunch', 'dinner']);
  const inv = (await a('POST', '/api/household/invite')).body.code;
  assert.equal((await b('POST', '/api/household/join', { code: 'AAAAA-BBBBB' })).status, 400);
  const j = await b('POST', '/api/household/join', { code: inv, displayName: 'محمد' });
  assert.equal(j.status, 200);
  assert.equal(j.body.household.members.length, 2);
  assert.ok(!JSON.stringify(j.body).includes('h1@x.test'), 'members never see e-mails');
  assert.equal((await b('POST', '/api/household', { name: 'تاني' })).status, 409);
  const c = await athlete('h3@x.test', BRO);
  assert.equal((await c('POST', '/api/household/join', { code: inv })).status, 400, 'code is single-use');
  assert.equal((await b('PUT', '/api/household', { sharedMeals: ['breakfast'] })).status, 403, 'only the manager changes shared meals');
});

test('shared breakfast: same dish and sides for both brothers, grams from each one’s own targets', async () => {
  const a = await athlete('s1@x.test', ME);
  const b = await athlete('s2@x.test', BRO);
  await a('POST', '/api/household', { name: 'بيت', displayName: 'أحمد' });
  await b('POST', '/api/household/join', { code: (await a('POST', '/api/household/invite')).body.code });
  assert.equal((await a('PUT', '/api/household', { sharedMeals: ['breakfast'] })).status, 200);
  const pa = (await a('POST', '/api/weekplan', {})).body.plan;
  const pb = (await b('POST', '/api/weekplan', {})).body.plan;
  const ba = firstOf(pa, 'breakfast'); const bb = firstOf(pb, 'breakfast');
  let same = 0;
  for (let i = 0; i < 7; i++) {
    if (!ba[i] || !bb[i]) continue;
    if (bb[i].shared) { same += 1; assert.equal(bb[i].recipeId, ba[i].recipeId); }
    else assert.ok(bb[i].sharedNote, 'a different breakfast always says why');
  }
  assert.ok(same >= 5, `breakfast shared on ${same}/7 days`);
  assert.ok(pb.household.sharedMeals >= 5);
  assert.ok(ba.some((m, i) => bb[i] && bb[i].shared && m.servings !== bb[i].servings), 'portions are personal');
  // lunch is not shared now
  assert.ok(firstOf(pb, 'lunch').every((m) => !m || !m.shared));
  // swapping another meal of the day keeps the shared breakfast and its sides
  const di = bb.findIndex((m) => m && m.shared);
  const lunch = pb.days[di].meals.find((m) => m.slot === 'lunch');
  const after = (await b('POST', '/api/weekplan/swap', { day: di, slot: lunch.idx })).body.plan;
  const kept = firstOf(after, 'breakfast')[di];
  assert.equal(kept.recipeId, bb[di].recipeId);
  assert.ok(kept.shared);
  // the starch side follows the household's choice whenever this person has one (the calorie trim may drop it for him)
  const keyOf = (m) => (m.extras.find((e) => e.kind === 'carb') || {}).key;
  if (keyOf(kept) && keyOf(ba[di])) assert.equal(keyOf(kept), keyOf(ba[di]));
  // the house grocery list adds both plans
  const g = await a('GET', '/api/household/grocery');
  assert.equal(g.body.people, 2);
  const mine = Object.fromEntries(pa.grocery.map((x) => [x.foodId, x.grams]));
  assert.ok(g.body.grocery.some((x) => mine[x.foodId] && x.grams > mine[x.foodId]));
});

test('an allergy wins over the household dish', async () => {
  const a = await athlete('al1@x.test', ME);
  const b = await athlete('al2@x.test', BRO);
  await a('POST', '/api/household', { name: 'بيت' });
  await b('POST', '/api/household/join', { code: (await a('POST', '/api/household/invite')).body.code });
  await a('PUT', '/api/household', { sharedMeals: ['breakfast'] });
  const pa = (await a('POST', '/api/weekplan', {})).body.plan;
  const prefs = (await b('GET', '/api/prefs')).body.prefs;
  assert.equal((await b('PUT', '/api/prefs', { ...prefs, avoid: ['egg'] })).status, 200);
  const eggDays = firstOf(pa, 'breakfast').filter((m) => m && m.recipeId).length;
  const pb = (await b('POST', '/api/weekplan', {})).body.plan;
  const recipes = new Map((await b('GET', '/api/recipes')).body.recipes.map((r) => [r.id, r]));
  const egg = (id) => (recipes.get(id).plan.allergens || []).includes('egg');
  const ba = firstOf(pa, 'breakfast'); const bb = firstOf(pb, 'breakfast');
  assert.ok(eggDays && ba.some((m) => m && egg(m.recipeId)), 'the household menu has egg breakfasts (precondition)');
  bb.forEach((m, i) => {
    if (!m || !m.recipeId) return;
    assert.ok(!egg(m.recipeId));
    if (ba[i] && egg(ba[i].recipeId)) assert.ok(m.sharedNote && !m.shared);
  });
});

test('leaving: the house passes to the next member; deleting the last account removes it', async () => {
  const a = await athlete('l1@x.test', ME);
  const b = await athlete('l2@x.test', BRO);
  await a('POST', '/api/household', { name: 'بيت' });
  await b('POST', '/api/household/join', { code: (await a('POST', '/api/household/invite')).body.code });
  assert.equal((await a('POST', '/api/household/leave')).status, 200);
  const sb = (await b('GET', '/api/household')).body.household;
  assert.equal(sb.members.length, 1);
  assert.equal(sb.manager, true);
  assert.equal((await b('DELETE', '/api/account', { password: 'longpass1', confirm: 'DELETE' })).status, 200);
  assert.equal(app.db.householdOf(b.id), null);
});
