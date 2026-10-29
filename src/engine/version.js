'use strict';
// Version of the calculation engine (formulas, constants and rules), stamped on every plan and report so a
// result can be traced to the method that produced it. Bump on ANY change to a formula, constant or rule
// and add a line to CHANGELOG.md. Plans created before 2026-10-22 have no stamp.
const CALC_VERSION = '2026.10.22-1';
module.exports = { CALC_VERSION };
