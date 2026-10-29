'use strict';
const { driFor } = require('./dri');
// Weekly meal plan built from the recipe library, the athlete's daily targets and preferences.
// Meals get real clock times from the exact training schedule (start time + duration) and the
// athlete's wake/sleep times (or iftar/suhoor in Ramadan). Every amount is computed from the food
// database; recipes are portioned to each meal's protein target, a preferred carbohydrate source
// fills the carbohydrate gap and measured oil closes the fat gap.
const { listRecipes, nutrientsFor, sum, FOODS, PROTEIN_TYPES, ALLERGENS } = require('./meals');
const { SPORT_NUTRITION, SEASON_PHASES } = require('./energy');
const { addDays, parseDate } = require('./dates');
const { round } = require('./calculator');

const DAY_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5]; // Egyptian week starts Saturday

const CARB_SOURCES = {
  rice: { food: 'rice_white_cooked', ar: 'أرز (مطبوخ)' },
  bread: { food: 'baladi_bread', ar: 'عيش بلدي' },
  potato: { food: 'potato_boiled', ar: 'بطاطس مسلوقة' },
  pasta: { food: 'pasta_cooked', ar: 'مكرونة (مطبوخة)' },
  sweet_potato: { food: 'sweet_potato_baked', ar: 'بطاطا مشوية' },
  bulgur: { food: 'bulgur_dry', ar: 'برغل (جاف قبل الطهي)' },
};
const PREF_WEIGHT = { '-1': 0, 0: 0.35, 1: 1, 2: 3 };
const MEAL_SETS = { 3: ['breakfast', 'lunch', 'dinner'], 4: ['breakfast', 'lunch', 'snack', 'dinner'], 5: ['breakfast', 'snack', 'lunch', 'snack', 'dinner'], 6: ['breakfast', 'snack', 'lunch', 'snack', 'dinner', 'snack'] };
const SIZE = { breakfast: 1, lunch: 1.25, dinner: 1, snack: 0.45, iftar: 0.4 };
const SLOT_AR = { breakfast: 'الفطار', lunch: 'الغدا', dinner: 'العشا', snack: 'سناك', iftar: 'فطار رمضان (تمر وشوربة)' };
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DEFAULT_PREFS = {
  proteins: { chicken: 1, beef: 1, fish: 1, seafood: 1, eggs: 1, legumes: 1, dairy: 1 },
  carbs: ['rice', 'bread', 'potato', 'pasta', 'sweet_potato'],
  avoid: [],
  mealsPerDay: 4,
  wakeTime: '07:00',
  sleepTime: '23:00',
  schedule: null, // { weekday: [{ start: 'HH:MM', duration: minutes }] } — up to 2 sessions a day
  carbStrategy: 'periodized',
  maxCookMin: null,
  dessertsPerWeek: 1,
  fasting: { mode: 'none', days: [] }, // mode: none | fish | vegan; days empty = every day
  ramadan: { enabled: false, iftarTime: '18:00', suhoorTime: '04:00' },
  health: { lowIron: false, lowVitD: false },
  freeMeal: { enabled: false, date: null, slot: 'dinner' },
};
const OLD_TIME = { morning: '07:00', afternoon: '16:00', evening: '19:00' };

const toMin = (hm) => { const m = HM.exec(hm); return m ? +m[1] * 60 + +m[2] : null; };
const fmtMin = (min) => { const x = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };

function validatePrefs(body, opts = {}) {
  const sessionsPerWeek = typeof opts === 'number' ? opts : opts.sessionsPerWeek || 0;
  const defaultDuration = (typeof opts === 'object' && opts.minutesPerSession) || 60;
  const b = body || {};
  const errors = {};
  const p = JSON.parse(JSON.stringify(DEFAULT_PREFS));
  if (b.proteins && typeof b.proteins === 'object') {
    for (const k of Object.keys(p.proteins)) {
      const v = Number(b.proteins[k]);
      if (b.proteins[k] != null) { if ([-1, 0, 1, 2].includes(v)) p.proteins[k] = v; else errors[`proteins.${k}`] = 'قيمة غير صحيحة.'; }
    }
  }
  if (Object.values(p.proteins).every((v) => v < 0)) errors.proteins = 'لازم يبقى فيه مصدر بروتين واحد على الأقل مسموح.';
  if (Array.isArray(b.carbs)) {
    const c = b.carbs.filter((x) => CARB_SOURCES[x]);
    if (!c.length) errors.carbs = 'اختار مصدر كربوهيدرات واحد على الأقل.'; else p.carbs = [...new Set(c)];
  }
  if (Array.isArray(b.avoid)) p.avoid = [...new Set(b.avoid.filter((x) => ALLERGENS[x]))];
  if (b.mealsPerDay != null) { const m = Number(b.mealsPerDay); if (MEAL_SETS[m]) p.mealsPerDay = m; else errors.mealsPerDay = 'عدد الوجبات من 3 إلى 6.'; }
  for (const k of ['wakeTime', 'sleepTime']) if (b[k] != null) { if (HM.test(b[k])) p[k] = b[k]; else errors[k] = 'الوقت بصيغة HH:MM.'; }
  // Any sleep length is allowed. The only limit: the awake window must fit the chosen number of meals
  // (first meal 30 min after waking, ≥90 min between meals, last one ≥75 min before sleep — app rule).
  const awake = (toMin(p.sleepTime) - toMin(p.wakeTime) + 1440) % 1440;
  const needAwake = 30 + (p.mealsPerDay - 1) * 90 + 75;
  if (awake === 0) errors.sleepTime = 'ميعاد النوم هو نفس ميعاد الصحيان.';
  else if (awake < needAwake) errors.mealsPerDay = `وقت صحيانك ${Math.round(awake / 6) / 10} ساعة بس؛ ده ما يكفيش ${p.mealsPerDay} وجبات (محتاج ${Math.ceil(needAwake / 60)} ساعات على الأقل). قلل عدد الوجبات.`;

  // Exact training schedule.
  if (b.schedule && typeof b.schedule === 'object') {
    p.schedule = {};
    for (let d = 0; d <= 6; d++) {
      const list = Array.isArray(b.schedule[d]) ? b.schedule[d] : [];
      const ok = [];
      for (const s of list) {
        const start = s && s.start;
        const dur = Number(s && s.duration);
        if (!HM.test(start || '')) { errors[`schedule.${d}`] = 'ميعاد التمرين بصيغة HH:MM.'; continue; }
        if (!(dur >= 15 && dur <= 300)) { errors[`schedule.${d}`] = 'مدة الحصة من 15 إلى 300 دقيقة.'; continue; }
        ok.push({ start, duration: Math.round(dur) });
      }
      ok.sort((a, c) => toMin(a.start) - toMin(c.start));
      if (ok.length > 2) errors[`schedule.${d}`] = 'أقصى حاجة حصتين في اليوم.';
      if (ok.length === 2 && toMin(ok[1].start) < toMin(ok[0].start) + ok[0].duration + 60) errors[`schedule.${d}`] = 'لازم ساعة على الأقل بين نهاية الحصة الأولى وبداية التانية.';
      if (ok.length) p.schedule[d] = ok.slice(0, 2);
    }
  } else {
    // Older preferences: training days + a time of day.
    const days = Array.isArray(b.trainingDays) ? b.trainingDays.map(Number).filter((x) => x >= 0 && x <= 6) : defaultTrainingDays(sessionsPerWeek);
    const start = OLD_TIME[b.trainingTime] || OLD_TIME.afternoon;
    p.schedule = Object.fromEntries(days.map((d) => [d, [{ start, duration: defaultDuration }]]));
  }
  if (b.carbStrategy != null) { if (['periodized', 'even'].includes(b.carbStrategy)) p.carbStrategy = b.carbStrategy; else errors.carbStrategy = 'قيمة غير صحيحة.'; }
  if (b.maxCookMin != null && b.maxCookMin !== '') { const m = Number(b.maxCookMin); if ([20, 30, 45, 60].includes(m)) p.maxCookMin = m; else errors.maxCookMin = 'قيمة غير صحيحة.'; }
  if (b.dessertsPerWeek != null) { const d = Number(b.dessertsPerWeek); if (Number.isInteger(d) && d >= 0 && d <= 4) p.dessertsPerWeek = d; else errors.dessertsPerWeek = 'من 0 إلى 4.'; }
  if (b.fasting) {
    if (['none', 'fish', 'vegan'].includes(b.fasting.mode)) p.fasting.mode = b.fasting.mode; else errors.fasting = 'نوع الصيام غير صحيح.';
    if (Array.isArray(b.fasting.days)) p.fasting.days = [...new Set(b.fasting.days.map(Number).filter((x) => x >= 0 && x <= 6))].sort();
  }
  if (b.ramadan) {
    p.ramadan.enabled = !!b.ramadan.enabled;
    for (const k of ['iftarTime', 'suhoorTime']) if (b.ramadan[k] != null) { if (HM.test(b.ramadan[k])) p.ramadan[k] = b.ramadan[k]; else errors[`ramadan.${k}`] = 'الوقت بصيغة HH:MM.'; }
    const night = (toMin(p.ramadan.suhoorTime) - toMin(p.ramadan.iftarTime) + 1440) % 1440;
    if (p.ramadan.enabled && (night < 6 * 60 || night > 14 * 60)) errors.ramadan = 'راجع ميعاد الإفطار والسحور.';
  }
  if (b.health) { p.health.lowIron = !!b.health.lowIron; p.health.lowVitD = !!b.health.lowVitD; }
  if (b.freeMeal) {
    p.freeMeal.enabled = !!b.freeMeal.enabled;
    if (b.freeMeal.date) { if (parseDate(b.freeMeal.date)) p.freeMeal.date = b.freeMeal.date; else errors.freeMeal = 'تاريخ الوجبة الحرة غير صحيح.'; }
    if (['lunch', 'dinner'].includes(b.freeMeal.slot)) p.freeMeal.slot = b.freeMeal.slot;
    if (p.freeMeal.enabled && !p.freeMeal.date) errors.freeMeal = 'اختار تاريخ الوجبة الحرة.';
  }
  // Carb sources that contain an avoided allergen are dropped.
  p.carbs = p.carbs.filter((c) => !(FOODS.get(CARB_SOURCES[c].food).allergens || []).some((a) => p.avoid.includes(a)));
  if (!p.carbs.length && !errors.carbs) errors.carbs = 'كل مصادر الكربوهيدرات المختارة فيها مكوّن ممنوع؛ اختار مصدر تاني (أرز أو بطاطس مثلًا).';
  p.trainingDays = Object.keys(p.schedule).map(Number).sort();
  return { value: p, errors };
}

