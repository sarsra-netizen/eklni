'use strict';
// Independent-value tests: every expected number below is copied from a reference table or
// computed by hand from the formula printed in the reference — never taken from the app's output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { driFor, compareIntake } = require('../src/engine/dri');
const { sweatRate, assessSession, wutCheck, validateSession } = require('../src/engine/hydration');
const { eaStatus, buildPlan, energyNeeds, fatFreeMass } = require('../src/engine/energy');
const { screen, validateScreening } = require('../src/engine/screening');
const refs = require('../src/data/references.json');

// ---- DRI: DGA 2015–2020 Appendix 7 Table A7-1 (RDA) and ANHM 8th ed. UL tables ----
test('RDA/UL lookups match the reference tables', () => {
  const f16 = driFor({ age: 16, sex: 'female' });
  assert.equal(f16.ironMg.rda, 15); assert.equal(f16.ironMg.ul, 45);
  assert.equal(f16.calciumMg.rda, 1300); assert.equal(f16.calciumMg.ul, 3000);
  assert.equal(f16.vitDIU.rda, 600); assert.equal(f16.vitDIU.ul, 4000);
  const m16 = driFor({ age: 16, sex: 'male' });
  assert.equal(m16.ironMg.rda, 11);
  const f25 = driFor({ age: 25, sex: 'female' });
  assert.equal(f25.ironMg.rda, 18); assert.equal(f25.calciumMg.rda, 1000); assert.equal(f25.calciumMg.ul, 2500);
  const m25 = driFor({ age: 25, sex: 'male' });
  assert.equal(m25.ironMg.rda, 8);
  const c12 = driFor({ age: 12, sex: 'female' });
  assert.equal(c12.ironMg.rda, 8); assert.equal(c12.ironMg.ul, 40); assert.equal(c12.calciumMg.rda, 1300);
  const f55 = driFor({ age: 55, sex: 'female' });
  assert.equal(f55.ironMg.rda, 8); assert.equal(f55.calciumMg.rda, 1200); assert.equal(f55.calciumMg.ul, 2000);
  const m75 = driFor({ age: 75, sex: 'male' });
  assert.equal(m75.vitDIU.rda, 800); assert.equal(m75.calciumMg.rda, 1200);
  // 600 IU = 15 µg; 4000 IU = 100 µg (1 µg = 40 IU)
  assert.equal(f25.vitDIU.rdaUg, 15); assert.equal(f25.vitDIU.ulUg, 100);
  assert.equal(driFor({ age: 25 }), null);
});

test('intake comparison reports unknown as unknown, never as zero, and flags UL', () => {
  const d = driFor({ age: 25, sex: 'female' });
  const r = compareIntake({ ironMg: 9, calciumMg: null, vitDIU: 5000 }, d);
  assert.equal(r.ironMg.status, 'below_rda'); assert.equal(r.ironMg.pctOfRda, 50);
  assert.equal(r.calciumMg.status, 'unknown'); assert.equal(r.calciumMg.value, null);
  assert.equal(r.vitDIU.status, 'above_ul');
  assert.equal(compareIntake({ ironMg: 9, calciumMg: null, vitDIU: 100 }, d, { complete: false }).ironMg.status, 'incomplete_data');
});

// ---- hydration (mass balance; broad2019 ch.3 & 5; barclay2012 ch.2) ----
test('sweat rate by mass balance (hand-computed)', () => {
  // pre 60, post 59.1, drank 0.4 L, urine 0.1 L, 75 min → (0.9 + 0.4 − 0.1) / 1.25 = 0.96 L/h
  const r = sweatRate({ preKg: 60, postKg: 59.1, fluidL: 0.4, urineL: 0.1, durationMin: 75 });
  assert.equal(r.sweatLossL, 1.2);
  assert.equal(r.sweatRateLph, 0.96);
  assert.equal(r.bodyMassChangePct, -1.5); // −0.9 / 60
  assert.equal(r.replacedPct, 33);         // 0.4 / 1.2
});

test('≥2 % loss is flagged and rehydration is 125–150 % of the deficit', () => {
  // pre 50, post 48.9 → −2.2 %; deficit 1.1 kg → 1.375–1.65 L → shown as 1.4–1.7 (1 decimal)
  const a = assessSession({ preKg: 50, postKg: 48.9, fluidL: 0, urineL: 0, durationMin: 90 });
  assert.ok(a.flags.some((f) => f.code === 'LOSS_OVER_2PCT'));
  assert.ok(a.advice.some((t) => t.includes('1.4–1.7 لتر')), a.advice.join(' | '));
  assert.ok(a.advice.some((t) => t.includes('4–8 جم')), 'sessions > 60 min mention the sports-drink composition');
});

test('weight gain during a session is flagged as over-drinking (hyponatraemia risk)', () => {
  const a = assessSession({ preKg: 55, postKg: 55.4, fluidL: 1.5, urineL: 0, durationMin: 60 });
  assert.ok(a.flags.some((f) => f.code === 'GAINED_WEIGHT'));
});

