'use strict';
// node scripts/backup.js            → consistent online copy into EKLNI_BACKUP_DIR (default ./backups), keeps EKLNI_BACKUP_KEEP (14)
// Schedule it daily (cron / systemd timer). Copy the backup directory to encrypted off-site storage.
const path = require('node:path');
const { backup } = require('../src/backup');
const dbFile = process.env.EKLNI_DB || path.join(__dirname, '..', 'eklni.db');
const dir = process.env.EKLNI_BACKUP_DIR || path.join(__dirname, '..', 'backups');
try {
  const r = backup(dbFile, dir, { keep: Number(process.env.EKLNI_BACKUP_KEEP || 14) });
  console.log(`backup ok: ${r.file} (${r.users} users)${r.removed.length ? `; rotated out ${r.removed.length}` : ''}`);
} catch (e) { console.error(`backup FAILED: ${e.message}`); process.exitCode = 1; }
