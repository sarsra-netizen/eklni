'use strict';
// Backup / restore and production configuration checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { backup, restore, verify } = require('../src/backup');
const { checkConfig } = require('../src/config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-ops-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('backup: consistent copy of a live database, verified, owner-only permissions, rotation', () => {
  const live = path.join(dir, 'live.db');
  const db = openDb(live);
  db.createUser('a@x.test', 'scrypt$x$y');
  db.createUser('b@x.test', 'scrypt$x$y');
  const bdir = path.join(dir, 'backups');
  const r = backup(live, bdir, { keep: 2, now: new Date('2026-10-21T10:00:00Z') }); // database still open (online backup)
  assert.equal(r.users, 2);
  assert.equal(verify(r.file).ok, true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(r.file).mode & 0o077, 0, 'no group/other access');
  backup(live, bdir, { keep: 2, now: new Date('2026-10-22T10:00:00Z') });
  const r3 = backup(live, bdir, { keep: 2, now: new Date('2026-10-23T10:00:00Z') });
  assert.equal(fs.readdirSync(bdir).length, 2);
  assert.deepEqual(r3.removed, ['eklni-20261021-100000.db']);
  db.close();
});

test('restore: refuses without confirmation or with a bad file; keeps the previous database', () => {
  const live = path.join(dir, 'live2.db');
  const db = openDb(live);
  db.createUser('keep@x.test', 'scrypt$x$y');
  const b = backup(live, path.join(dir, 'b2'), { now: new Date('2026-10-21T11:00:00Z') });
  db.createUser('later@x.test', 'scrypt$x$y');
  db.close();
  assert.equal(restore(b.file, live).ok, false, 'needs --confirm');
  const junk = path.join(dir, 'junk.db');
  fs.writeFileSync(junk, 'not a database');
  assert.equal(restore(junk, live, { confirm: true }).ok, false);
  const r = restore(b.file, live, { confirm: true, now: new Date('2026-10-21T12:00:00Z') });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(r.previousSavedAs));
  const after = openDb(live);
  assert.equal(after.allUsers().length, 1, 'state is back to the backup');
  after.close();
});

test('production config: refuses unsafe settings', () => {
  const bad = checkConfig({ NODE_ENV: 'production' });
  assert.ok(bad.errors.some((e) => /COOKIE_SECURE/.test(e)));
  assert.ok(bad.errors.some((e) => /EKLNI_DB/.test(e)));
  assert.ok(checkConfig({ NOTIFY_WEBHOOK_URL: 'http://x' }).errors.length === 1);
  assert.ok(checkConfig({ EKLNI_OWNER_EMAILS: 'a@b.c' }).warnings.some((w) => /ignored/.test(w)));
  const ok = checkConfig({ NODE_ENV: 'production', COOKIE_SECURE: '1', EKLNI_DB: path.join(dir, 'none.db'), EKLNI_FOOD_DATA_MODE: 'reviewed_only', EKLNI_BACKUP_DIR: dir });
  assert.deepEqual(ok.errors, []);
});

test('modules shared with the browser demo use no Node built-ins and no unguarded process.env', () => {
  const files = ['service.js', 'academy.js', 'account.js', 'notify.js', 'subscription.js', 'pro.js', 'nutritionDoc.js', 'report.js',
    ...fs.readdirSync(path.join(__dirname, '..', 'src', 'engine')).map((f) => `engine/${f}`)];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.doesNotMatch(src, /require\(['"]node:/, `${f} requires a Node built-in`);
    for (const line of src.split('\n')) if (/process\.env/.test(line) && !/typeof process/.test(line) && !/^\s*\/\//.test(line)) assert.fail(`${f}: unguarded process.env → ${line.trim()}`);
  }
});

test('HSTS is sent only when secure cookies (HTTPS) are configured', async () => {
  const { createApp } = require('../src/server');
  for (const [secure, expect] of [[true, true], [false, false]]) {
    const a = createApp({ dbPath: path.join(dir, `hsts-${secure}.db`), secureCookies: secure, notifications: false });
    await new Promise((r) => a.server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${a.server.address().port}/api/meta`);
    a.server.close();
    assert.equal(!!res.headers.get('strict-transport-security'), expect);
  }
});