function defaultTrainingDays(n) {
  const k = Math.min(7, Math.max(0, Math.round(n)));
  if (!k) return [];
  return [...new Set(Array.from({ length: k }, (_, i) => WEEK_ORDER[Math.floor((i * 7) / k)]))].sort();
}

// Deterministic RNG so a seed reproduces the same plan.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- meal times for one day ----
// Returns slots: { kind, time (minutes from 00:00, may exceed 1440 after midnight), timing, size, label }
function daySlots(prefs, sessions = [], ramadan = false) {
  let slots;
  let windowStart; let windowEnd;
  if (ramadan) {
    const ift = toMin(prefs.ramadan.iftarTime);
    let suh = toMin(prefs.ramadan.suhoorTime);
    if (suh <= ift) suh += 1440;
    windowStart = ift; windowEnd = suh;
    slots = [
      { kind: 'iftar', time: ift, ramadan: 'iftar' },
      { kind: 'lunch', time: ift + 45, ramadan: 'main' },
      { kind: 'snack', time: Math.min(ift + 4 * 60, suh - 3 * 60), ramadan: 'snack' },
      { kind: 'breakfast', time: suh - 40, ramadan: 'suhoor' },
    ];
  } else {
    const wake = toMin(prefs.wakeTime);
    let sleep = toMin(prefs.sleepTime);
    if (sleep <= wake) sleep += 1440;
    windowStart = wake; windowEnd = sleep;
    const kinds = MEAL_SETS[prefs.mealsPerDay];
    const first = wake + 30;
    const last = sleep - (kinds[kinds.length - 1] === 'snack' ? 75 : 150);
    const step = (last - first) / (kinds.length - 1);
    slots = kinds.map((kind, i) => ({ kind, time: Math.round((first + step * i) / 15) * 15 }));
  }
  slots.forEach((s) => { s.pre = 0; s.post = 0; });
  const notes = [];
  const sess = sessions.map((s) => ({ start: toMin(s.start) + (ramadan && toMin(s.start) < windowStart - 6 * 60 ? 1440 : 0), duration: s.duration }));
  // No meal during a session: move it before or after, whichever is closer and inside the eating window.
  for (const s of sess) {
    const end = s.start + s.duration;
    for (const m of slots) {
      if (m.time > s.start - 40 && m.time < end + 15) {
        const before = s.start - 75;
        const after = end + 40;
        const useBefore = m.time < s.start + s.duration / 2 && before >= windowStart && !(m.ramadan === 'iftar');
        m.time = useBefore ? before : Math.min(after, windowEnd - 30);
      }
    }
  }
  for (const s of sess) {
    const end = s.start + s.duration;
    // Pre-training: the last meal 45 min – 4 h before the start, otherwise a small snack ~60 min before.
    const before = slots.filter((m) => m.time <= s.start - 45 && m.time >= s.start - 240).sort((a, b) => b.time - a.time)[0];
    if (before) before.pre += 1;
    else if (s.start - 60 >= windowStart || (!ramadan && s.start - 30 >= windowStart)) {
      slots.push({ kind: 'snack', time: Math.max(windowStart, s.start - 60), pre: 1, post: 0, added: true });
    } else if (ramadan) {
      notes.push(`الحصة الساعة ${fmtMin(s.start)} وأنت صايم: خليها خفيفة ومتوسطة الشدة، واشرب كويس من الإفطار للسحور.`);
    } else {
      slots.push({ kind: 'snack', time: s.start - 30, pre: 1, post: 0, added: true });
      notes.push(`الحصة الساعة ${fmtMin(s.start)} قبل ميعاد صحيانك المسجل؛ حطينا سناك صغير قبلها بنص ساعة.`);
    }
    // Post-training: the first meal within 90 min after the end, otherwise a recovery snack 30 min after.
    const after = slots.filter((m) => m.time >= end && m.time <= end + 90).sort((a, b) => a.time - b.time)[0];
    if (after) { after.post += 1; if (after.time > end + 60) after.time = end + 45; }
    else if (!ramadan || (end + 30 >= windowStart && end + 30 <= windowEnd)) {
      // Move the next main meal forward when it is close, otherwise add a recovery snack.
      const next = slots.filter((m) => m.time > end && m.time <= end + 180 && m.kind !== 'snack').sort((a, b) => a.time - b.time)[0];
      if (next && !next.pre) { next.time = end + 45; next.post += 1; }
      else slots.push({ kind: 'snack', time: Math.max(end + 30, ramadan ? windowStart : 0), pre: 0, post: 1, added: true });
    } else {
      // Ramadan, training before iftar: iftar is the recovery meal.
      const ift = slots.find((m) => m.kind === 'iftar');
      if (ift) ift.post += 1;
      const main = slots.find((m) => m.ramadan === 'main');
      if (main) main.post += 1;
    }
  }
  slots.sort((a, b) => a.time - b.time);
  // Keep at least 75 min between meals that are not linked to training.
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].time - slots[i - 1].time < 60 && !slots[i].pre && !slots[i].post && slots[i].kind === 'snack' && !slots[i].ramadan) slots[i].time = slots[i - 1].time + 75;
  }
  // Shares: protein follows meal size; carbohydrate shifts toward meals around training.
  let pTot = 0; let cTot = 0;
  for (const s of slots) {
    s.size = SIZE[s.kind];
    s.pW = s.pre && !s.post && s.kind === 'snack' ? 0.15 : s.size;
    s.cW = s.size * (1 + 0.35 * s.pre + 0.6 * s.post);
    pTot += s.pW; cTot += s.cW;
  }
  slots.forEach((s, i) => {
    s.idx = i;
    s.pShare = s.pW / pTot; s.cShare = s.cW / cTot;
    s.timing = s.pre && s.post ? 'between' : s.pre ? 'pre' : s.post ? 'post' : null;
    const base = s.ramadan === 'main' ? 'الإفطار' : s.ramadan === 'suhoor' ? 'السحور' : s.ramadan === 'snack' ? 'سناك بعد التراويح' : SLOT_AR[s.kind];
    s.label = s.timing === 'between' ? `${base} (بين التمرينين)` : s.timing === 'pre' ? (s.added ? 'سناك قبل التمرين' : `${base} (قبل التمرين)`) : s.timing === 'post' ? (s.added ? 'سناك الاستشفاء بعد التمرين' : `${base} (بعد التمرين)`) : base;
    s.clock = fmtMin(s.time);
  });
  return { slots, notes, sessions: sess.map((s) => ({ start: fmtMin(s.start), end: fmtMin(s.start + s.duration), duration: s.duration })) };
}

