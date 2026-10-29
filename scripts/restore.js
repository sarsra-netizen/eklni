'use strict';
// Stop the server first, then:  node scripts/restore.js backups/eklni-20261021-120000.db --confirm
// The current database is kept as <db>.pre-restore-<time> so a restore can itself be undone.
const path = require('node:path');
const { restore } = require('../src/backup');
const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/restore.js <backup.db> --confirm'); process.exit(1); }
const dbFile = process.env.EKLNI_DB || path.join(__dirname, '..', 'eklni.db');
const r = restore(path.resolve(file), dbFile, { confirm: process.argv.includes('--confirm') });
if (!r.ok) { console.error(`restore refused: ${r.reason}`); process.exitCode = 1; }
else console.log(`restored ${r.users} users into ${dbFile}${r.previousSavedAs ? `; previous database saved as ${r.previousSavedAs}` : ''}`);
