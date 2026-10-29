'use strict';

// Dietary Reference Intakes for the micronutrients the app tracks (iron, calcium, vitamin D).
// RDA: 2015–2020 Dietary Guidelines for Americans, Appendix 7, Table A7-1 (source: IOM) — ref "dga2015".
// UL:  Gropper, Smith & Carr, Advanced Nutrition and Human Metabolism 8th ed., front-matter UL tables — ref "gropper2022".
// Values are copied from those tables; nothing here is estimated. Pregnancy/lactation are not modelled
// (the app refers those users to a professional instead).

const IU_PER_UG_VITD = 40;

// [minAge, maxAge, female, male]
const RDA = {
  calciumMg: [[1, 3, 700, 700], [4, 8, 1000, 1000], [9, 13, 1300, 1300], [14, 18, 1300, 1300], [19, 50, 1000, 1000], [51, 70, 1200, 1000], [71, 200, 1200, 1200]],
  ironMg: [[1, 3, 7, 7], [4, 8, 10, 10], [9, 13, 8, 8], [14, 18, 15, 11], [19, 50, 18, 8], [51, 200, 8, 8]],
  vitDIU: [[1, 70, 600, 600], [71, 200, 800, 800]],
};
// UL is the same for both sexes in these tables.
const UL = {
  calciumMg: [[1, 8, 2500], [9, 18, 3000], [19, 50, 2500], [51, 200, 2000]],
  ironMg: [[1, 13, 40], [14, 200, 45]],
  vitDIU: [[1, 3, 2500], [4, 8, 3000], [9, 200, 4000]],
};

const LABELS = { calciumMg: 'الكالسيوم (ملجم)', ironMg: 'الحديد (ملجم)', vitDIU: 'فيتامين د (وحدة دولية)' };

function lookup(table, age, sex) {
  const row = table.find((r) => age >= r[0] && age <= r[1]);
  if (!row) return null;
  if (row.length === 3) return row[2];
  return sex === 'male' ? row[3] : row[2];
}

function driFor({ age, sex }) {
  if (!(age >= 1) || (sex !== 'male' && sex !== 'female')) return null;
  const out = {};
  for (const k of Object.keys(RDA)) {
    out[k] = { rda: lookup(RDA[k], age, sex), ul: lookup(UL[k], age, sex), label: LABELS[k] };
  }
  out.vitDIU.rdaUg = out.vitDIU.rda / IU_PER_UG_VITD;
  out.vitDIU.ulUg = out.vitDIU.ul / IU_PER_UG_VITD;
  out.sources = { rda: 'dga2015', ul: 'gropper2022' };
  return out;
}

// Compares an intake (food only) against RDA/UL. `intake` may hold null for unknown values —
// unknown is reported as unknown, never as zero.
function compareIntake(intake, dri, { complete = true } = {}) {
  const res = {};
  for (const k of ['calciumMg', 'ironMg', 'vitDIU']) {
    const v = intake[k];
    const d = dri[k];
    if (v == null) { res[k] = { status: 'unknown', value: null, rda: d.rda, ul: d.ul }; continue; }
    const pct = Math.round((v / d.rda) * 100);
    let status = 'ok';
    if (d.ul != null && v > d.ul) status = 'above_ul';
    else if (pct < 100) status = complete ? 'below_rda' : 'incomplete_data';
    res[k] = { status, value: Math.round(v * 10) / 10, rda: d.rda, ul: d.ul, pctOfRda: pct };
  }
  return res;
}

module.exports = { driFor, compareIntake, RDA, UL, IU_PER_UG_VITD };