// ---- candidate filtering ----
function fastingMode(prefs, weekday) {
  const f = prefs.fasting || { mode: 'none' };
  if (f.mode === 'none') return 'none';
  return !f.days.length || f.days.includes(weekday) ? f.mode : 'none';
}
function allowed(r, prefs, fast = 'none') {
  if (r.plan.allergens.some((a) => prefs.avoid.includes(a))) return false;
  if (prefs.maxCookMin && r.plan.totalMin > prefs.maxCookMin) return false;
  if (fast === 'vegan' && r.plan.fasting !== 'vegan') return false;
  if (fast === 'fish' && r.plan.fasting === 'none') return false;
  const pt = r.plan.proteinType;
  if (pt !== 'mixed' && prefs.proteins[pt] === -1) return false;
  for (const [k, v] of Object.entries(prefs.proteins)) {
    if (v === -1 && ['chicken', 'beef', 'fish', 'seafood'].includes(k) && r.items.some((i) => FOODS.get(i.foodId).proteinType === k)) return false;
  }
  return true;
}
const prefWeight = (r, prefs) => PREF_WEIGHT[String(r.plan.proteinType === 'mixed' ? 1 : prefs.proteins[r.plan.proteinType])] ?? 1;
const healthWeight = (r, prefs) => (prefs.health.lowIron && r.plan.ironRich ? 2.2 : 1) * (prefs.health.lowVitD && r.plan.vitDRich ? 2 : 1);

function pick(cands, rand, scoreFn) {
  const scored = cands.map((r) => ({ r, w: Math.max(0, scoreFn(r)) })).filter((x) => x.w > 0);
  const total = scored.reduce((s, x) => s + x.w, 0);
  if (!total) return null;
  let t = rand() * total;
  for (const x of scored) { t -= x.w; if (t <= 0) return x.r; }
  return scored[scored.length - 1].r;
}

const r10 = (g) => Math.max(0, Math.round(g / 10) * 10);
const r5 = (g) => Math.max(0, Math.round(g / 5) * 5);

function scaledRecipe(r, servings) {
  const k = servings / r.servings;
  const items = r.items.map((i) => ({ ...nutrientsFor(i.foodId, i.grams * k), oil: i.oil }));
  return { items, totals: sum(items) };
}

const isMain = (kind) => kind === 'lunch' || kind === 'dinner';
// Portion: scale to the protein target (meals) or the carb target (pre-training snack).
function portion(r, slot, target) {
  const per = r.perServing;
  let servings;
  if (slot.timing === 'pre' && slot.kind === 'snack') servings = per.carb > 0 ? target.carb / per.carb : 1;
  else if (r.plan.role === 'dessert' || r.plan.role === 'drink') servings = 1;
  else {
    servings = per.protein > 0 ? (target.protein * (slot.kind === 'snack' ? 1 : 0.92)) / per.protein : 1;
    if (per.protein > 0) {
      const sidePro = Math.max(0, target.carb - servings * per.carb) * 0.12;
      servings = Math.max(0, target.protein * (slot.kind === 'snack' ? 1 : 0.95) - sidePro) / per.protein;
    }
    const vegReserve = isMain(slot.kind) ? 15 : 0;
    if (per.carb > 0) servings = Math.min(servings, Math.max(0, target.carb * 1.05 - vegReserve) / per.carb);
    if (per.fat > 0) servings = Math.min(servings, Math.max(0.5, (target.fat * 1.25) / per.fat));
  }
  const maxS = slot.kind === 'snack' || slot.kind === 'iftar' ? 1.5 : 2.5;
  return Math.min(maxS, Math.max(0.5, Math.floor(servings * 4 + 0.35) / 4));
}
function fit(r, slot, target) {
  const s = portion(r, slot, target);
  const p = r.perServing;
  const over = (v, t, tol) => Math.max(0, v - t * tol);
  const fatOver = over(s * p.fat, target.fat, 1.15);
  const carbOver = over(s * p.carb, target.carb, 1.15);
  const protShort = slot.timing === 'pre' ? 0 : Math.max(0, target.protein * 0.8 - s * p.protein);
  const halfPortion = s < 0.75 && slot.kind !== 'snack' ? 0.6 : 1;
  // Close to training: favour low-fibre, low-fat dishes.
  const gut = (slot.timing === 'pre' || slot.timing === 'between') && !r.plan.lowFiberFat ? 0.5 : 1;
  return halfPortion * gut * Math.exp(-fatOver / 8 - carbOver / 25 - protShort / 12);
}

// Measured protein top-up that respects preferences, allergens and fasting.
const BOOSTERS = {
  light: [['greek_yogurt', 'dairy', 'زبادي يوناني'], ['areesh_cheese', 'dairy', 'جبنة قريش'], ['egg_white', 'eggs', 'بياض بيض مسلوق'], ['tuna_water', 'fish', 'تونة'], ['chickpeas_cooked', 'legumes', 'حمص مسلوق']],
  main: [['chicken_breast_cooked', 'chicken', 'صدور فراخ مشوية'], ['tuna_water', 'fish', 'تونة'], ['egg_white', 'eggs', 'بياض بيض مسلوق'], ['greek_yogurt', 'dairy', 'زبادي يوناني'], ['chickpeas_cooked', 'legumes', 'حمص مسلوق'], ['lentils_cooked', 'legumes', 'عدس مسلوق']],
};
function proteinBooster(gap, kind, prefs, fast, min = 8, matchType = null) {
  // Plant protein comes with a lot of carbohydrate; on vegan fasting days close only part of the gap.
  if (fast === 'vegan') gap *= 0.5;
  if (gap < min) return null;
  let list = isMain(kind) ? BOOSTERS.main : BOOSTERS.light;
  if (matchType && matchType !== 'legumes') list = [...list.filter((b) => b[1] === matchType), ...list.filter((b) => b[1] !== matchType)];
  for (const [food, type, ar] of list) {
    const f = FOODS.get(food);
    if (prefs.proteins[type] === -1 || (f.allergens || []).some((a) => prefs.avoid.includes(a))) continue;
    if (fast === 'vegan' && f.fasting) continue;
    if (fast === 'fish' && f.fasting === 'animal') continue;
    const g = Math.min(250, r10((gap / f.protein) * 100));
    if (g < 30) return null;
    const it = nutrientsFor(food, g);
    return { kind: 'protein', ar: `إضافة بروتين: ${ar}`, items: [it], totals: sum([it]) };
  }
  return null;
}

// Simple plate when no recipe fits (strict fasting + exclusions): protein food + carb source + salad.
function fallbackMeal(slot, target, prefs, fast) {
  const okF = (id) => {
    const f = FOODS.get(id);
    if ((f.allergens || []).some((a) => prefs.avoid.includes(a))) return false;
    if (f.proteinType && prefs.proteins[f.proteinType] === -1) return false;
    if (fast === 'vegan' && f.fasting) return false;
    if (fast === 'fish' && f.fasting === 'animal') return false;
    return true;
  };
  const prot = ['fava_cooked', 'lentils_cooked', 'chickpeas_cooked', 'white_beans_cooked', 'tuna_water', 'sardines_oil', 'tilapia_cooked', 'egg_whole', 'chicken_breast_cooked'].find(okF);
  if (!prot) return null;
  const items = [];
  const pf = FOODS.get(prot);
  const pg = Math.min(350, r10((Math.max(10, target.protein * 0.8) / pf.protein) * 100));
  items.push(nutrientsFor(prot, pg));
  const carbKey = prefs.carbs.find((c) => okF(CARB_SOURCES[c].food));
  const left = target.carb - sum(items).carb;
  if (carbKey && left > 12) { const cf = FOODS.get(CARB_SOURCES[carbKey].food); items.push(nutrientsFor(cf.id, Math.min(400, r10((left / cf.carb) * 100)))); }
  if (slot.kind !== 'snack') { items.push(nutrientsFor('tomato', 100), nutrientsFor('cucumber', 100)); if (okF('olive_oil')) items.push(nutrientsFor('olive_oil', 5)); }
  return { recipeId: null, recipeAr: `طبق بسيط: ${pf.ar}${carbKey ? ` مع ${CARB_SOURCES[carbKey].ar}` : ''}${slot.kind !== 'snack' ? ' وسلطة' : ''}`, proteinType: pf.proteinType || 'mixed', servings: 1,
    perServing: null, recipeItems: items, recipeTotals: sum(items), extras: [], totals: sum(items), sauceIdeas: [], fallback: true,
    target: { protein: Math.round(target.protein), carb: Math.round(target.carb), fat: Math.round(target.fat), kcal: Math.round(target.kcal) } };
}

