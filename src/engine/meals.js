'use strict';
const db = require('../data/foods.json');
const { round } = require('./calculator');

// Section 9 — Egyptian food integration. Values come only from the food database;
// proxy items are flagged so the UI shows them as estimates. No cost is computed.

const FOODS = new Map(db.foods.map((f) => [f.id, f]));

// Data trust. A value counts as reviewed ONLY when a named person reviewed it against a stated source on a
// date. Everything else is an estimate and every output that uses it is labelled as such — numbers that
// were typed in from reference knowledge are never presented as verified.
function trustOf(f) {
  if (f.proxy) return 'proxy';
  return f.reviewedAt && f.reviewedBy && f.source ? 'reviewed' : 'unreviewed';
}
const DATA_LABEL = {
  reviewed: 'قيم مراجعة',
  unreviewed: 'قيم تقديرية غير مراجعة',
  proxy: 'قيم بديل تقريبي',
};

function nutrientsFor(foodId, grams) {
  const f = FOODS.get(foodId);
  if (!f) throw new Error(`Unknown food ${foodId}`);
  const k = grams / 100;
  return {
    foodId, ar: f.ar, grams: Math.round(grams), state: f.state,
    kcal: round(f.kcal * k, 0), protein: round(f.protein * k, 1), carb: round(f.carb * k, 1),
    fat: round(f.fat * k, 1), fiber: f.fiber == null ? null : round(f.fiber * k, 1),
    // unknown micronutrient = null (not 0), so totals can report how complete they are
    ironMg: f.ironMg != null ? round(f.ironMg * k, 2) : null, vitDug: f.vitDug != null ? round(f.vitDug * k, 2) : null, calciumMg: f.calciumMg != null ? round(f.calciumMg * k, 1) : null,
    estimate: trustOf(f) !== 'reviewed', trust: trustOf(f), source: f.source,
    units: f.unitG ? `≈ ${round(grams / f.unitG, 1)} ${f.unitAr}` : null,
  };
}

function sum(items) {
  const t = { kcal: 0, protein: 0, carb: 0, fat: 0, fiber: 0 };
  let fiberComplete = true;
  for (const i of items) {
    t.kcal += i.kcal; t.protein += i.protein; t.carb += i.carb; t.fat += i.fat;
    if (i.fiber == null) fiberComplete = false; else t.fiber += i.fiber;
  }
  const kcalAll = items.reduce((s, i) => s + (i.kcal || 0), 0);
  const kcalReviewed = items.filter((i) => i.trust === 'reviewed').reduce((s, i) => s + (i.kcal || 0), 0);
  const allReviewed = items.length > 0 && items.every((i) => i.trust === 'reviewed');
  return { kcal: Math.round(t.kcal), protein: round(t.protein, 1), carb: round(t.carb, 1), fat: round(t.fat, 1), fiber: round(t.fiber, 1), fiberComplete,
    dataStatus: allReviewed ? 'reviewed' : 'estimate', reviewedKcalPct: kcalAll > 0 ? Math.round((kcalReviewed / kcalAll) * 100) : 0 };
}