test('implausible entries are rejected', () => {
  assert.ok(validateSession({ date: '2026-10-01', preKg: 60, postKg: 59, durationMin: 5 }).errors.durationMin);
  assert.ok(validateSession({ date: '2026-10-01', preKg: 60, postKg: 52, durationMin: 60 }).errors.postKg);
  assert.ok(validateSession({ date: '2026-10-01', preKg: 60, postKg: 61, fluidL: 0, durationMin: 60 }).errors.postKg, 'negative sweat');
});

test('W-U-T: two indicators likely, three very likely (broad2019 Fig 5.1)', () => {
  assert.equal(wutCheck({ weightDown: true, urineDark: true, thirsty: false }).level, 'likely');
  assert.equal(wutCheck({ weightDown: true, urineDark: true, thirsty: true }).level, 'very_likely');
  assert.equal(wutCheck({}).level, 'unlikely');
});

// ---- energy availability (broad2019 ch.4 §4.2) ----
test('EA bands: ≥45 adequate, 30–45 reduced, <30 low', () => {
  assert.equal(eaStatus(45).band, 'adequate');
  assert.equal(eaStatus(44.9).band, 'reduced');
  assert.equal(eaStatus(30).band, 'reduced');
  assert.equal(eaStatus(29.9).band, 'low');
});

test('EA in the plan equals (intake − exercise energy) / FFM', () => {
  const p = { sex: 'female', age: 22, heightCm: 165, weightKg: 60, bodyFatPct: 22, bodyFatMethod: 'skinfold',
    sport: 'swimming', sessionsPerWeek: 6, minutesPerSession: 90, intensity: 'moderate', activityLevel: 'light' };
  const plan = buildPlan(p, 0.3);
  // FFM = 60 × 0.78 = 46.8 kg
  assert.equal(fatFreeMass(p).kg, 46.8);
  const n = energyNeeds(p);
  // net exercise = (7 − 1) × 60 × 1.5 h × 6 / 7 = 462.857… kcal/day
  assert.equal(n.exercise.dailyAvgKcal, 463);
  const expected = (plan.intakeAvg - 462.857) / 46.8;
  assert.ok(Math.abs(plan.energyAvailability - expected) < 0.2, `${plan.energyAvailability} vs ${expected}`);
  assert.ok(plan.energyAvailability >= 30, 'guard keeps EA ≥ 30');
  assert.ok(plan.energyAvailabilityStatus);
});

// ---- screening: refer, never diagnose ----
test('screening: holds and referral reasons', () => {
  const ok = validateScreening({ consent: true, menstrual: 'regular' }).value;
  assert.equal(screen(ok, { age: 22, sex: 'female' }).deficitAllowed, true);
  assert.equal(screen(null, { age: 22, sex: 'female' }).hold, true);
  assert.equal(screen({ ...ok, eating: ['compensate'] }, { age: 22, sex: 'female' }).hold, true);
  assert.equal(screen({ ...ok, boneStressInjury: true }, { age: 22, sex: 'male' }).hold, true);
  // one or two non-bone signs are amber notes; three signs hold the plan and refer to a doctor (reviewer decision 2026-10-22)
  assert.equal(screen({ ...ok, persistentFatigue: true }, { age: 22, sex: 'male' }).hold, false);
  const two = screen({ ...ok, persistentFatigue: true, recurrentIllness: true }, { age: 22, sex: 'male' });
  assert.equal(two.hold, false); assert.ok(two.flags.some((f) => f.code === 'REDS_TWO'));
  const three = screen({ ...ok, persistentFatigue: true, recurrentIllness: true, performanceDrop: true }, { age: 22, sex: 'male' });
  assert.equal(three.hold, true); assert.ok(three.flags.some((f) => f.code === 'REDS_SIGNS')); assert.match(three.referral, /طبيب/);
  // professional clearance lifts a hold, but never for a minor or an urgent eating flag
  assert.equal(screen({ ...ok, conditions: ['diabetes'], professionalClearance: true }, { age: 30, sex: 'male' }).hold, false);
  assert.equal(screen({ ...ok, professionalClearance: true }, { age: 16, sex: 'male' }).hold, true);
  assert.equal(screen({ ...ok, eating: ['purge'], professionalClearance: true }, { age: 25, sex: 'female' }).hold, true);
  // no flag text claims a diagnosis
  const all = screen({ ...ok, menstrual: 'absent', eating: ['preoccupied'], boneStressInjury: true, conditions: ['heart'], impairment: 'sci', supplements: true }, { age: 20, sex: 'female' });
  for (const f of all.flags) assert.doesNotMatch(f.text, /عندك (RED-S|اضطراب|فقر دم|نقص)/);
});

test('every reference id used in code exists in the registry', () => {
  const ids = new Set(refs.references.map((r) => r.id));
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'engine');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/'((?:broad|barclay|gropper|dga|kealy|schlenker|bernstein|acs|wku|issa|roth|hse|nasm)[a-z0-9_]*)'/g)) {
      assert.ok(ids.has(m[1]), `${f}: unknown reference id ${m[1]}`);
    }
  }
  for (const r of refs.references) assert.ok(!('doi' in r), 'no DOIs are stored (none were verified)');
});
