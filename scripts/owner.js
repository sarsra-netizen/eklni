'use strict';
// Grant / revoke / list platform owners. Run on the server (needs direct database access):
//   node scripts/owner.js grant owner@example.com
//   node scripts/owner.js revoke owner@example.com
//   node scripts/owner.js list
// Ownership is never derived from an e-mail at sign-up, because e-mail addresses are not verified.
const path = require('node:path');
const { openDb } = require('../src/db');

const [cmd, email] = process.argv.slice(2);
const db = openDb(process.env.EKLNI_DB || path.join(__dirname, '..', 'eklni.db'));
try {
  if (cmd === 'list') {
    for (const u of db.allUsers()) if (db.isOwner(u.id)) console.log(u.email);
  } else if (cmd === 'grant' || cmd === 'revoke') {
    const u = db.userByEmail(String(email || '').trim().toLowerCase());
    if (!u) { console.error('No user with that e-mail. The owner must register in the app first.'); process.exitCode = 1; }
    else if (cmd === 'grant') { db.grantOwner(u.id); console.log(`owner granted: ${u.email}`); }
    else { console.log(db.revokeOwner(u.id) ? `owner revoked: ${u.email}` : 'was not an owner'); }
  } else {
    console.error('usage: node scripts/owner.js grant|revoke <email> | list');
    process.exitCode = 1;
  }
} finally { db.close(); }
