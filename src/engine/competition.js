'use strict';
// Championship nutrition: loading days before, a race-day timeline built from the exact race
// times (pre-race meal, pre-race snack, between races, recovery), and a recovery day after.
// No energy deficit is applied on these days: performance comes first.
const { nutrientsFor, sum, FOODS, listRecipes } = require('./meals');
const { SPORT_NUTRITION } = require('./energy');
const { addDays, parseDate, diffDays } = require('./dates');
const { toMin, fmtMin, DAY_AR } = require('./weekplan');
const { round } = require('./calculator');

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateCompetition(b, today) {
  const errors = {};
  const v = { name: String(b?.name || 'بطولة').slice(0, 80), raceDurationMin: Number(b?.raceDurationMin) || 5, days: [] };
  if (!(v.raceDurationMin >= 1 && v.raceDurationMin <= 600)) errors.raceDurationMin = 'مدة السباق من 1 إلى 600 دقيقة.';
  const days = Array.isArray(b?.days) ? b.days : [];
  if (!days.length) errors.days = 'ضيف يوم سباق واحد على الأقل.';
  if (days.length > 7) errors.days = 'أقصى حاجة 7 أيام بطولة.';
  for (const [i, d] of days.entries()) {
    if (!parseDate(d?.date)) { errors[`days.${i}`] = 'تاريخ غير صحيح.'; continue; }
    const races = (Array.isArray(d.races) ? d.races : []).filter((t) => HM.test(t)).sort();
    if (!races.length) { errors[`days.${i}`] = 'اكتب ميعاد سباق واحد على الأقل (HH:MM).'; continue; }
    if (races.length > 8) { errors[`days.${i}`] = 'أقصى حاجة 8 سباقات في اليوم.'; continue; }
    v.days.push({ date: d.date, races: [...new Set(races)] });
  }
  v.days.sort((a, c) => (a.date < c.date ? -1 : 1));
  if (v.days.length > 1 && diffDays(v.days[0].date, v.days[v.days.length - 1].date) > 10) errors.days = 'أيام البطولة لازم تكون متقاربة (أقل من 10 أيام).';
  if (today && v.days.length && v.days[v.days.length - 1].date < today) errors.days = 'البطولة دي خلصت؛ اكتب مواعيد بطولة جاية.';
  return { value: v, errors };
}

// Simple, low-fibre foods that are easy on the stomach near races. Picked in order, skipping avoided ones.
const CARBS_LIGHT = ['banana', 'dates', 'white_bread', 'honey', 'jam'];
const CARBS_MEAL = ['rice_white_cooked', 'white_bread', 'pasta_cooked', 'potato_boiled'];
const CARBS_MEAL_ALT = ['pasta_cooked', 'white_bread', 'rice_white_cooked', 'potato_boiled'];
const CARBS_BREAKFAST = ['white_bread', 'banana', 'honey', 'dates'];
const PROTEIN_LIGHT = ['greek_yogurt', 'areesh_cheese', 'egg_white', 'chicken_breast_cooked', 'tuna_water'];
const PROTEIN_MEAL = ['chicken_breast_cooked', 'tilapia_cooked', 'egg_white', 'tuna_water', 'areesh_cheese'];

function okFood(id, ctx) {
  const f = FOODS.get(id);
  if ((f.allergens || []).some((a) => ctx.avoid.includes(a))) return false;
  if (f.proteinType && ctx.proteins && ctx.proteins[f.proteinType] === -1) return false;
  return true;
}
const r10 = (g) => Math.max(0, Math.round(g / 10) * 10);

