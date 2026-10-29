'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateWeekPlan, validatePrefs, daySlots, addExtra, removeExtra, toMin } = require('../src/engine/weekplan');
const { validateCompetition, buildCompetitionPlan } = require('../src/engine/competition');
const { buildPlan } = require('../src/engine/energy');
const { recommendRate } = require('../src/engine/rate');
const { FOODS } = require('../src/engine/meals');

const T = { trainingDay: { kcal: 2900, proteinG: 164, carbG: 380, fatG: 70, fiberG: 40 }, restDay: { kcal: 2200, proteinG: 164, carbG: 220, fatG: 60, fiberG: 30 } };
const ATH = { sport: 'swimming', sessionsPerWeek: 5, trainingDays: 5, minutesPerSession: 90, weightKg: 75 };
const prefs = (b) => { const v = validatePrefs(b, { minutesPerSession: 90 }); assert.deepEqual(v.errors, {}); return v.value; };
const plan = (b, seed = 1) => generateWeekPlan({ targets: T, prefs: prefs(b), startDate: '2026-10-24', seed, athlete: ATH });
const items = (m) => (m.empty || m.free ? [] : [...m.recipeItems, ...m.extras.flatMap((e) => e.items)]);

test('exact schedule validation', () => {
  assert.ok(validatePrefs({ schedule: { 1: [{ start: '25:00', duration: 60 }] } }).errors['schedule.1']);
  assert.ok(validatePrefs({ schedule: { 1: [{ start: '08:00', duration: 60 }, { start: '12:00', duration: 60 }, { start: '18:00', duration: 60 }] } }).errors['schedule.1']);
  assert.ok(validatePrefs({ schedule: { 1: [{ start: '08:00', duration: 90 }, { start: '09:45', duration: 60 }] } }).errors['schedule.1'], 'needs 60 min between sessions');
  const ok = validatePrefs({ schedule: { 1: [{ start: '17:00', duration: 90 }, { start: '07:00', duration: 60 }] } });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value.schedule[1][0].start, '07:00', 'sorted by time');
  // short awake window: the error asks for fewer meals, not more sleep restriction
  assert.ok(validatePrefs({ wakeTime: '07:00', sleepTime: '12:00' }).errors.mealsPerDay);
  // long sleep is allowed (12 h sleep, 12 h awake) — no minimum-awake rule anymore
  assert.deepEqual(validatePrefs({ wakeTime: '09:00', sleepTime: '21:00' }).errors, {});
  assert.deepEqual(validatePrefs({ wakeTime: '10:00', sleepTime: '20:00', mealsPerDay: 4 }).errors, {});
  const { sleepAdvice } = require('../src/engine/weekplan');
  // kealy2023: 13–18 y → 8–10 h; 23:30 → 06:00 = 6.5 h
  const a = sleepAdvice({ wakeTime: '06:00', sleepTime: '23:30' }, 16);
  assert.equal(a.hours, 6.5); assert.deepEqual(a.recommended, [8, 10]); assert.ok(a.notes.length === 2);
  assert.equal(sleepAdvice({ wakeTime: '07:00', sleepTime: '22:00' }, 25).notes.length, 0);
});

test('meal times: nothing during a session, a pre meal before and a post meal after each session', () => {
  const cases = [
    [{ start: '06:00', duration: 90 }], [{ start: '16:00', duration: 120 }], [{ start: '19:30', duration: 90 }],
    [{ start: '06:00', duration: 75 }, { start: '17:30', duration: 90 }], [{ start: '10:00', duration: 90 }, { start: '15:00', duration: 60 }],
  ];
  for (const meals of [3, 4, 5, 6]) for (const sessions of cases) {
    const p = prefs({ mealsPerDay: meals, wakeTime: '06:30', sleepTime: '23:00' });
    const { slots } = daySlots(p, sessions, false);
    for (const s of sessions) {
      const st = toMin(s.start), en = st + s.duration;
      assert.ok(slots.every((m) => m.time <= st - 30 || m.time >= en), `meal inside session ${s.start} (${meals} meals)`);
      assert.ok(slots.some((m) => (m.timing === 'pre' || m.timing === 'between') && m.time < st && m.time >= st - 240), `pre for ${s.start}`);
      assert.ok(slots.some((m) => (m.timing === 'post' || m.timing === 'between') && m.time >= en && m.time <= en + 90), `post for ${s.start}`);
    }
    const times = slots.map((m) => m.time);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  }
});