// ---- build one meal ----
// shared (household): { recipeId, vegId, carbKey } — same dish and sides as the rest of the household,
// used only when allowed by this person's own preferences, allergies and fasting; the portion stays personal.
function buildMeal(slot, target, ctx, forcedId, exclude = [], shared = null) {
  const { prefs, lib, rand, used, dayUsed, fast } = ctx;
  const ok = (r) => allowed(r, prefs, fast) && !exclude.includes(r.id);
  const minMainProtein = fast === 'vegan' ? 10 : 15;
  let pool;
  if (slot.kind === 'iftar') {
    pool = lib.filter((r) => r.plan.soup && (r.plan.role === 'main' || r.plan.role === 'side'));
  } else if (isMain(slot.kind)) {
    pool = lib.filter((r) => r.plan.role === 'main' && r.plan.slots.includes(slot.kind) && r.perServing.protein >= minMainProtein);
  } else if (slot.kind === 'breakfast') {
    pool = lib.filter((r) => r.plan.role === 'main' && r.plan.slots.includes('breakfast'));
    if (slot.ramadan === 'suhoor') { const slow = pool.filter((r) => r.perServing.fiber >= 3); if (slow.length >= 5) pool = slow; }
  } else {
    const snacks = lib.filter((r) => r.plan.slots.includes('snack') && !['dessert', 'drink'].includes(r.plan.role) && ok(r));
    const want = slot.timing === 'between' ? 'post' : slot.timing;
    pool = want ? snacks.filter((r) => r.plan.timing.includes(want)) : snacks;
    if (!pool.length) pool = slot.timing === 'pre' ? snacks.filter((r) => r.perServing.fat <= 8) : snacks;
    if (!pool.length) pool = lib.filter((r) => r.plan.slots.includes('breakfast') && r.plan.role === 'main');
  }
  const strict = pool.filter(ok);
  pool = strict.length ? strict : pool.filter((r) => allowed(r, { ...prefs, maxCookMin: null }, fast) && !exclude.includes(r.id));
  if (slot.kind === 'snack' && !slot.timing) {
    const withProtein = pool.filter((r) => r.perServing.protein >= 8);
    if (withProtein.length >= 3) pool = withProtein;
  }
  if (slot.kind === 'snack' && !slot.timing && ctx.dessertsLeft > 0 && !ctx.training && fast === 'none') {
    const desserts = lib.filter((r) => r.plan.role === 'dessert' && ok(r) && !used.has(r.id));
    if (desserts.length && rand() < 0.5) { pool = desserts; ctx.dessertsLeft -= 1; }
  }
  let r = forcedId ? lib.find((x) => x.id === forcedId) : null;
  let sharedNote = null;
  if (!r && shared) {
    const cand = lib.find((x) => x.id === shared.recipeId);
    if (cand && ok(cand)) r = cand;
    else { sharedNote = 'الوجبة دي مختلفة عن أكل البيت علشان طبق البيت مش مناسب لتفضيلاتك أو حساسيتك أو صيامك.'; shared = null; }
  }
  if (!r) {
    const recipeScore = (x) => {
      let w = fit(x, slot, target) * healthWeight(x, prefs);
      const uses = used.get(x.id) || 0;
      if (uses) w *= slot.kind === 'snack' ? 0.3 : 0.05;
      return w;
    };
    if (isMain(slot.kind)) {
      const byType = new Map();
      pool.forEach((x) => { const t = x.plan.proteinType; if (!byType.has(t)) byType.set(t, []); byType.get(t).push(x); });
      const typeW = (t) => {
        const pw = t === 'mixed' ? 0.5 : PREF_WEIGHT[String(prefs.proteins[t])] ?? 1;
        const best = Math.max(...byType.get(t).map(recipeScore));
        const balance = 1 / (1 + 0.5 * (ctx.typeCount.get(t) || 0) / Math.max(0.35, pw));
        return pw * balance * best * (dayUsed.has(t) ? 0.25 : 1);
      };
      const chosen = pick([...byType.keys()].map((t) => ({ t })), rand, (o) => typeW(o.t));
      const within = chosen ? byType.get(chosen.t) : pool;
      r = pick(within, rand, recipeScore) || within[0];
    } else {
      r = pick(pool, rand, (x) => prefWeight(x, prefs) * recipeScore(x)) || pool[0];
    }
  }
  const base = { slot: slot.kind, idx: slot.idx, label: slot.label, timing: slot.timing, time: slot.clock, timeMin: slot.time, ramadan: slot.ramadan || null };
  if (!r && fast !== 'none') {
    // Fasting day with few options: any allowed dish for the meal, ignoring the protein minimum.
    const loose = lib.filter((x) => ['main', 'side'].includes(x.plan.role) && (x.plan.slots.includes(slot.kind === 'iftar' ? 'lunch' : slot.kind) || slot.kind === 'snack') && ok(x));
    r = pick(loose, rand, (x) => fit(x, slot, target)) || loose[0] || null;
  }
  if (!r) {
    const fb = fallbackMeal(slot, target, prefs, fast);
    if (fb) return { ...base, ...fb };
    return { ...base, empty: true, note: 'مفيش وصفة مناسبة لتفضيلاتك في الوجبة دي؛ وسّع التفضيلات.' };
  }

  const per = r.perServing;
  const servings = portion(r, slot, target);
  const part = scaledRecipe(r, servings);
  const extras = [];
  // Iftar opens with dates and water before the soup.
  if (slot.kind === 'iftar') {
    const it = nutrientsFor('dates', 30);
    extras.push({ kind: 'dates', ar: 'تمر (حوالي 3 تمرات) وكوبايتين ماء', items: [it], totals: sum([it]) });
  }
  // Vegetable side with lunch and dinner for fibre and volume (not right before training).
  if (isMain(slot.kind) && slot.timing !== 'pre' && slot.timing !== 'between') {
    const vegs = lib.filter((x) => x.plan.sideKind === 'veg' && allowed(x, prefs, fast));
    const sharedVeg = shared && shared.vegId ? vegs.find((x) => x.id === shared.vegId) : null;
    const veg = sharedVeg || (vegs.length ? vegs[Math.floor(rand() * vegs.length)] : null);
    if (veg) { const vs = scaledRecipe(veg, 1); extras.push({ kind: 'veg', recipeId: veg.id, ar: veg.ar, items: vs.items, totals: vs.totals }); }
  }
  // Vitamin C with iron-rich meals when iron is low.
  if (prefs.health.lowIron && r.plan.ironRich && !r.plan.vitC) {
    const it = nutrientsFor('orange', 130);
    extras.push({ kind: 'vitc', ar: 'برتقالة (فيتامين سي بيساعد امتصاص الحديد)', items: [it], totals: sum([it]) });
  }
  // Carbohydrate side to close the gap.
  const carbSoFar = part.totals.carb + extras.reduce((s, e) => s + e.totals.carb, 0);
  const gap = target.carb - carbSoFar;
  if (gap >= 12 && prefs.carbs.length && !(slot.timing === 'pre' && slot.kind === 'snack')) {
    let order = prefs.carbs;
    if (slot.kind === 'breakfast' || slot.kind === 'snack') order = ['bread', 'sweet_potato', 'potato', 'rice', 'pasta', 'bulgur'].filter((c) => prefs.carbs.includes(c));
    let key = slot.kind === 'breakfast' || slot.kind === 'snack' ? order[0] : order[ctx.carbTurn++ % order.length];
    if (shared && shared.carbKey && prefs.carbs.includes(shared.carbKey)) key = shared.carbKey;
    if (key) {
      const src = CARB_SOURCES[key];
      const f = FOODS.get(src.food);
      const g = Math.min(slot.kind === 'snack' ? 120 : 450, r10((gap / f.carb) * 100));
      if (g >= 20) { const it = nutrientsFor(src.food, g); extras.push({ kind: 'carb', key, ar: src.ar, items: [it], totals: sum([it]) }); }
    }
  }
  if (slot.timing !== 'pre') {
    const pNow = part.totals.protein + extras.reduce((t, e) => t + e.totals.protein, 0);
    const b = proteinBooster(target.protein - pNow, slot.kind, prefs, fast, 8, r.plan.proteinType);
    if (b) extras.push(b);
  }
  // Sauces are added only when the athlete asks (sauceSuggestions + addExtra), never automatically.
  const sauceIdeas = [];
  const allItems = [...part.items, ...extras.flatMap((e) => e.items)];
  return {
    ...base, recipeId: r.id, recipeAr: r.ar, proteinType: r.plan.proteinType, servings, perServing: per,
    ironRich: r.plan.ironRich, vitDRich: r.plan.vitDRich,
    recipeItems: part.items, recipeTotals: part.totals, extras, totals: sum(allItems), sauceIdeas,
    ...(shared ? { shared: true } : {}), ...(sharedNote ? { sharedNote } : {}),
    target: { protein: Math.round(target.protein), carb: Math.round(target.carb), fat: Math.round(target.fat), kcal: Math.round(target.kcal) },
  };
}

const mealItems = (m) => (m.empty || m.free ? [] : [...m.recipeItems, ...m.extras.flatMap((e) => e.items)]);
const refreshMeal = (m) => { m.totals = sum(mealItems(m)); };