function compose({ carbG, proteinG, fatG = 0, carbList, proteinList, extra = [] }, ctx) {
  const items = extra.map(([id, g]) => nutrientsFor(id, g));
  let t = sum(items);
  if (proteinG > 0) {
    const pid = proteinList.find((id) => okFood(id, ctx));
    if (pid) { const g = r10(((proteinG - t.protein) / FOODS.get(pid).protein) * 100); if (g >= 20) items.push(nutrientsFor(pid, g)); }
  }
  t = sum(items);
  const carbs = carbList.filter((id) => okFood(id, ctx));
  // Split carbohydrate across up to two sources for a realistic plate.
  const need = carbG - t.carb;
  if (need > 8 && carbs.length) {
    const split = carbs.length > 1 && need > 50 ? [0.7, 0.3] : [1];
    split.forEach((share, i) => {
      const id = carbs[i];
      const g = id === 'honey' || id === 'jam' ? Math.min(30, r10((need * share / FOODS.get(id).carb) * 100) || 10) : r10((need * share / FOODS.get(id).carb) * 100);
      if (g > 0) items.push(nutrientsFor(id, g));
    });
  }
  if (fatG > 0) { const g = Math.round(fatG / 5) * 5; if (g > 0) items.push(nutrientsFor('olive_oil', g)); }
  return { items, totals: sum(items) };
}

function sportsDrink(ml, ctx) {
  const r = listRecipes().recipes.find((x) => x.id === 'drink_sports_home');
  const k = ml / 576; // the recipe makes ~576 ml
  const items = r.items.map((i) => nutrientsFor(i.foodId, i.grams * k));
  return { items, totals: sum(items) };
}

function meal(time, label, kind, part, notes = []) {
  return { time: fmtMin(time), timeMin: time, label, kind, items: part.items, totals: part.totals, notes };
}

