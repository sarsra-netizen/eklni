'use strict';
// Owner-assisted password reset when no e-mail gateway is configured (run on the server):
//   node scripts/reset-link.js user@example.com
// Prints a one-time link valid for 30 minutes. Give it to the user yourself (phone / in person).
const path = require('node:path');
const { openDb } = require('../src/db');
const { issueToken } = require('../src/security');
const email = String(process.argv[2] || '').trim().toLowerCase();
const db = openDb(process.env.EKLNI_DB || path.join(__dirname, '..', 'eklni.db'));
try {
  const u = db.userByEmail(email);
  if (!u) { console.error('No user with that e-mail.'); process.exitCode = 1; }
  else { const { token, expiresInMin } = issueToken(db, u.id, 'reset'); console.log(`${process.env.EKLNI_PUBLIC_URL || ''}/#reset=${token}  (valid ${expiresInMin} min, one use)`); }
} finally { db.close(); }
