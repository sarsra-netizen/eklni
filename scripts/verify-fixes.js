'use strict';
// Runs the full test suite (TAP) and checks that every test listed in data/review/fix-verification.json
// exists and passed. Prints a table; exit code 1 on any failure or missing test.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
const run = spawnSync(process.execPath, ['--no-warnings', '--test', '--test-reporter=tap', ...files], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tap = run.stdout;
const ok = new Set(); const bad = new Set();
for (const m of tap.matchAll(/^\s*(ok|not ok) \d+ - (.+?)(?: # .*)?$/gm)) (m[1] === 'ok' ? ok : bad).add(m[2].trim());
const map = JSON.parse(fs.readFileSync(path.join(root, 'data', 'review', 'fix-verification.json'), 'utf8'));
let problems = 0;
for (const f of map.fixes) {
  const states = f.tests.map((t) => (bad.has(t) ? 'FAIL' : ok.has(t) ? 'pass' : 'MISSING'));
  const status = states.every((s) => s === 'pass') ? 'verified by tests' : 'NOT VERIFIED';
  if (status !== 'verified by tests') problems += 1;
  console.log(`${f.id.padEnd(14)} ${status.padEnd(18)} ${f.tests.length} test(s)${states.some((s) => s !== 'pass') ? ` → ${f.tests.filter((t, i) => states[i] !== 'pass').map((t, i) => `${t} [${states.filter((s) => s !== 'pass')[i]}]`).join('; ')}` : ''}`);
}
const summary = (k) => (new RegExp(`^# ${k} (\\d+)`, 'm').exec(tap) || [])[1];
console.log(`\nsuite: tests ${summary('tests')}, pass ${summary('pass')}, fail ${summary('fail')}, skipped ${summary('skipped')}, todo ${summary('todo')}`);
if (problems || summary('fail') !== '0') process.exitCode = 1;
