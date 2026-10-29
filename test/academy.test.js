'use strict';
// Roles, academy isolation and consent — all enforced on the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-acad-'));
let app, base;
test.before(async () => {
  app = createApp({ dbPath: path.join(dir, 't.db'), today: () => '2026-10-29', trialDays: 3650 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(() => { app.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

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
async function user(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'longpass1' });
  c.id = r.body.user.id;
  return c;
}
const CLEAR = { consent: true, menstrual: 'regular', eating: [], conditions: [], impairment: 'none' };
const GOAL = { sex: 'female', age: 22, heightCm: 168, currentWeight: 66, targetWeight: 62, bodyFatPct: 26, bodyFatMethod: 'skinfold',
  startDate: '2026-10-01', sport: 'fin_swimming', swimDiscipline: 'mono', sessionsPerWeek: 6, minutesPerSession: 90 };

let A, admin, coach, diet, adult, minor, parent, outsider, otherAdmin, B;

test('setup: academy, invites by role, joining', async () => {
  admin = await user('admin@a.com'); coach = await user('coach@a.com'); diet = await user('diet@a.com');
  adult = await user('adult@a.com'); minor = await user('minor@a.com'); parent = await user('parent@a.com'); outsider = await user('x@b.com');
  const r = await admin('POST', '/api/academies', { name: 'Aqua Fitness', displayName: 'م. أحمد' });
  assert.equal(r.status, 201);
  A = r.body.academy.id;
  const inv = async (who, role, extra = {}) => (await who('POST', `/api/academies/${A}/invites`, { role, ...extra }));
  const join = async (who, code, displayName) => who('POST', '/api/invites/accept', { code, displayName });
  assert.equal((await join(coach, (await inv(admin, 'coach')).body.code, 'كابتن سارة')).status, 200);
  assert.equal((await join(diet, (await inv(admin, 'dietitian')).body.code, 'د. منى')).status, 200);
  // since 0.5.0 the clinical view also needs a verified professional with an active PRO subscription
  // (owner decision, simulated here as scripts/owner + owner panel would do)
  const pro = require('../src/pro');
  assert.equal((await diet('POST', '/api/pro/apply', { licenseNo: 'TEST-123', issuer: 'Test syndicate' })).status, 200);
  pro.decide(app.db, 0, diet.id, 'verified', 'test');
  pro.extend(app.db, 0, diet.id, 1, '2026-10-29');
  // coach may invite athletes but not staff
  assert.equal((await inv(coach, 'dietitian')).status, 403);
  const c1 = (await inv(coach, 'athlete')).body.code;
  assert.equal((await join(adult, c1, 'نور')).status, 200);
  // one-time code
  assert.equal((await join(minor, c1, 'x')).status, 400);
  assert.equal((await join(minor, (await inv(coach, 'athlete')).body.code, 'يوسف')).status, 200);
  // parent invite must name an athlete of this academy
  assert.equal((await inv(admin, 'parent', { athleteId: outsider.id })).status, 400);
  assert.equal((await join(parent, (await inv(admin, 'parent', { athleteId: minor.id })).body.code, 'والد يوسف')).status, 200);
  // athletes set goals + screenings
  for (const [who, extra] of [[adult, {}], [minor, { age: 15, sex: 'male' }]]) {
    await who('PUT', '/api/screening', CLEAR);
    await who('POST', '/api/goal', { ...GOAL, ...extra });
    await who('POST', '/api/hydration', { date: '2026-10-20', preKg: 66, postKg: 65.4, fluidL: 0.4, durationMin: 90 });
  }
  otherAdmin = await user('admin@b.com');
  B = (await otherAdmin('POST', '/api/academies', { name: 'Other club' })).body.academy.id;
});

test('isolation: outsiders and other academies see nothing', async () => {
  assert.equal((await outsider('GET', `/api/academies/${A}/athletes`)).status, 404);
  assert.equal((await outsider('GET', `/api/academies/${A}/athletes/${adult.id}`)).status, 404);
  assert.equal((await otherAdmin('GET', `/api/academies/${A}/members`)).status, 404);
  // a real athlete id but through the wrong academy
  assert.equal((await otherAdmin('GET', `/api/academies/${B}/athletes/${adult.id}`)).status, 404);
  assert.equal((await outsider('POST', `/api/academies/${A}/invites`, { role: 'athlete' })).status, 404);
});

test('coach sees training & wellness only — never weight, targets or screening', async () => {
  const v = (await coach('GET', `/api/academies/${A}/athletes/${adult.id}`)).body;
  assert.equal(v.level, 'coach');
  assert.equal(v.sport, 'fin_swimming');
  assert.ok(v.hydration);
  for (const k of ['targets', 'goal', 'weeks', 'screening', 'hydrationLogs', 'holdFlags']) assert.equal(v[k], undefined, k);
  assert.equal(typeof v.needsReview, 'boolean');
  const roster = (await coach('GET', `/api/academies/${A}/athletes`)).body;
  assert.equal(roster.athletes.length, 2);
  assert.ok(!JSON.stringify(roster).includes('avgWeight'));
});

test('admin sees members (with email) but no health data', async () => {
  const m = (await admin('GET', `/api/academies/${A}/members`)).body.members;
  assert.ok(m.find((x) => x.email === 'adult@a.com'));
  assert.equal((await coach('GET', `/api/academies/${A}/members`)).body.members[0].email, null);
  assert.equal(m.filter((x) => x.userId === admin.id).length, 1, 'one row per person');
  const v = (await admin('GET', `/api/academies/${A}/athletes/${adult.id}`)).body;
  assert.equal(v.level, 'admin');
  assert.equal(v.wellness, undefined); assert.equal(v.hydration, undefined);
  assert.equal((await adult('GET', `/api/academies/${A}/members`)).status, 403);
});

test('dietitian needs the adult athlete\'s consent; only the athlete can give it', async () => {
  assert.equal((await diet('GET', `/api/academies/${A}/athletes/${adult.id}`)).body.level, 'coach');
  assert.equal((await diet('PUT', `/api/academies/${A}/sharing`, { athleteId: adult.id, shareHealth: true })).status, 403);
  assert.equal((await adult('PUT', `/api/academies/${A}/sharing`, { shareHealth: true })).status, 200);
  const v = (await diet('GET', `/api/academies/${A}/athletes/${adult.id}`)).body;
  assert.equal(v.level, 'clinical');
  assert.ok(v.targets && v.weeks && v.screening);
  // coach still sees no health data even after sharing
  assert.equal((await coach('GET', `/api/academies/${A}/athletes/${adult.id}`)).body.targets, undefined);
  await adult('PUT', `/api/academies/${A}/sharing`, { shareHealth: false });
  assert.equal((await diet('GET', `/api/academies/${A}/athletes/${adult.id}`)).body.level, 'coach');
});

test('minor: only the linked parent can consent; parent sees own child only', async () => {
  assert.equal((await minor('PUT', `/api/academies/${A}/sharing`, { shareHealth: true })).status, 403);
  assert.equal((await parent('PUT', `/api/academies/${A}/sharing`, { athleteId: adult.id, shareHealth: true })).status, 403);
  assert.equal((await parent('PUT', `/api/academies/${A}/sharing`, { athleteId: minor.id, shareHealth: true })).status, 200);
  assert.equal((await diet('GET', `/api/academies/${A}/athletes/${minor.id}`)).body.level, 'clinical');
  const pv = (await parent('GET', `/api/academies/${A}/athletes/${minor.id}`)).body;
  assert.equal(pv.level, 'guardian');
  assert.ok(pv.holdFlags.some((f) => f.text.includes('18')), 'parent sees why the plan is on hold');
  assert.equal(pv.screening, undefined, 'raw screening answers are not shown to parents');
  assert.equal(pv.weeks, undefined);
  assert.equal((await parent('GET', `/api/academies/${A}/athletes/${adult.id}`)).status, 404);
  assert.deepEqual((await parent('GET', `/api/academies/${A}/athletes`)).body.athletes.map((a) => a.userId), [minor.id]);
});

test('removal needs admin + confirmation, keeps one admin, and is audited without health data', async () => {
  assert.equal((await coach('DELETE', `/api/academies/${A}/members/${adult.id}`, { confirm: true })).status, 403);
  assert.equal((await admin('DELETE', `/api/academies/${A}/members/${adult.id}`, {})).status, 400);
  assert.equal((await admin('DELETE', `/api/academies/${A}/members/${admin.id}`, { confirm: true })).body.error, 'LAST_ADMIN');
  assert.equal((await admin('DELETE', `/api/academies/${A}/members/${adult.id}`, { confirm: true })).status, 200);
  assert.equal((await coach('GET', `/api/academies/${A}/athletes/${adult.id}`)).status, 404);
  const log = (await admin('GET', `/api/academies/${A}/audit`)).body.log;
  assert.ok(log.some((e) => e.action === 'member_remove'));
  assert.ok(log.some((e) => e.action.startsWith('view_athlete')));
  assert.ok(!/kcal|weight|menstrual|screening/i.test(JSON.stringify(log)));
  assert.equal((await coach('GET', `/api/academies/${A}/audit`)).status, 403);
});