// Totals of the food actually in the plan (never target values). 2026-10-22 audit D1: a free meal used to add
// its TARGET to the day total, so a target was shown as calculated food.
function dayTotals(day) {
  const items = [...day.meals.flatMap(mealItems), ...(day.added || []).flatMap((a) => a.items)];
  const t = sum(items);
  t.ironMg = round(items.reduce((s, i) => s + (i.ironMg || 0), 0), 1);
  t.vitDug = round(items.reduce((s, i) => s + (i.vitDug || 0), 0), 1);
  t.calciumMg = Math.round(items.reduce((s, i) => s + (i.calciumMg || 0), 0));
  // share of the day's food (by grams, excluding water/salt) that has a known value
  const g = items.filter((i) => i.foodId !== 'water' && i.foodId !== 'salt');
  const tot = g.reduce((s, i) => s + i.grams, 0) || 1;
  t.ironCoverage = round(g.filter((i) => i.ironMg != null).reduce((s, i) => s + i.grams, 0) / tot, 2);
  t.vitDCoverage = round(g.filter((i) => i.vitDug != null).reduce((s, i) => s + i.grams, 0) / tot, 2);
  t.calciumCoverage = round(g.filter((i) => i.calciumMg != null).reduce((s, i) => s + i.grams, 0) / tot, 2);
  return t;
}
// The free meal's allowance (a target, not food). Kept apart from the totals.
function freeBudget(day) {
  const f = day.meals.filter((x) => x.free);
  if (!f.length) return null;
  return f.reduce((b, m) => ({ kcal: b.kcal + m.target.kcal, protein: b.protein + m.target.protein, carb: b.carb + m.target.carb, fat: b.fat + m.target.fat }), { kcal: 0, protein: 0, carb: 0, fat: 0 });
}
// For filling and trimming the plan only: food + the free meal's allowance, so the planner does not try to
// "make up" the free meal with other food.
function planningTotals(day) {
  const t = dayTotals(day);
  const b = freeBudget(day);
  if (b) { t.kcal += b.kcal; t.protein += b.protein; t.carb += b.carb; t.fat += b.fat; }
  return t;
}
function setDayTotals(day) {
  const t = dayTotals(day);
  const b = freeBudget(day);
  day.totals = t;
  day.freeMealBudget = b ? { ...b, note: 'ميزانية الوجبة الحرة (هدف تقريبي، مش أكل محسوب)؛ مش داخلة في الإجمالي.' } : null;
  // diff compares calculated food with the target left for planned food (target minus the free-meal allowance)
  const base = { kcal: day.targets.kcal - (b ? b.kcal : 0), proteinG: day.targets.proteinG - (b ? b.protein : 0), carbG: day.targets.carbG - (b ? b.carb : 0), fatG: day.targets.fatG - (b ? b.fat : 0) };
  day.diff = { kcal: Math.round(t.kcal - base.kcal), protein: round(t.protein - base.proteinG, 0), carb: round(t.carb - base.carbG, 0), fat: round(t.fat - base.fatG, 0),
    basis: b ? 'target_minus_free_meal' : 'target' };
}

// Calories above target: trim carb sides first, then quarter-portions of the dish carrying the macro most over
// target (fat or carbohydrate), meals tied to training excluded, never letting protein fall under 95% of target. Keeps the planned deficit real.
const KCAL_TOL = 1.02;
function trimCalories(day, dayTargets, real, lib) {
  let over = planningTotals(day).kcal - dayTargets.kcal * KCAL_TOL;
  if (over <= 25) return;
  const hosts = real.filter((m) => m.extras.some((e) => e.kind === 'carb') && m.timing !== 'pre')
    .sort((a, b) => (a.timing ? 1 : 0) - (b.timing ? 1 : 0) || b.timeMin - a.timeMin);
  for (const host of hosts) {
    if (over <= 25 || planningTotals(day).carb <= dayTargets.carbG * 0.9) break;
    const carb = host.extras.find((e) => e.kind === 'carb');
    const f = FOODS.get(carb.items[0].foodId);
    const before = carb.items[0].grams;
    const keep = host.timing ? Math.round(before * 0.6) : 0;
    const roomCarb = Math.max(0, planningTotals(day).carb - dayTargets.carbG * 0.9);
    const remove = Math.min(before - keep, r10((over / f.kcal) * 100), r10((roomCarb / Math.max(1, f.carb)) * 100));
    if (remove <= 0) continue;
    const after = before - remove;
    if (after < 20) host.extras = host.extras.filter((e) => e !== carb);
    else { carb.items = [nutrientsFor(f.id, after)]; carb.totals = sum(carb.items); }
    refreshMeal(host);
    over = planningTotals(day).kcal - dayTargets.kcal * KCAL_TOL;
  }
  for (let guard = 0; over > 25 && guard < 8; guard++) {
    const t = planningTotals(day);
    // reduce the dish that carries the macro most over target (fat or carbohydrate)
    const fatX = t.fat - dayTargets.fatG * 1.05; const carbX = t.carb - dayTargets.carbG * 1.05;
    if (fatX <= 0 && carbX <= 0) break;
    const key = fatX * 9 >= carbX * 4 ? 'fat' : 'carb';
    const cand = real.filter((m) => !m.timing && m.recipeId && m.servings > 0.5)
      .map((m) => ({ m, r: lib.find((x) => x.id === m.recipeId) })).filter((x) => x.r && x.r.perServing[key] > 3)
      .sort((a, b) => b.r.perServing[key] - a.r.perServing[key])[0];
    if (!cand) break;
    if (t.protein - 0.25 * cand.r.perServing.protein < dayTargets.proteinG * 0.95) break;
    const part = scaledRecipe(cand.r, cand.m.servings - 0.25);
    cand.m.servings -= 0.25; cand.m.recipeItems = part.items; cand.m.recipeTotals = part.totals;
    refreshMeal(cand.m);
    over = planningTotals(day).kcal - dayTargets.kcal * KCAL_TOL;
  }
}

