'use strict';
// Android app (mobile/android): the bundled page is built offline-first, and the native shell keeps health data out of
// automatic cloud backups. The APK itself is built on GitHub Actions (.github/workflows/android.yml), not here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'assets', 'www', 'index.html');

test('mobile bundle: offline (no external URLs), strict CSP, mobile mode on, no demo seed or subscription lock', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'demo', 'build.js'), '--mobile'], { cwd: ROOT, stdio: 'pipe' });
  const html = fs.readFileSync(OUT, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /window\.__EKLNI_MOBILE__ = true/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'none'/);
  assert.doesNotMatch(html, /fonts\.googleapis|<link [^>]*href="https?:/, 'no external stylesheet or font');
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external script');
  assert.match(html, /if \(MOBILE\) \{ S = empty\(\); save\(\); \} else seedExample\(\);/, 'starts empty');
  assert.match(html, /const subOf = \(u\) => \(MOBILE \? \{ active: true/, 'no subscription lock offline');
  assert.match(html, /eklni-mobile-backup-v1/);
  assert.ok(html.length < 3 * 1024 * 1024);
});

test('android shell: no automatic cloud backup, file sharing only from the app cache, workflow tests before building', () => {
  const man = fs.readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  assert.match(man, /android:allowBackup="false"/);
  assert.match(man, /android:exported="false"\s+android:grantUriPermissions="true"/);
  assert.match(fs.readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml'), 'utf8'), /<cache-path name="shared" path="shared\/" \/>/);
  const act = fs.readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'java', 'app', 'eklni', 'mobile', 'MainActivity.java'), 'utf8');
  assert.match(act, /setAllowFileAccess\(false\)/);
  assert.match(act, /if \(APP_HOST\.equals\(u\.getHost\(\)\)\) return false;\s+openExternal\(u\);/, 'other origins never load inside the app');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'android.yml'), 'utf8');
  const order = ['run: npm test', 'run: npm run verify-fixes', 'run: node demo/build.js --mobile', 'run: gradle -p mobile/android assembleDebug'].map((k) => wf.indexOf(k));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), 'tests run before the APK is built');
  assert.doesNotMatch(wf, /password:\s*[^$\s]/i, 'no secrets written in the workflow');
});