test('two sessions a day: higher targets than one session, which is higher than rest', () => {
  const p = plan({ schedule: { 6: [{ start: '07:00', duration: 90 }, { start: '17:00', duration: 90 }], 0: [{ start: '17:00', duration: 90 }] } });
  const dbl = p.days.find((d) => d.weekday === 6), one = p.days.find((d) => d.weekday === 0), rest = p.days.find((d) => d.weekday === 1);
  assert.equal(dbl.sessions.length, 2);
  assert.ok(dbl.targets.carbG > one.targets.carbG && one.targets.carbG > rest.targets.carbG);
  assert.equal(dbl.targets.proteinG, one.targets.proteinG);
  assert.ok(dbl.meals.every((m) => m.time && /^\d\d:\d\d$/.test(m.time)));
});

test('Ramadan: all meals between iftar and suhoor; training while fasting gets a note', () => {
  const p = plan({ ramadan: { enabled: true, iftarTime: '17:40', suhoorTime: '04:10' }, schedule: { 0: [{ start: '16:00', duration: 60 }], 2: [{ start: '21:30', duration: 90 }] } });
  for (const d of p.days) {
    assert.ok(d.ramadan);
    for (const m of d.meals) assert.ok(m.timeMin >= toMin('17:40') && m.timeMin <= toMin('04:10') + 1440, `${m.label} ${m.time}`);
    assert.ok(d.meals.some((m) => m.slot === 'iftar') && d.meals.some((m) => m.ramadan === 'suhoor'));
  }
  assert.ok(p.days.find((d) => d.weekday === 0).notes.some((n) => /صايم/.test(n)));
});

test('fasting days: vegan has no animal foods, fish mode allows fish but no meat/dairy/eggs', () => {
  const v = plan({ fasting: { mode: 'vegan', days: [3, 5] } }, 2);
  for (const d of v.days) for (const m of d.meals) for (const i of items(m)) {
    if (d.weekday === 3 || d.weekday === 5) assert.ok(!FOODS.get(i.foodId).fasting, `${d.dayAr} ${m.recipeAr}: ${i.ar}`);
  }
  assert.ok(v.days.filter((d) => d.fasting === 'vegan').length === 2);
  const f = plan({ fasting: { mode: 'fish', days: [] } }, 3);
  for (const d of f.days) for (const m of d.meals) for (const i of items(m)) assert.notEqual(FOODS.get(i.foodId).fasting, 'animal', `${m.recipeAr}: ${i.ar}`);
});

test('low iron / low vitamin D favour rich meals', () => {
  let base = 0, iron = 0, vd = 0, baseD = 0;
  for (const seed of [1, 2, 3, 4]) {
    base += plan({}, seed).micros.ironRichMeals; iron += plan({ health: { lowIron: true } }, seed).micros.ironRichMeals;
    baseD += plan({}, seed).micros.vitDRichMeals; vd += plan({ health: { lowVitD: true } }, seed).micros.vitDRichMeals;
  }
  assert.ok(iron > base, `${iron} vs ${base}`);
  assert.ok(vd > baseD, `${vd} vs ${baseD}`);
});

// Audit 2026-10-22 (D1): the free meal's allowance used to be added to the day total as if it were food.
// The day total is now calculated food only; the allowance is a separate budget, and planning still accounts for it.
test('free meal on its date; its allowance is a separate budget, never counted as food', () => {
  const p = plan({ freeMeal: { enabled: true, date: '2026-10-26', slot: 'dinner' } });
  const d = p.days.find((x) => x.date === '2026-10-26');
  const fm = d.meals.find((m) => m.free);
  assert.ok(fm && fm.slot === 'dinner');
  assert.equal(p.days.flatMap((x) => x.meals).filter((m) => m.free).length, 1);
  assert.ok(d.freeMealBudget && d.freeMealBudget.kcal === fm.target.kcal);
  const food = d.meals.filter((m) => !m.free && !m.empty).reduce((t, m) => t + m.totals.kcal, 0) + d.added.reduce((t, a) => t + a.totals.kcal, 0);
  assert.ok(Math.abs(d.totals.kcal - food) <= 1, 'day total = calculated food only');
  assert.ok(Math.abs(d.totals.kcal + d.freeMealBudget.kcal - d.targets.kcal) < d.targets.kcal * 0.15, 'food + allowance still near the target');
  assert.equal(d.diff.basis, 'target_minus_free_meal');
  assert.ok(validatePrefs({ freeMeal: { enabled: true } }).errors.freeMeal);
});