// ---- build one day ----
function buildDay(date, dayTargets, sessions, ctx, forced = {}, exclude = {}) {
  const wd = parseDate(date).getUTCDay();
  const ramadan = !!ctx.prefs.ramadan.enabled;
  const { slots, notes, sessions: sessOut } = daySlots(ctx.prefs, sessions, ramadan);
  ctx.dayUsed = new Set();
  ctx.training = sessions.length > 0;
  ctx.fast = fastingMode(ctx.prefs, wd);
  const freeHere = ctx.prefs.freeMeal.enabled && ctx.prefs.freeMeal.date === date;
  let freeDone = false;
  const sharedKinds = new Set();
  const meals = slots.map((s) => {
    const t = { protein: dayTargets.proteinG * s.pShare, carb: dayTargets.carbG * s.cShare, fat: dayTargets.fatG * s.pShare, kcal: dayTargets.kcal * (s.pShare + s.cShare) / 2 };
    if (freeHere && !freeDone && (s.kind === ctx.prefs.freeMeal.slot || (ramadan && s.ramadan === 'main')) && !s.timing) {
      freeDone = true;
      return { slot: s.kind, idx: s.idx, label: `${s.label} — وجبة حرة`, time: s.clock, timeMin: s.time, timing: null, free: true,
        target: { protein: Math.round(t.protein), carb: Math.round(t.carb), fat: Math.round(t.fat), kcal: Math.round(t.kcal) },
        note: `وجبة حرة مرة في الشهر: كُل اللي نفسك فيه في وجبة واحدة مش يوم كامل، والأحسن تبقى في حدود ${Math.round(t.kcal * 1.5)} سعرة تقريبًا. كمّل باقي اليوم عادي، ومتعوضهاش بالتجويع بعدها.` };
    }
    const hh = ctx.household && ctx.household[date];
    const shared = hh && !forced[s.idx] && !(exclude[s.idx] || []).length && !s.timing && hh[s.kind] && !sharedKinds.has(s.kind) ? hh[s.kind] : null;
    if (shared) sharedKinds.add(s.kind);
    const m = buildMeal(s, t, ctx, forced[s.idx], exclude[s.idx] || [], shared);
    if (!m.empty) {
      ctx.used.set(m.recipeId, (ctx.used.get(m.recipeId) || 0) + 1);
      if (isMain(s.kind)) { ctx.dayUsed.add(m.proteinType); ctx.typeCount.set(m.proteinType, (ctx.typeCount.get(m.proteinType) || 0) + 1); }
    }
    return m;
  });
  if (freeHere && !freeDone) notes.push('الوجبة الحرة النهارده متحطتش لأن الوجبة المختارة مرتبطة بالتمرين؛ خليها في وجبة بعيدة عن التمرين.');
  const real = meals.filter((m) => !m.empty && !m.free);
  const day = { date, weekday: wd, dayAr: DAY_AR[wd], training: sessions.length > 0, sessions: sessOut, ramadan, fasting: ctx.fast, meals, notes, added: [],
    targets: { kcal: dayTargets.kcal, proteinG: dayTargets.proteinG, carbG: dayTargets.carbG, fatG: dayTargets.fatG } };
  // Remaining protein goes to the post-training meal or dinner.
  const pGap = dayTargets.proteinG - planningTotals(day).protein;
  if (pGap >= 8) {
    const host = real.find((m) => m.timing === 'post') || real.find((m) => m.slot === 'dinner') || real[real.length - 1];
    const b = host && proteinBooster(pGap, host.slot, ctx.prefs, ctx.fast, 8, host.proteinType);
    if (b) {
      const same = host.extras.find((e) => e.kind === 'protein' && e.items[0].foodId === b.items[0].foodId);
      if (same) { same.items = [nutrientsFor(b.items[0].foodId, Math.min(300, same.items[0].grams + b.items[0].grams))]; same.totals = sum(same.items); }
      else host.extras.push(b);
      refreshMeal(host);
    }
  }
  // Remaining carbohydrate goes to the post-training meal or lunch.
  const cGap = dayTargets.carbG - planningTotals(day).carb;
  if (cGap >= 15 && ctx.prefs.carbs.length) {
    const host = real.find((m) => m.timing === 'post' && m.slot !== 'snack') || real.find((m) => m.slot === 'lunch') || real[0];
    const existing = host && host.extras.find((e) => e.kind === 'carb');
    const key = existing ? Object.keys(CARB_SOURCES).find((k) => CARB_SOURCES[k].ar === existing.ar) : ctx.prefs.carbs[0];
    const src = CARB_SOURCES[key];
    const add = r10((cGap / FOODS.get(src.food).carb) * 100);
    if (host && add >= 20) {
      if (existing) { existing.items = [nutrientsFor(src.food, existing.items[0].grams + add)]; existing.totals = sum(existing.items); }
      else { const it = nutrientsFor(src.food, add); host.extras.push({ kind: 'carb', ar: src.ar, items: [it], totals: sum([it]) }); }
      refreshMeal(host);
    }
  }
  // Too much carbohydrate (carb-heavy dishes, plant protein): trim carb sides, latest meals first, keeping training meals for last.
  let over = planningTotals(day).carb - dayTargets.carbG;
  if (over > 15) {
    const hosts = real.filter((m) => m.extras.some((e) => e.kind === 'carb')).sort((a, b) => (a.timing ? 1 : 0) - (b.timing ? 1 : 0) || b.timeMin - a.timeMin);
    for (const host of hosts) {
      if (over <= 10) break;
      const carb = host.extras.find((e) => e.kind === 'carb');
      const f = FOODS.get(carb.items[0].foodId);
      const before = carb.items[0].grams;
      const keep = host.timing ? Math.round(before * 0.5) : 0;
      const remove = Math.min(before - keep, r10((over / f.carb) * 100));
      if (remove <= 0) continue;
      const after = before - remove;
      if (after < 20) host.extras = host.extras.filter((e) => e !== carb);
      else { carb.items = [nutrientsFor(f.id, after)]; carb.totals = sum(carb.items); }
      refreshMeal(host);
      over -= ((after < 20 ? before : remove) * f.carb) / 100;
    }
  }
  // Close the fat gap with measured olive oil on the lunch salad.
  const fatGap = dayTargets.fatG - planningTotals(day).fat;
  if (fatGap >= 4) {
    const host = real.find((m) => m.slot === 'lunch' && m.timing !== 'pre') || real.find((m) => !m.timing) || real[0];
    const g = r5(Math.min(fatGap, 25));
    if (host && g > 0) { const it = nutrientsFor('olive_oil', g); host.extras.push({ kind: 'fat', ar: 'زيت زيتون على السلطة', items: [it], totals: sum([it]) }); refreshMeal(host); }
  }
  trimCalories(day, dayTargets, real, ctx.lib);
  setDayTotals(day);
  return day;
}

// Daily targets scale with the training actually scheduled that day (number and length of sessions).
function makeTargets(targets, prefs, athlete = {}) {
  const tr = targets.trainingDay || targets.restDay;
  const rest = targets.restDay || targets.trainingDay;
  const refLoad = Math.max(0.5, (athlete.sessionsPerWeek || 1) / Math.max(1, athlete.trainingDays || 1)) * (athlete.minutesPerSession || 60);
  const forDay = (sessions) => {
    if (!sessions.length || !targets.trainingDay) return { ...rest };
    const load = sessions.reduce((t, s) => t + s.duration, 0) / refLoad;
    const scale = (k) => Math.round(rest[k] + (tr[k] - rest[k]) * Math.min(2.2, load));
    return { kcal: scale('kcal'), proteinG: tr.proteinG, carbG: scale('carbG'), fatG: scale('fatG'), fiberG: scale('fiberG') };
  };
  if (prefs.carbStrategy !== 'even') return forDay;
  const week = [0, 1, 2, 3, 4, 5, 6].map((d) => forDay(prefs.schedule[d] || []));
  const avg = (k) => Math.round(week.reduce((t, x) => t + x[k], 0) / 7);
  const even = { kcal: avg('kcal'), proteinG: avg('proteinG'), carbG: avg('carbG'), fatG: avg('fatG'), fiberG: avg('fiberG') };
  return () => ({ ...even });
}

// dataMode 'reviewed_only': only recipes whose every ingredient has a human-reviewed value may be used.
function libraryFor(dataMode) {
  const all = listRecipes().recipes;
  return dataMode === 'reviewed_only' ? all.filter((r) => r.plan.reviewed) : all;
}

function generateWeekPlan({ targets, prefs, startDate, seed = 1, athlete = {}, dataMode = 'estimates', household = null }) {
  const lib = libraryFor(dataMode);
  if (dataMode === 'reviewed_only' && lib.filter((r) => r.plan.role === 'main').length < 10) {
    throw Object.assign(new Error('الإعداد يسمح بالقيم المراجعة بس، وعدد الوصفات المراجعة لسه ما يكفيش لعمل خطة.'), { code: 'NOT_ENOUGH_REVIEWED_DATA' });
  }
  const forDay = makeTargets(targets, prefs, athlete);
  const ctx = { prefs, lib, rand: rng(seed), used: new Map(), typeCount: new Map(), carbTurn: 0, dessertsLeft: prefs.dessertsPerWeek,
    sauces: lib.filter((r) => r.plan.role === 'sauce'), household: household && household.menu };
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(startDate, i);
    const sessions = prefs.schedule[parseDate(date).getUTCDay()] || [];
    days.push(buildDay(date, forDay(sessions), sessions, ctx));
  }
  const plan = finalize({ startDate, seed, prefs, athlete, targetsBase: targets, days });
  plan.dataMode = dataMode;
  if (household) {
    const meals = days.flatMap((d) => d.meals);
    plan.household = { name: household.name, sharedMeals: meals.filter((m) => m.shared).length, differentMeals: meals.filter((m) => m.sharedNote).length };
  }
  return plan;
}

function planCtx(plan, seed, carbTurn = 0) {
  const lib = libraryFor(plan.dataMode);
  const used = new Map();
  plan.days.forEach((d) => d.meals.forEach((m) => { if (m.recipeId) used.set(m.recipeId, (used.get(m.recipeId) || 0) + 1); }));
  return { prefs: plan.prefs, lib, rand: rng(seed), used, typeCount: new Map(), carbTurn, dessertsLeft: 0, sauces: lib.filter((r) => r.plan.role === 'sauce') };
}

// Replace one meal, keeping everything else in that day (added drinks/snacks are kept).
function swapMeal(plan, dayIndex, slotIdx, seed) {
  const day = plan.days[dayIndex];
  if (!day) throw Object.assign(new Error('اليوم غير موجود.'), { code: 'BAD_DAY' });
  const old = day.meals.find((m) => m.idx === slotIdx);
  if (!old || old.free) throw Object.assign(new Error('الوجبة غير موجودة.'), { code: 'BAD_SLOT' });
  const forced = {};
  // Household meals in the same day keep their dish and sides; the swapped meal leaves the household menu.
  const keepShared = householdMenu({ days: [{ ...day, meals: day.meals.filter((m) => m.shared && m.idx !== slotIdx) }] }, ['breakfast', 'lunch', 'dinner']);
  day.meals.forEach((m) => { if (m.idx !== slotIdx && m.recipeId && !m.shared) forced[m.idx] = m.recipeId; });
  const exclude = { [slotIdx]: [...(old.excluded || []), old.recipeId].filter(Boolean) };
  const ctx = planCtx(plan, seed, dayIndex);
  ctx.household = keepShared;
  const sessions = (plan.prefs.schedule[day.weekday] || []);
  const nd = buildDay(day.date, day.targets, sessions, ctx, forced, exclude);
  const nm = nd.meals.find((m) => m.idx === slotIdx);
  if (nm) nm.excluded = exclude[slotIdx].slice(-20);
  const added = day.added || [];
  plan.days[dayIndex] = nd;
  added.forEach((a) => applyAdded(nd, a.recipeId, a.servings, a.attachTo, a.compensate));
  setDayTotals(nd);
  return finalize(plan);
}

