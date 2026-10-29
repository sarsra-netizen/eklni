'use strict';
// Online backup (SQLite VACUUM INTO: a consistent copy while the server keeps running),
// verification, rotation and restore. Used by scripts/backup.js and scripts/restore.js.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function verify(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'file not found' };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const r = db.prepare('PRAGMA integrity_check').get();
    const ok = r && Object.values(r)[0] === 'ok';
    const users = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='users'").get().n === 1;
    if (!ok) return { ok: false, reason: 'integrity_check failed' };
    if (!users) return { ok: false, reason: 'not an Eklni database (no users table)' };
    return { ok: true, users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n };
  } catch (e) {
    return { ok: false, reason: `not a readable SQLite database (${e.code || e.message})` };
  } finally { if (db) db.close(); }
}

function backup(dbFile, dir, { keep = 14, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = path.join(dir, `eklni-${stamp(now)}.db`);
  if (fs.existsSync(out)) throw new Error(`backup already exists: ${out}`);
  const src = new DatabaseSync(dbFile);
  try { src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); } finally { src.close(); }
  fs.chmodSync(out, 0o600); // health data: owner read/write only
  const v = verify(out);
  if (!v.ok) { fs.rmSync(out, { force: true }); throw new Error(`backup failed verification: ${v.reason}`); }
  const all = fs.readdirSync(dir).filter((f) => /^eklni-\d{8}-\d{6}\.db$/.test(f)).sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of removed) fs.rmSync(path.join(dir, f), { force: true });
  return { file: out, users: v.users, removed };
}

// Restore replaces the live database file. The server MUST be stopped first.
function restore(backupFile, dbFile, { confirm = false, now = new Date() } = {}) {
  if (!confirm) return { ok: false, reason: 'restore overwrites the live database; re-run with --confirm after stopping the server' };
  const v = verify(backupFile);
  if (!v.ok) return { ok: false, reason: `backup rejected: ${v.reason}` };
  let saved = null;
  if (fs.existsSync(dbFile)) {
    saved = `${dbFile}.pre-restore-${stamp(now)}`;
    fs.copyFileSync(dbFile, saved);
    fs.chmodSync(saved, 0o600);
  }
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  fs.copyFileSync(backupFile, dbFile);
  fs.chmodSync(dbFile, 0o600);
  return { ok: true, users: v.users, previousSavedAs: saved };
}

module.exports = { backup, restore, verify, stamp };