test('added drink compensates carbohydrate and removing it restores the day', () => {
  const p = plan({}, 4);
  const before = JSON.parse(JSON.stringify(p.days[1].totals));
  addExtra(p, 1, 'drink_banana_milk', 1, null, true);
  const a = p.days[1].added[0];
  assert.ok(a.compensation && a.compensation.reduce((t, c) => t + c.grams, 0) > 0);
  assert.ok(Math.abs(p.days[1].totals.carb - before.carb) < 12, 'carbs roughly unchanged after compensation');
  assert.ok(p.days[1].totals.protein > before.protein);
  removeExtra(p, 1, a.id);
  assert.equal(p.days[1].added.length, 0);
  assert.equal(Math.round(p.days[1].totals.carb), Math.round(before.carb));
  addExtra(p, 1, 'sauce_tahini_lemon', 1, null, false);
  assert.ok(p.days[1].totals.fat > before.fat);
  assert.throws(() => addExtra(plan({ avoid: ['dairy'] }), 0, 'drink_milk_honey'), /ممنوع/);
  assert.throws(() => addExtra(p, 0, 'kabsa_chicken'), /مشروب أو سناك/);
});

test('sauces are never added automatically; on-demand suggestions respect allergens', () => {
  const p = plan({ avoid: ['dairy', 'sesame'] }, 5);
  const meals = p.days.flatMap((d) => d.meals);
  assert.equal(meals.flatMap((m) => m.sauceIdeas || []).length, 0);
  assert.ok(!meals.some((m) => m.extras.some((e) => e.kind === 'sauce')));
  const { sauceSuggestions } = require('../src/engine/weekplan');
  const lunch = p.days[0].meals.find((m) => m.slot === 'lunch');
  const ids = sauceSuggestions(p, 0, lunch.idx).suggestions.map((s) => s.id);
  assert.ok(ids.length > 0);
  assert.ok(!ids.some((id) => /yogurt|tahini|ranch|mayo|curry|toum/.test(id)), ids.join(','));
});

test('sport and season adjust carbohydrate and the safe rate', () => {
  const base = { sex: 'male', age: 24, heightCm: 178, weightKg: 80, sessionsPerWeek: 5, minutesPerSession: 75, intensity: 'moderate', activityLevel: 'light' };
  const swim = buildPlan({ ...base, sport: 'swimming' }, 0.5);
  const lift = buildPlan({ ...base, sport: 'strength' }, 0.5);
  assert.ok(swim.trainingDay.carbTargetG > lift.trainingDay.carbTargetG);
  assert.ok(lift.proteinPerKg >= 2.0);
  const inSeason = buildPlan({ ...base, sport: 'swimming', seasonPhase: 'in_season' }, 0.5);
  assert.ok(inSeason.trainingDay.carbTargetG > swim.trainingDay.carbTargetG);
  assert.ok(recommendRate({ ...base, sport: 'swimming', seasonPhase: 'in_season' }, '2026-10-21').allowedRangePct[1] <= 0.4);
  assert.ok(recommendRate({ ...base, seasonPhase: 'off_season' }, '2026-10-21').allowedRangePct[1] > 0.4);
});

test('championship: validation and race-day timeline', () => {
  assert.ok(validateCompetition({ days: [] }).errors.days);
  assert.ok(validateCompetition({ days: [{ date: '2026-11-05', races: ['9:30'] }] }).errors['days.0']);
  assert.ok(validateCompetition({ days: [{ date: '2025-01-01', races: ['09:30'] }] }, '2026-10-21').errors.days);
  const v = validateCompetition({ name: 'بطولة', raceDurationMin: 4, days: [{ date: '2026-11-05', races: ['17:00', '09:30', '11:00'] }, { date: '2026-11-06', races: ['10:00', '10:40'] }] }, '2026-10-21');
  assert.deepEqual(v.errors, {});
  const p = buildCompetitionPlan(v.value, { sport: 'fin_swimming', weightKg: 72 }, { avoid: [] });
  assert.deepEqual(p.days.map((d) => d.phase), ['load2', 'load1', 'race', 'race', 'recovery']);
  assert.equal(p.days[0].date, '2026-11-03');
  assert.ok(p.days[1].totals.carb >= 72 * 6, 'loading day carbs');
  const race1 = p.days[2];
  const races = ['09:30', '11:00', '17:00'].map(toMin);
  assert.ok(race1.meals[0].timeMin <= races[0] - 120, 'pre-race meal well before first race');
  for (const r of races) assert.ok(race1.meals.every((m) => m.timeMin <= r - 30 || m.timeMin >= r + 4), 'no meal during or right before a race');
  assert.ok(race1.meals.some((m) => m.kind === 'between'));
  assert.ok(race1.meals.some((m) => m.kind === 'recovery' && m.timeMin > races[2]));
  const short = p.days[3].meals.find((m) => m.kind === 'between');
  assert.ok(short.items.some((i) => i.foodId === 'water'), 'short gap → sports drink');
  const noDairy = buildCompetitionPlan(v.value, { sport: 'fin_swimming', weightKg: 72 }, { avoid: ['dairy'] });
  for (const d of noDairy.days) for (const m of d.meals) for (const i of m.items) assert.ok(!(FOODS.get(i.foodId).allergens || []).includes('dairy'), i.ar);
});