// Recipe library: the original small recipes in foods.json + the oven-recipe collection in recipes.json.
const recipeDb = require('../data/recipes.json');
const RECIPES = [...db.recipes.map((r) => ({ servings: 1, category: 'egyptian_home', steps: [], tips: [], ...r })), ...recipeDb.recipes];
const OIL_IDS = new Set(['olive_oil', 'sunflower_oil', 'sesame_oil', 'ghee', 'butter']);
const CATEGORIES = {
  breakfast: 'فطار', snack: 'سناكس وقبل/بعد التمرين', main_chicken: 'أطباق فراخ', main_beef: 'أطباق لحمة', main_fish: 'سمك وجمبري',
  main_veg: 'بقوليات وبيض', eg_breakfast: 'فطار وأكل شارع مصري', eg_tabikh: 'طبيخ وطواجن', eg_mahshi: 'محاشي', eg_grill: 'مشويات ولحوم',
  eg_seafood: 'أسماك مصرية', chicken_oven: 'فراخ في الفرن', glass_noodles: 'شعيرية زجاج', egyptian_home: 'أكل بيتي',
  carb_sides: 'نشويات جانبية', salads: 'سلطات', eg_sides: 'أرز وشوربة وسلطات', eg_desserts: 'حلويات',
  fasting: 'صيامي', sauces: 'صوصات صحية', drinks: 'مشروبات',
};
const PROTEIN_TYPES = { chicken: 'فراخ وطيور', beef: 'لحمة', fish: 'سمك', seafood: 'جمبري ومأكولات بحرية', eggs: 'بيض', legumes: 'بقوليات', dairy: 'ألبان وجبن', mixed: 'متنوع' };
const ALLERGENS = { dairy: 'ألبان', gluten: 'جلوتين (قمح)', egg: 'بيض', fish: 'سمك', shellfish: 'جمبري ومحار', nuts: 'مكسرات', peanuts: 'فول سوداني', sesame: 'سمسم وطحينة', soy: 'صويا' };

// Planning metadata. Slots: which meals a recipe fits. Role: main / side / snack / dessert.
const DEFAULT_SLOTS = {
  breakfast: ['breakfast'], snack: ['snack'], eg_breakfast: ['breakfast', 'dinner'], eg_desserts: ['snack'],
  carb_sides: [], salads: [], eg_sides: [], eg_mahshi: ['lunch', 'dinner'],
};
const SLOT_OVERRIDES = {
  koshari: ['lunch', 'dinner'], hawawshi_light: ['lunch', 'dinner'], kebda_eskandarani: ['lunch', 'dinner', 'breakfast'],
  ful_oil: ['breakfast'], omelette: ['breakfast', 'dinner'], lentil_soup: ['lunch', 'dinner'], grilled_chicken_rice: ['lunch', 'dinner'],
  lesan_asfour_soup: ['lunch', 'dinner'],
};

function proteinTypeOf(items) {
  const by = {};
  let total = 0;
  for (const i of items) {
    const t = FOODS.get(i.foodId).proteinType;
    total += i.protein;
    if (t) by[t] = (by[t] || 0) + i.protein;
  }
  const animal = ['chicken', 'beef', 'fish', 'seafood'].map((t) => [t, by[t] || 0]).sort((a, b) => b[1] - a[1])[0];
  if (total > 0 && animal[1] >= 0.4 * total) return animal[0];
  const other = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  return other && total > 0 && other[1] >= 0.35 * total ? other[0] : 'mixed';
}

function planMeta(r, per, items) {
  const allergens = [...new Set(items.flatMap((i) => FOODS.get(i.foodId).allergens || []))];
  let role = r.role;
  if (!role) {
    if (r.category === 'eg_desserts') role = 'dessert';
    else if (r.category === 'snack') role = 'snack';
    else if (['carb_sides', 'salads', 'eg_sides'].includes(r.category) && !r.slots) role = 'side';
    else role = per.protein >= 15 || r.category === 'breakfast' || r.category === 'eg_breakfast' ? 'main' : 'side';
  }
  let slots = r.slots || SLOT_OVERRIDES[r.id] || DEFAULT_SLOTS[r.category] || ['lunch', 'dinner'];
  if (role === 'side' && !r.slots) slots = [];
  if (role === 'sauce' || role === 'drink') slots = role === 'drink' ? ['snack'] : [];
  const sideKind = role === 'side' ? (per.carb >= 25 && per.protein < 12 ? 'carb' : per.kcal <= 160 ? 'veg' : 'other') : null;
  const classes = items.map((i) => FOODS.get(i.foodId).fasting).filter(Boolean);
  const fasting = classes.includes('animal') ? 'none' : classes.includes('fish') ? 'fish' : 'vegan';
  const servings = r.servings;
  const ironPer = items.reduce((t, i) => t + (i.ironMg || 0), 0) / servings;
  const vitDPer = items.reduce((t, i) => t + (i.vitDug || 0), 0) / servings;
  const soup = /شوربة/.test(r.ar);
  return { role, slots, sideKind, allergens, proteinType: proteinTypeOf(items), timing: r.timing || [],
    totalMin: (r.prepMin || 0) + (r.cookMin || 0), fasting, soup,
    ironMg: round(ironPer, 1), vitDug: round(vitDPer, 1), vitC: items.some((i) => FOODS.get(i.foodId).vitCRich && i.grams >= 30),
    ironRich: ironPer >= 3.5, vitDRich: vitDPer >= 2.5, pairsWith: r.pairsWith || [],
    lowFiberFat: per.fiber <= 4 && per.fat <= 10,
    reviewed: items.every((i) => i.trust === 'reviewed') };
}