// ---- user-added drinks, snacks and sauces ----
function applyAdded(day, recipeId, servings, attachTo, compensate) {
  const r = listRecipes().recipes.find((x) => x.id === recipeId);
  const part = scaledRecipe(r, servings);
  const entry = { id: `${recipeId}-${(day.added || []).length}-${Date.now() % 100000}`, recipeId, ar: r.ar, role: r.plan.role, servings, attachTo, compensate,
    items: part.items, totals: part.totals, compensation: null };
  if (compensate && part.totals.carb >= 5) {
    // Take the same carbohydrate off carb sides: the attached meal first, then the later meals of the day.
    let need = part.totals.carb;
    const hosts = day.meals.filter((m) => !m.empty && !m.free && m.extras && m.extras.some((e) => e.kind === 'carb'));
    const ordered = [...hosts.filter((m) => m.idx === attachTo), ...hosts.filter((m) => m.idx !== attachTo).reverse()];
    const comp = [];
    for (const host of ordered) {
      if (need < 3) break;
      const carb = host.extras.find((e) => e.kind === 'carb');
      const f = FOODS.get(carb.items[0].foodId);
      const before = carb.items[0].grams;
      const remove = Math.min(before, Math.max(10, r10((need / f.carb) * 100)));
      if (remove <= 0) continue;
      carb.items = [nutrientsFor(f.id, before - remove)]; carb.totals = sum(carb.items);
      refreshMeal(host);
      need -= (remove * f.carb) / 100;
      comp.push({ mealIdx: host.idx, foodId: f.id, grams: remove, ar: f.ar });
    }
    if (comp.length) entry.compensation = comp;
  }
  day.added = [...(day.added || []), entry];
  return entry;
}
function addExtra(plan, dayIndex, recipeId, servings = 1, attachTo = null, compensate = true) {
  const day = plan.days[dayIndex];
  if (!day) throw Object.assign(new Error('اليوم غير موجود.'), { code: 'BAD_DAY' });
  const r = listRecipes().recipes.find((x) => x.id === recipeId);
  if (!r || !['drink', 'snack', 'sauce', 'dessert', 'side'].includes(r.plan.role) && !r.plan.slots.includes('snack')) {
    throw Object.assign(new Error('اختار مشروب أو سناك أو صوص من القايمة.'), { code: 'BAD_RECIPE' });
  }
  if (!allowed(r, plan.prefs, day.fasting)) throw Object.assign(new Error('الصنف ده فيه مكوّن ممنوع في تفضيلاتك أو في الصيام.'), { code: 'NOT_ALLOWED' });
  const s = Math.min(3, Math.max(0.5, Math.round(Number(servings) * 2) / 2 || 1));
  applyAdded(day, recipeId, s, attachTo, compensate);
  setDayTotals(day);
  return finalize(plan);
}
function removeExtra(plan, dayIndex, entryId) {
  const day = plan.days[dayIndex];
  const entry = day && (day.added || []).find((a) => a.id === entryId);
  if (!entry) throw Object.assign(new Error('الإضافة غير موجودة.'), { code: 'BAD_EXTRA' });
  for (const c of entry.compensation || []) {
    const host = day.meals.find((m) => m.idx === c.mealIdx);
    const carb = host && host.extras.find((e) => e.kind === 'carb' && e.items[0].foodId === c.foodId);
    if (carb) { carb.items = [nutrientsFor(c.foodId, carb.items[0].grams + c.grams)]; carb.totals = sum(carb.items); refreshMeal(host); }
  }
  day.added = day.added.filter((a) => a.id !== entryId);
  setDayTotals(day);
  return finalize(plan);
}

const GROUP_AR = { protein: 'بروتين', legume: 'بقوليات', dairy: 'ألبان وجبن', grain: 'حبوب ونشويات', starch: 'حبوب ونشويات', vegetable: 'خضار', herb: 'أعشاب', fruit: 'فاكهة', fat: 'زيوت ومكسرات', sweetener: 'سكر وعسل', condiment: 'صلصات وتوابل', spice: 'صلصات وتوابل', drink: 'مشروبات' };

function finalize(plan) {
  const all = plan.days.flatMap((d) => [...d.meals.flatMap(mealItems), ...(d.added || []).flatMap((a) => a.items)]);
  const byFood = new Map();
  for (const i of all) {
    if (i.foodId === 'water' || i.foodId === 'salt') continue;
    const f = FOODS.get(i.foodId);
    const cur = byFood.get(i.foodId) || { foodId: i.foodId, ar: f.ar, group: GROUP_AR[f.group] || 'أخرى', state: f.state, grams: 0, unitG: f.unitG || null, unitAr: f.unitAr || null };
    cur.grams += i.grams;
    byFood.set(i.foodId, cur);
  }
  plan.grocery = [...byFood.values()].map((g) => ({ ...g, grams: g.grams < 10 ? Math.ceil(g.grams) : Math.ceil(g.grams / 10) * 10,
    units: g.unitG ? `≈ ${Math.ceil(g.grams / g.unitG)} ${g.unitAr}` : null }))
    .sort((a, b) => (a.group === b.group ? b.grams - a.grams : a.group.localeCompare(b.group, 'ar')));
  plan.weekTotals = sum(all);
  plan.dataStatus = {
    status: plan.weekTotals.dataStatus,
    reviewedKcalPct: plan.weekTotals.reviewedKcalPct,
    label: plan.weekTotals.dataStatus === 'reviewed' ? 'كل القيم الغذائية في الخطة مراجعة.' : `القيم الغذائية تقديرية: ${plan.weekTotals.reviewedKcalPct}% بس من السعرات من أصناف اتراجعت. الأرقام للتخطيط، مش قيم معتمدة.`,
  };
  plan.micros = {
    ironMgPerDay: round(plan.days.reduce((t, d) => t + d.totals.ironMg, 0) / 7, 1),
    vitDugPerDay: round(plan.days.reduce((t, d) => t + d.totals.vitDug, 0) / 7, 1),
    ironRichMeals: plan.days.flatMap((d) => d.meals).filter((m) => m.ironRich).length,
    vitDRichMeals: plan.days.flatMap((d) => d.meals).filter((m) => m.vitDRich).length,
    ironCoveragePct: Math.round((plan.days.reduce((t, d) => t + (d.totals.ironCoverage || 0), 0) / 7) * 100),
    vitDCoveragePct: Math.round((plan.days.reduce((t, d) => t + (d.totals.vitDCoverage || 0), 0) / 7) * 100),
    calciumMgPerDay: Math.round(plan.days.reduce((t, d) => t + (d.totals.calciumMg || 0), 0) / 7),
    calciumCoveragePct: Math.round((plan.days.reduce((t, d) => t + (d.totals.calciumCoverage || 0), 0) / 7) * 100),
    // audit D3 (2026-10-22): the old note said calcium was not recorded and values were unreviewed — both stale.
    note: 'الأرقام حد أدنى: محسوبة من الأصناف اللي ليها قيمة للحديد أو فيتامين د أو الكالسيوم في قاعدة البيانات بس (نسبة التغطية بالجرام جنب كل واحد). أي صنف من غير قيمة مش بيتحسب صفر في الحقيقة.',
  };
  const a0 = plan.athlete || {};
  const dri = driFor({ age: a0.age, sex: a0.sex });
  if (dri) {
    plan.micros.dri = {
      ironMg: { rda: dri.ironMg.rda, ul: dri.ironMg.ul, pctOfRda: Math.round((plan.micros.ironMgPerDay / dri.ironMg.rda) * 100) },
      vitDug: { rda: dri.vitDIU.rdaUg, ul: dri.vitDIU.ulUg, pctOfRda: Math.round((plan.micros.vitDugPerDay / dri.vitDIU.rdaUg) * 100) },
      calciumMg: { rda: dri.calciumMg.rda, ul: dri.calciumMg.ul, pctOfRda: Math.round((plan.micros.calciumMgPerDay / dri.calciumMg.rda) * 100) },
      sources: dri.sources,
      note: 'RDA من الإرشادات الغذائية الأمريكية 2015–2020 (ملحق 7)، والحد الأعلى (UL) من Advanced Nutrition and Human Metabolism ط8. الحد الأعلى بيخص الأكل والمكملات مع بعض.',
    };
  }
  plan.proteinMix = Object.entries(plan.days.flatMap((d) => d.meals).filter((m) => isMain(m.slot) && m.proteinType)
    .reduce((o, m) => { o[m.proteinType] = (o[m.proteinType] || 0) + 1; return o; }, {})).map(([k, n]) => ({ type: k, ar: PROTEIN_TYPES[k] || k, meals: n }))
    .sort((a, b) => b.meals - a.meals);
  plan.approach = approach(plan);
  return plan;
}