function raceDay(day, ctx) {
  const w = ctx.weightKg;
  const dur = ctx.raceDurationMin;
  const races = day.races.map(toMin);
  const meals = [];
  const wake = Math.min(toMin(ctx.wakeTime), races[0] - 150);
  const first = races[0];
  // Pre-race meal: 3–4 h before when possible; smaller if the race is early.
  const preTime = Math.max(wake + 15, first - 210);
  const hoursBefore = (first - preTime) / 60;
  const preCarb = Math.round(w * (hoursBefore >= 3 ? 2 : hoursBefore >= 2 ? 1.2 : 0.8));
  meals.push(meal(preTime, 'وجبة قبل السباق', 'pre_meal',
    compose({ carbG: preCarb, proteinG: Math.round(w * 0.25), carbList: hoursBefore >= 2.5 ? CARBS_MEAL : CARBS_LIGHT, proteinList: PROTEIN_LIGHT }, ctx),
    [`قبل أول سباق بـ ${round(hoursBefore, 1)} ساعة: كربوهيدرات سهلة الهضم، دهون وألياف قليلة. متجربش أكل جديد يوم السباق.`, `اشرب حوالي ${Math.round(w * 6)} مل ماء أو مشروب خلال الساعات اللي قبل السباق.`]));
  if (first - preTime >= 150) {
    meals.push(meal(first - 60, 'سناك قبل السباق', 'pre_snack',
      compose({ carbG: Math.round(w * 0.5), proteinG: 0, carbList: CARBS_LIGHT, proteinList: [] }, ctx), ['30–60 دقيقة قبل السباق: كربوهيدرات سريعة وبس.']));
  }
  for (let i = 0; i < races.length; i++) {
    const end = races[i] + dur;
    const next = races[i + 1];
    if (next != null) {
      const gap = next - end;
      if (gap < 60) {
        meals.push(meal(end + 5, `بين السباق ${i + 1} و${i + 2}`, 'between', sportsDrink(gap < 30 ? 250 : 400, ctx),
          [`الفاصل ${gap} دقيقة: رشفات من المشروب الرياضي البيتي، من غير أكل تقيل.`]));
      } else if (gap <= 150) {
        const part = compose({ carbG: Math.round(w * 0.6), proteinG: Math.round(w * 0.1), carbList: CARBS_LIGHT, proteinList: PROTEIN_LIGHT }, ctx);
        meals.push(meal(end + 15, `بين السباق ${i + 1} و${i + 2}`, 'between', part, [`الفاصل ${Math.round(gap / 6) / 10} ساعة: سناك كربوهيدرات خفيف بعد السباق على طول، وماء أو مشروب.`]));
      } else {
        const part = compose({ carbG: Math.round(w * 1), proteinG: Math.round(w * 0.3), carbList: CARBS_MEAL, proteinList: PROTEIN_MEAL }, ctx);
        meals.push(meal(end + 30, `وجبة بين السباق ${i + 1} و${i + 2}`, 'between', part, [`الفاصل ${Math.round(gap / 6) / 10} ساعة: وجبة استشفاء خفيفة، وتخلص قبل السباق الجاي بساعتين على الأقل.`]));
        if (gap > 240) meals.push(meal(next - 60, `سناك قبل السباق ${i + 2}`, 'pre_snack', compose({ carbG: Math.round(w * 0.4), proteinG: 0, carbList: CARBS_LIGHT, proteinList: [] }, ctx)));
      }
    } else {
      // Recovery after the last race: ~1 g/kg carbohydrate + ~0.3 g/kg protein within 30–60 min.
      const anotherDay = ctx.nextDayHasRaces;
      const recovery = okFood('greek_yogurt', ctx)
        ? compose({ carbG: Math.round(w * 1), proteinG: Math.round(w * 0.3), carbList: ['banana', 'dates', 'honey'], proteinList: ['greek_yogurt'], extra: [['milk_1pct', 200]] }, ctx)
        : compose({ carbG: Math.round(w * 1), proteinG: Math.round(w * 0.3), carbList: ['white_bread', 'banana', 'dates'], proteinList: PROTEIN_LIGHT }, ctx);
      meals.push(meal(end + 30, 'استشفاء بعد آخر سباق', 'recovery', recovery,
        [anotherDay ? 'عندك سباقات بكرة: الاستشفاء السريع هنا مهم جدًا.' : 'اشرب حوالي مرة ونص قد الوزن اللي خسرته في السباقات (من الوزن قبل وبعد).']));
    }
  }
  // The rest of the day's carbohydrate and protein, spread over the remaining meals (every ~3.5 h).
  const last = races[races.length - 1] + dur;
  let sleep = toMin(ctx.sleepTime); if (sleep < last) sleep += 1440;
  const dayCarb = Math.round(w * ctx.raceDayCarbPerKg);
  const dayProtein = Math.round(w * 1.8);
  const soFar = sum(meals.flatMap((m) => m.items));
  const times = [];
  for (let t = last + 150; t <= sleep - 120; t += 210) times.push(t);
  if (!times.length) times.push(Math.max(last + 90, sleep - 120));
  const restC = Math.max(w * 1, dayCarb - soFar.carb);
  const restP = Math.max(w * 0.4, dayProtein - soFar.protein);
  times.forEach((t, i) => {
    const lastOne = i === times.length - 1;
    meals.push(meal(t, lastOne ? 'العشا' : i === 0 ? 'الغدا' : 'وجبة خفيفة', lastOne ? 'dinner' : 'meal',
      compose({ carbG: restC / times.length, proteinG: restP / times.length, fatG: 8, carbList: i % 2 ? CARBS_MEAL_ALT : CARBS_MEAL, proteinList: PROTEIN_MEAL, extra: [['tomato', 100]] }, ctx),
      lastOne ? [ctx.nextDayHasRaces ? 'عشا عالي كربوهيدرات عشان سباقات بكرة، ونوم بدري.' : 'عشا عادي متوازن.'] : []));
  });
  meals.sort((a, b) => a.timeMin - b.timeMin);
  return meals;
}

function fixedDay(kind, ctx) {
  const w = ctx.weightKg;
  const wake = toMin(ctx.wakeTime);
  let sleep = toMin(ctx.sleepTime); if (sleep <= wake) sleep += 1440;
  const carbPerKg = kind === 'load1' ? ctx.loadCarbPerKg : kind === 'load2' ? Math.max(5, ctx.loadCarbPerKg - 1.5) : 6;
  const carbs = Math.round(w * carbPerKg);
  const protein = Math.round(w * (kind === 'recovery' ? 2 : 1.6));
  const times = [wake + 30, wake + 270, wake + 510, sleep - 150];
  const shares = [0.25, 0.3, 0.15, 0.3];
  const lists = [CARBS_BREAKFAST, CARBS_MEAL, CARBS_LIGHT, CARBS_MEAL_ALT];
  const plists = [PROTEIN_LIGHT, PROTEIN_MEAL, PROTEIN_LIGHT, PROTEIN_MEAL];
  const labels = ['الفطار', 'الغدا', 'سناك', 'العشا'];
  return times.map((t, i) => meal(t, labels[i], i % 2 ? 'meal' : 'snack',
    compose({ carbG: Math.round(carbs * shares[i]), proteinG: Math.round(protein * shares[i]), fatG: i % 2 ? (kind === 'recovery' ? 12 : 8) : 0, carbList: lists[i], proteinList: plists[i], extra: i === 1 || i === 3 ? [['tomato', 80]] : [] }, ctx)));
}