function recipe(id, scale = 1) {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown recipe ${id}`);
  const items = r.ingredients.map((i) => ({ ...nutrientsFor(i.food, i.g * scale), oil: OIL_IDS.has(i.food) }));
  const totals = sum(items);
  const servings = r.servings * scale;
  const per = (x, d = 1) => round(x / servings, d);
  const perServing = { kcal: Math.round(totals.kcal / servings), protein: per(totals.protein), carb: per(totals.carb), fat: per(totals.fat), fiber: per(totals.fiber),
    rawWeightG: Math.round(items.reduce((s, i) => s + i.grams, 0) / servings) };
  return {
    id: r.id, ar: r.ar, category: r.category, categoryAr: CATEGORIES[r.category] || r.category, idea: r.idea || null,
    method: r.method || null, servings: r.servings, prepMin: r.prepMin || null, cookMin: r.cookMin || null, ovenC: r.ovenC || null,
    items, totals, steps: r.steps, tips: r.tips, perServing,
    oilG: items.filter((i) => i.oil).reduce((s, i) => s + i.grams, 0),
    estimate: items.some((i) => i.estimate),
    plan: planMeta(r, perServing, items),
  };
}

let LIST_CACHE = null;
function listRecipes() {
  LIST_CACHE ||= { meta: recipeDb._meta, categories: CATEGORIES, proteinTypes: PROTEIN_TYPES, allergens: ALLERGENS, recipes: RECIPES.map((r) => recipe(r.id)) };
  return LIST_CACHE;
}

// Meal templates: role "protein" items are scaled to the meal protein target, "carb" items to the
// remaining carbohydrate, "fixed" items (vegetables, cooking oil) keep their amount.
const TEMPLATES = {
  pre_training: { ar: 'قبل التدريب', items: [
    { food: 'banana', g: 120, role: 'carb', min: 60, max: 240 },
    { food: 'dates', g: 20, role: 'carb', min: 0, max: 60 },
    { food: 'yogurt_lowfat', g: 170, role: 'protein', min: 100, max: 400 } ] },
  post_breakfast: { ar: 'فطار بعد التدريب', method: 'فول بزيت الزيتون + بيض مسلوق', items: [
    { food: 'fava_cooked', g: 150, role: 'carb', min: 100, max: 300 },
    { food: 'baladi_bread', g: 60, role: 'carb', min: 30, max: 180 },
    { food: 'egg_whole', g: 100, role: 'fixed' },
    { food: 'egg_white', g: 66, role: 'protein', min: 0, max: 200 },
    { food: 'olive_oil', g: 5, role: 'fixed', oil: true },
    { food: 'tomato', g: 100, role: 'fixed' }, { food: 'cucumber', g: 100, role: 'fixed' } ] },
  breakfast: { ar: 'فطار', method: 'فول بزيت الزيتون + بيض مسلوق', items: [
    { food: 'fava_cooked', g: 150, role: 'carb', min: 100, max: 250 },
    { food: 'baladi_bread', g: 40, role: 'carb', min: 0, max: 120 },
    { food: 'egg_whole', g: 100, role: 'fixed' },
    { food: 'egg_white', g: 66, role: 'protein', min: 0, max: 200 },
    { food: 'olive_oil', g: 5, role: 'fixed', oil: true },
    { food: 'tomato', g: 100, role: 'fixed' }, { food: 'cucumber', g: 100, role: 'fixed' } ] },
  lunch_chicken: { ar: 'غداء', method: 'فراخ مشوية (وزن مطهو) + أرز مسلوق + سلطة', items: [
    { food: 'chicken_breast_cooked', g: 150, role: 'protein', min: 80, max: 250 },
    { food: 'rice_white_cooked', g: 200, role: 'carb', min: 80, max: 450 },
    { food: 'sunflower_oil', g: 7, role: 'fixed', oil: true },
    { food: 'cucumber', g: 100, role: 'fixed' }, { food: 'tomato', g: 100, role: 'fixed' } ] },
  lunch_fish: { ar: 'غداء', method: 'بلطي مشوي (وزن مطهو) + بطاطس مسلوقة + سلطة', items: [
    { food: 'tilapia_cooked', g: 180, role: 'protein', min: 100, max: 300 },
    { food: 'potato_boiled', g: 250, role: 'carb', min: 100, max: 500 },
    { food: 'olive_oil', g: 5, role: 'fixed', oil: true },
    { food: 'carrot', g: 50, role: 'fixed' }, { food: 'tomato', g: 100, role: 'fixed' } ] },
  snack: { ar: 'سناك', items: [
    { food: 'yogurt_lowfat', g: 170, role: 'protein', min: 100, max: 400 },
    { food: 'oats_dry', g: 30, role: 'carb', min: 0, max: 80 },
    { food: 'apple', g: 150, role: 'fixed' } ] },
  dinner: { ar: 'عشاء', method: 'جبن قريش + عيش بلدي + خضار', items: [
    { food: 'areesh_cheese', g: 150, role: 'protein', min: 80, max: 300 },
    { food: 'baladi_bread', g: 60, role: 'carb', min: 0, max: 180 },
    { food: 'sweet_potato_baked', g: 0, role: 'carb', min: 0, max: 250 },
    { food: 'cucumber', g: 150, role: 'fixed' }, { food: 'olive_oil', g: 5, role: 'fixed', oil: true } ] },
};

const r5 = (g) => Math.max(0, Math.round(g / 5) * 5);

function buildMeal(key, target) {
  const tpl = TEMPLATES[key];
  const grams = tpl.items.map((i) => i.g);
  const calc = () => tpl.items.map((i, idx) => nutrientsFor(i.food, grams[idx]));
  for (let pass = 0; pass < 4; pass++) {
    let items = calc();
    // protein
    const protIdx = tpl.items.map((i, idx) => (i.role === 'protein' ? idx : -1)).filter((x) => x >= 0);
    const protOther = items.reduce((s, it, idx) => (protIdx.includes(idx) ? s : s + it.protein), 0);
    const protCur = protIdx.reduce((s, idx) => s + items[idx].protein, 0);
    const need = target.protein - protOther;
    if (protIdx.length && protCur > 0) {
      const f = Math.max(0, need) / protCur;
      protIdx.forEach((idx) => { const t = tpl.items[idx]; grams[idx] = Math.min(t.max, Math.max(t.min, grams[idx] * f)); });
    } else if (protIdx.length && need > 0) {
      protIdx.forEach((idx) => { grams[idx] = Math.max(tpl.items[idx].min, 50); });
    }
    items = calc();
    // carbohydrate
    const carbIdx = tpl.items.map((i, idx) => (i.role === 'carb' ? idx : -1)).filter((x) => x >= 0);
    const carbOther = items.reduce((s, it, idx) => (carbIdx.includes(idx) ? s : s + it.carb), 0);
    const carbCur = carbIdx.reduce((s, idx) => s + items[idx].carb, 0);
    const cneed = Math.max(0, target.carb - carbOther);
    if (carbCur > 0) {
      const f = cneed / carbCur;
      carbIdx.forEach((idx) => { const t = tpl.items[idx]; grams[idx] = Math.min(t.max, Math.max(t.min, grams[idx] * f)); });
    } else if (cneed > 0) {
      // start an empty carb slot (e.g. sweet potato) when the others are maxed out
      const idx = carbIdx.find((i) => grams[i] === 0);
      if (idx != null) grams[idx] = Math.min(tpl.items[idx].max, 100);
    }
  }
  const items = tpl.items.map((i, idx) => ({ ...nutrientsFor(i.food, r5(grams[idx])), oil: !!i.oil })).filter((i) => i.grams > 0);
  return { key, ar: tpl.ar, method: tpl.method || null, items, totals: sum(items), target, oilG: items.filter((i) => i.oil).reduce((s, i) => s + i.grams, 0) };
}

const SLOTS = {
  training: [
    { key: 'pre_training', p: 0.12, c: 0.2 },
    { key: 'post_breakfast', p: 0.3, c: 0.3 },
    { key: 'lunch', p: 0.33, c: 0.3 },
    { key: 'dinner', p: 0.25, c: 0.2 },
  ],
  rest: [
    { key: 'breakfast', p: 0.25, c: 0.3 },
    { key: 'lunch', p: 0.33, c: 0.35 },
    { key: 'snack', p: 0.12, c: 0.15 },
    { key: 'dinner', p: 0.3, c: 0.2 },
  ],
};

// dayTargets: { kcal, proteinG, carbG, fatG, fiberG }
function buildDayPlan(dayTargets, { type = 'training', variant = 0 } = {}) {
  const meals = SLOTS[type].map((s) => {
    const key = s.key === 'lunch' ? (variant % 2 ? 'lunch_fish' : 'lunch_chicken') : s.key;
    return buildMeal(key, { protein: dayTargets.proteinG * s.p, carb: dayTargets.carbG * s.c });
  });
  // Close the fat gap with measured olive oil on the salad (counted explicitly).
  let totals = sum(meals.flatMap((m) => m.items));
  const fatGap = dayTargets.fatG - totals.fat;
  if (fatGap >= 3) {
    const g = r5(Math.min(fatGap, 25));
    if (g > 0) {
      // split between lunch and dinner salads so no single meal gets a large amount
      const targetsM = [meals.find((m) => m.key.startsWith('lunch')), meals.find((m) => m.key === 'dinner')].filter(Boolean);
      const parts = targetsM.length === 2 && g >= 10 ? [r5(g / 2), g - r5(g / 2)] : [g];
      parts.forEach((pg, i) => {
        const m = targetsM[i] || meals[0];
        if (pg <= 0) return;
        m.items.push({ ...nutrientsFor('olive_oil', pg), oil: true, note: 'زيت زيتون مُقاس على السلطة لاستكمال الدهون' });
        m.totals = sum(m.items); m.oilG += pg;
      });
      totals = sum(meals.flatMap((m) => m.items));
    }
  }
  const diff = {
    kcal: totals.kcal - dayTargets.kcal,
    protein: round(totals.protein - dayTargets.proteinG, 0),
    carb: round(totals.carb - dayTargets.carbG, 0),
    fat: round(totals.fat - dayTargets.fatG, 0),
  };
  const notes = [
    'الأوزان المكتوبة "مطهو" تعني بعد الطهي، و"نيئ" قبل الطهي. لا تخلط بينهما عند الوزن.',
    'الزيت محسوب بالجرام في كل وجبة؛ أي زيت أو سمن إضافي يغير السعرات.',
    'العناصر المعلّمة "تقديري" تستخدم أقرب بديل في قاعدة البيانات لعدم توفر قيمة مصرية موثقة.',
  ];
  if (Math.abs(diff.kcal) > dayTargets.kcal * 0.07) notes.push(`الخطة تبعد ${diff.kcal} سعرة عن الهدف بسبب حدود الكميات؛ عدّل الحصص يدويًا إن لزم.`);
  return { type, meals, totals, targets: dayTargets, diff, notes, hasEstimates: meals.some((m) => m.items.some((i) => i.estimate)), costIncluded: false };
}

// Data-quality summary for the food table: which fields are filled, how many items were reviewed.
const TRACKED = ['kcal', 'protein', 'carb', 'fat', 'fiber', 'ironMg', 'vitDug', 'calciumMg'];
function foodCompleteness(f) {
  const known = TRACKED.filter((k) => f[k] != null);
  return { known, missing: TRACKED.filter((k) => f[k] == null), pct: Math.round((known.length / TRACKED.length) * 100) };
}
function foodQuality() {
  const foods = db.foods;
  const byTrust = { reviewed: 0, unreviewed: 0, proxy: 0 };
  for (const f of foods) byTrust[trustOf(f)] += 1;
  const fieldCoverage = Object.fromEntries(TRACKED.map((k) => [k, Math.round((foods.filter((f) => f[k] != null).length / foods.length) * 100)]));
  const recipesReviewed = RECIPES.filter((r) => r.ingredients.every((i) => FOODS.get(i.food) && trustOf(FOODS.get(i.food)) === 'reviewed')).length;
  return { foods: foods.length, reviewed: byTrust.reviewed, unreviewed: byTrust.unreviewed, proxies: byTrust.proxy, byTrust, recipes: RECIPES.length, recipesReviewed, fieldCoverage,
    note: 'نسبة الأطعمة اللي ليها قيمة مسجلة لكل عنصر. القيمة الناقصة بتتسجل null مش صفر.' };
}

// Audit 2026-10-22 (D2): where the numbers in a plan come from — computed from the plan's own items, so a report
// never states a source that the plan does not use.
const SOURCE_FAMILIES = [
  [/FNDDS/i, 'USDA FNDDS 2021-2023'], [/المعهد|NNI/i, 'المعهد القومي للتغذية (مصر) 2006'], [/Foundation/i, 'USDA Foundation Foods'], [/SR Legacy|NDB/i, 'USDA SR Legacy'],
];
function sourceFamily(src) { for (const [re, name] of SOURCE_FAMILIES) if (re.test(src || '')) return name; return 'قيمة ثابتة / أخرى'; }
function provenanceOf(items) {
  const by = new Map(); let total = 0, reviewed = 0; const proxies = new Map(); const reviewers = new Set();
  for (const i of items) {
    const f = FOODS.get(i.foodId); if (!f) continue;
    const k = Math.max(0, i.kcal || 0); total += k;
    const fam = sourceFamily(f.source); by.set(fam, (by.get(fam) || 0) + k);
    if (trustOf(f) === 'reviewed') { reviewed += k; if (f.reviewedBy) reviewers.add(f.reviewedBy); }
    if (trustOf(f) === 'proxy') proxies.set(f.id, f.ar);
  }
  const pct = (x) => (total > 0 ? Math.round((x / total) * 100) : 0);
  return { sources: [...by.entries()].sort((a, b) => b[1] - a[1]).map(([name, k]) => ({ name, kcalPct: pct(k) })),
    reviewedKcalPct: pct(reviewed), reviewers: [...reviewers], proxies: [...proxies.values()] };
}

module.exports = { provenanceOf, sourceFamily, trustOf, DATA_LABEL, foodCompleteness, foodQuality, buildDayPlan, buildMeal, recipe, listRecipes, RECIPES, nutrientsFor, sum, FOODS, PROTEIN_TYPES, ALLERGENS, foodsMeta: db._meta };