function approach(plan) {
  const p = plan.prefs;
  const a = plan.athlete || {};
  const out = [];
  const tDays = plan.days.filter((d) => d.training);
  const double = plan.days.filter((d) => d.sessions.length === 2);
  const rest = plan.days.find((d) => !d.training);
  const trainDay = tDays[0];
  out.push(p.ramadan.enabled
    ? `نظام رمضان: فطار خفيف (تمر وماء وشوربة) الساعة ${p.ramadan.iftarTime}، والإفطار الرئيسي بعده، وسناك بعد التراويح، والسحور قبل الفجر (${p.ramadan.suhoorTime}).`
    : `${p.mealsPerDay} وجبات بين الصحيان (${p.wakeTime}) والنوم (${p.sleepTime})، وكل وجبة ليها ميعاد، والبروتين متوزع عليهم.`);
  if (p.carbStrategy === 'even') out.push(`نفس السعرات والكربوهيدرات كل يوم (${plan.days[0].targets.carbG} جم كربوهيدرات).`);
  else if (trainDay && rest) out.push(`الكربوهيدرات حسب التمرين: حوالي ${trainDay.targets.carbG} جم في يوم التمرين و${rest.targets.carbG} جم في يوم الراحة${double.length ? `، وأعلى في أيام الحصتين (${double[0].targets.carbG} جم)` : ''}.`);
  if (tDays.length) out.push(`التمرين: ${tDays.map((d) => `${d.dayAr} ${d.sessions.map((s) => s.start).join(' و')}`).join('، ')}. الوجبة اللي قبل التمرين بـ 1–4 ساعات قليلة الدهون والألياف، والوجبة اللي بعده خلال ساعة فيها كربوهيدرات وبروتين.`);
  if (double.length) out.push('أيام الحصتين: الوجبة اللي بين الحصتين بتعوّض وتجهز للتانية في نفس الوقت، فهي أعلى كربوهيدرات وأخف في الدهون.');
  const sport = SPORT_NUTRITION[a.sport];
  if (sport && a.sport !== 'general') out.push(`${sport.ar}: ${sport.kind === 'endurance' ? 'كربوهيدرات أعلى لأن الرياضة تحمل، وسوائل كفاية قبل وبعد الحصة.' : sport.kind === 'strength' ? 'بروتين 2 جم/كجم على الأقل، وكربوهيدرات معتدلة.' : 'كربوهيدرات قبل التمرين وتعويض السوائل.'}`);
  const phase = SEASON_PHASES[a.seasonPhase];
  if (phase) out.push(`مرحلة الموسم: ${phase.ar}.`);
  const fav = Object.entries(p.proteins).filter(([, v]) => v === 2).map(([k]) => PROTEIN_TYPES[k]);
  const never = Object.entries(p.proteins).filter(([, v]) => v === -1).map(([k]) => PROTEIN_TYPES[k]);
  if (fav.length) out.push(`بنكرر أكتر: ${fav.join('، ')}.`);
  if (never.length) out.push(`مستبعد تمامًا: ${never.join('، ')}.`);
  if (p.avoid.length) out.push(`بدون: ${p.avoid.map((x) => ALLERGENS[x]).join('، ')}.`);
  if (p.fasting.mode !== 'none') {
    const days = p.fasting.days.length ? p.fasting.days.map((d) => DAY_AR[d]).join('، ') : 'كل الأيام';
    out.push(`صيامي (${p.fasting.mode === 'vegan' ? 'من غير أي منتجات حيوانية' : 'مسموح السمك والجمبري'}) في: ${days}. البروتين في الأيام دي من البقوليات${p.fasting.mode === 'fish' ? ' والسمك' : ''}، وممكن يبقى أقل شوية من الهدف.`);
  }
  if (p.health.lowIron) out.push('نقص الحديد: الخطة بتكتّر الأكل الغني بالحديد ومعاه فيتامين سي. الشاي والقهوة بعد الأكل بساعة على الأقل، واللبن والجبن بعيد عن الوجبات الغنية بالحديد. أي مكمل بجرعة يكون بتوجيه الطبيب، مع إعادة التحليل.');
  if (p.health.lowVitD) out.push('نقص فيتامين د: الخطة بتكتّر السمك والسردين والبيض. التعرض للشمس على الدراعات والرجلين وقت الضهر من 10 لـ 30 دقيقة كام مرة في الأسبوع بيساعد. جرعة المكمل يحددها الطبيب حسب التحليل.');
  if (p.freeMeal.enabled && p.freeMeal.date) out.push(`الوجبة الحرة الجاية: ${p.freeMeal.date}. مرة في الشهر، ويفضل متبقاش قبل منافسة أو في يوم حصتين.`);
  return out;
}

// On-demand sauce suggestions for one meal: sauces that pair with the dish first, then the rest
// that the athlete's preferences / fasting day allow.
function sauceSuggestions(plan, dayIndex, slotIdx) {
  const day = plan.days[dayIndex];
  if (!day) throw Object.assign(new Error('اليوم غير موجود.'), { code: 'BAD_DAY' });
  const m = day.meals.find((x) => x.idx === slotIdx);
  if (!m || m.free || m.empty) throw Object.assign(new Error('الوجبة غير موجودة.'), { code: 'BAD_SLOT' });
  const sauces = listRecipes().recipes.filter((r) => r.plan.role === 'sauce' && allowed(r, plan.prefs, day.fasting));
  const fits = (sx) => sx.plan.pairsWith.includes(m.proteinType) || (/مكرونة/.test(m.recipeAr || '') && sx.plan.pairsWith.includes('pasta'));
  const card = (sx) => ({ id: sx.id, ar: sx.ar, kcal: sx.perServing.kcal, protein: sx.perServing.protein, carb: sx.perServing.carb, fat: sx.perServing.fat, pairs: fits(sx) });
  return { day: dayIndex, slot: slotIdx, mealAr: m.recipeAr, suggestions: [...sauces.filter(fits), ...sauces.filter((x) => !fits(x))].map(card) };
}

// Sleep duration vs. age recommendation (kealy2023, ch.4 table, p.46–47). Information only — never blocks.
function sleepAdvice(prefs, age) {
  const awake = (toMin(prefs.sleepTime) - toMin(prefs.wakeTime) + 1440) % 1440;
  const hours = Math.round(((1440 - awake) / 60) * 10) / 10;
  let rec = null;
  if (age != null) rec = age < 13 ? [9, 12] : age <= 18 ? [8, 10] : age <= 60 ? [7, null] : age <= 64 ? [7, 9] : [7, 8];
  const notes = [];
  if (rec && hours < rec[0]) notes.push(`نومك ${hours} ساعة، والموصى بيه لسنك ${rec[1] ? `${rec[0]}–${rec[1]}` : `${rec[0]} أو أكتر`} ساعات.`);
  if (hours < 8) notes.push('النوم أقل من 8 ساعات مرتبط بزيادة خطر الإصابات عند الرياضيين، وأقل من 7 ساعات بزيادة خطر العدوى.');
  return { hours, recommended: rec, notes, source: 'kealy2023' };
}

// The household menu a plan offers to the others: per date, per meal kind (first meal of that kind, not
// tied to training), the dish and its sides. Only recipe ids leave the plan — no amounts, no targets.
function householdMenu(plan, kinds) {
  const menu = {};
  for (const d of plan.days || []) {
    const day = {};
    for (const m of d.meals) {
      if (!kinds.includes(m.slot) || day[m.slot] || m.timing || !m.recipeId) continue;
      day[m.slot] = { recipeId: m.recipeId, vegId: (m.extras.find((e) => e.kind === 'veg') || {}).recipeId || null, carbKey: (m.extras.find((e) => e.kind === 'carb') || {}).key || null };
    }
    if (Object.keys(day).length) menu[d.date] = day;
  }
  return menu;
}

module.exports = { householdMenu, sauceSuggestions, sleepAdvice, generateWeekPlan, swapMeal, addExtra, removeExtra, validatePrefs, defaultTrainingDays, DEFAULT_PREFS, CARB_SOURCES, DAY_AR, daySlots, toMin, fmtMin, makeTargets };