function buildCompetitionPlan(input, athlete, prefs = {}) {
  const sport = SPORT_NUTRITION[athlete.sport] || SPORT_NUTRITION.general;
  const longEvent = sport.kind === 'endurance' && input.raceDurationMin >= 90;
  const ctx = {
    weightKg: athlete.weightKg, raceDurationMin: input.raceDurationMin,
    wakeTime: prefs.wakeTime || '07:00', sleepTime: prefs.sleepTime || '23:00',
    avoid: prefs.avoid || [], proteins: prefs.proteins || {},
    loadCarbPerKg: longEvent ? 9 : sport.kind === 'endurance' || sport.kind === 'intermittent' ? 7 : 6,
    raceDayCarbPerKg: longEvent ? 8 : 7,
  };
  const first = input.days[0].date;
  const last = input.days[input.days.length - 1].date;
  const out = [];
  const push = (date, phase, phaseAr, meals, notes) => {
    const totals = sum(meals.flatMap((m) => m.items));
    out.push({ date, dayAr: DAY_AR[parseDate(date).getUTCDay()], phase, phaseAr, meals, totals, notes });
  };
  push(addDays(first, -2), 'load2', 'قبل البطولة بيومين', fixedDay('load2', ctx),
    [longEvent ? 'بداية تحميل الكربوهيدرات للسباقات الطويلة.' : 'كربوهيدرات أعلى من العادي، والتمرين خفيف (تهدئة).', 'مفيش عجز سعرات من النهارده لحد آخر البطولة.']);
  push(addDays(first, -1), 'load1', 'قبل البطولة بيوم', fixedDay('load1', ctx),
    ['أكل قليل الألياف والدهون عشان المعدة تبقى خفيفة يوم السباق.', 'اشرب كويس طول اليوم، ولون البول فاتح.', 'نام بدري وجهّز أكل يوم السباق من دلوقتي.']);
  input.days.forEach((d, i) => {
    ctx.nextDayHasRaces = !!input.days[i + 1] && diffDays(d.date, input.days[i + 1].date) === 1;
    push(d.date, 'race', `يوم سباق ${i + 1}`, raceDay(d, ctx), [`السباقات: ${d.races.join('، ')} (حوالي ${input.raceDurationMin} دقيقة لكل سباق).`, 'كُل بس الأكل اللي جربته قبل كده في التمرين.']);
  });
  push(addDays(last, 1), 'recovery', 'يوم الاستشفاء بعد البطولة', fixedDay('recovery', ctx),
    ['بروتين أعلى للتعافي وكربوهيدرات لتعويض المخزون. خطة خسارة الدهون ترجع من بكرة.']);
  return {
    name: input.name, sport: athlete.sport, sportAr: sport.ar, weightKg: athlete.weightKg, raceDurationMin: input.raceDurationMin,
    days: out, input,
    principles: [
      'أيام البطولة الأولوية للأداء: مفيش عجز سعرات من قبلها بيومين لحد بعدها بيوم.',
      `الكربوهيدرات اليوم اللي قبل البطولة حوالي ${ctx.loadCarbPerKg} جم/كجم${longEvent ? ' (تحميل للسباقات الأطول من 90 دقيقة)' : ''}، وفي يوم السباق حوالي ${ctx.raceDayCarbPerKg} جم/كجم.`,
      'قرب السباقات: أكل سهل الهضم، قليل الألياف والدهون، ومجرب قبل كده.',
      'بين السباقات القريبة: سوائل ومشروب رياضي بيتي؛ والفواصل الأطول سناك أو وجبة خفيفة حسب الوقت.',
      'الحسابات تقديرية؛ عدّل الكميات حسب تجربتك في التمرين، وراجع أخصائي التغذية في البطولات الكبيرة.',
    ],
  };
}

module.exports = { validateCompetition, buildCompetitionPlan };
