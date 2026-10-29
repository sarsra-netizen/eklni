'use strict';
// Production configuration check. In production (NODE_ENV=production) the server refuses to start on errors.
const fs = require('node:fs');
const path = require('node:path');

function checkConfig(env = process.env) {
  const errors = []; const warnings = [];
  const prod = env.NODE_ENV === 'production';
  if (prod && env.COOKIE_SECURE !== '1') errors.push('COOKIE_SECURE=1 is required in production (serve over HTTPS).');
  if (prod && !env.EKLNI_DB) errors.push('EKLNI_DB must point to the database file on an encrypted volume.');
  if (env.EKLNI_TRIAL_DAYS != null && !(Number(env.EKLNI_TRIAL_DAYS) >= 0)) errors.push('EKLNI_TRIAL_DAYS must be a number ≥ 0.');
  if (env.EKLNI_FOOD_DATA_MODE && !['estimates', 'reviewed_only'].includes(env.EKLNI_FOOD_DATA_MODE)) errors.push('EKLNI_FOOD_DATA_MODE must be "estimates" or "reviewed_only".');
  if (env.EKLNI_OWNER_EMAILS) warnings.push('EKLNI_OWNER_EMAILS is ignored: grant owners with "node scripts/owner.js grant <email>".');
  if (prod && env.EKLNI_FOOD_DATA_MODE !== 'reviewed_only') warnings.push('Food values are shown as unreviewed estimates (EKLNI_FOOD_DATA_MODE=estimates).');
  if (prod && !env.EKLNI_BACKUP_DIR) warnings.push('EKLNI_BACKUP_DIR not set; schedule scripts/backup.js to an encrypted location.');
  if (env.EKLNI_DB && fs.existsSync(env.EKLNI_DB) && process.platform !== 'win32') {
    const mode = fs.statSync(env.EKLNI_DB).mode & 0o077;
    if (mode) warnings.push(`${path.basename(env.EKLNI_DB)} is readable by other users; run: chmod 600 ${env.EKLNI_DB}`);
  }
  if (env.NOTIFY_WEBHOOK_URL && !/^https:\/\//.test(env.NOTIFY_WEBHOOK_URL)) errors.push('NOTIFY_WEBHOOK_URL must use https.');
  // The app cannot verify disk encryption itself; the operator attests it after following SECURITY_PLAN.md §3.
  if (prod && env.EKLNI_DISK_ENCRYPTION_CONFIRMED !== '1') warnings.push('Disk encryption not attested (EKLNI_DISK_ENCRYPTION_CONFIRMED=1 after following SECURITY_PLAN.md §3). This is a human check, not a technical proof.');
  if (prod && !env.EKLNI_PUBLIC_URL) warnings.push('EKLNI_PUBLIC_URL not set; password-reset / verification links will be relative.');
  if (env.EKLNI_ALLOWED_ORIGINS && env.EKLNI_ALLOWED_ORIGINS.split(',').some((o) => o.trim() && !/^https:\/\/[^/]+$/.test(o.trim()))) errors.push('EKLNI_ALLOWED_ORIGINS entries must look like https://host (no path).');
  if (!!env.GOOGLE_CLIENT_ID !== !!env.GOOGLE_CLIENT_SECRET) errors.push('Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither (Google sign-in).');
  if (prod && env.GOOGLE_CLIENT_ID && !/^https:\/\//.test(env.EKLNI_PUBLIC_URL || '')) errors.push('Google sign-in in production needs EKLNI_PUBLIC_URL=https://… (the redirect URI registered in Google Cloud).');
  if (env.EKLNI_CHROMIUM) { try { fs.accessSync(env.EKLNI_CHROMIUM, fs.constants.X_OK); } catch { errors.push('EKLNI_CHROMIUM is set but is not an executable file.'); } }
  else if (prod) warnings.push('EKLNI_CHROMIUM not set: the nutrition PDF is built in the browser (text as image) instead of on the server.');
  return { production: prod, errors, warnings };
}

module.exports = { checkConfig };
