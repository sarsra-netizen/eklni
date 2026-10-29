'use strict';
const { DatabaseSync } = require('node:sqlite');

// SQLite persistence (Node built-in). Every query that touches user data is scoped by user_id.
const PLAN_VERSIONS = 30;

function openDb(path) {
  const db = new DatabaseSync(path);
  // health data: the database file is readable by its owner only
  try { if (path !== ':memory:') require('node:fs').chmodSync(path, 0o600); } catch { /* not supported */ }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      input_json TEXT NOT NULL, plan_json TEXT NOT NULL,
      start_date TEXT NOT NULL, start_weight REAL NOT NULL, target_weight REAL NOT NULL, weekly_rate_kg REAL NOT NULL,
      calorie_adjustment INTEGER NOT NULL DEFAULT 0, last_projection TEXT);
    CREATE TABLE IF NOT EXISTS weights (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE, date TEXT NOT NULL, weight_kg REAL NOT NULL,
      UNIQUE(goal_id, date));
    CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE, week INTEGER NOT NULL, data_json TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE(goal_id, week));
    CREATE TABLE IF NOT EXISTS adjustments (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
      kind TEXT NOT NULL, action TEXT NOT NULL, kcal_change INTEGER NOT NULL DEFAULT 0, reasons_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', decided_at TEXT, decision_note TEXT);
    CREATE TABLE IF NOT EXISTS prefs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS weekplans (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS competitions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS screenings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data_json TEXT NOT NULL,
      consent_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS hydration_logs (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS hydration_user ON hydration_logs(user_id, date);
    CREATE TABLE IF NOT EXISTS academies (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships (
      academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin','coach','dietitian','athlete','parent')),
      display_name TEXT, created_at TEXT NOT NULL, PRIMARY KEY (academy_id, user_id, role));
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY, academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      role TEXT NOT NULL, athlete_id INTEGER, created_by INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_by INTEGER, used_at TEXT);
    CREATE TABLE IF NOT EXISTS guardians (
      academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, PRIMARY KEY (academy_id, parent_id, athlete_id));
    CREATE TABLE IF NOT EXISTS sharing (
      academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE,
      athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      share_health INTEGER NOT NULL DEFAULT 0, decided_by INTEGER NOT NULL, decided_at TEXT NOT NULL,
      PRIMARY KEY (academy_id, athlete_id));
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, plan TEXT NOT NULL, status TEXT NOT NULL,
      starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subscription_events (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, at TEXT NOT NULL,
      action TEXT NOT NULL, months INTEGER NOT NULL DEFAULT 0, ends_on TEXT, by_user INTEGER, note TEXT);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, due_key TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT,
      external_status TEXT NOT NULL DEFAULT 'pending', external_attempts INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, due_key));
    CREATE TABLE IF NOT EXISTS professionals (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, license_no TEXT NOT NULL, issuer TEXT NOT NULL,
      status TEXT NOT NULL, submitted_at TEXT NOT NULL, decided_at TEXT, decided_by INTEGER, note TEXT);
    CREATE TABLE IF NOT EXISTS pro_subscriptions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
      updated_by INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS throttle_events (key TEXT NOT NULL, at_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS throttle_key ON throttle_events(key, at_ms);
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('reset','verify')), expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS minor_consents (
      athlete_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      guardian_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      academy_id INTEGER NOT NULL REFERENCES academies(id) ON DELETE CASCADE, granted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calorie_overrides (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, kcal INTEGER NOT NULL,
      starts_on TEXT NOT NULL, ends_on TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meal_logs (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, goal_id INTEGER NOT NULL, date TEXT NOT NULL, key TEXT NOT NULL,
      entry TEXT NOT NULL, logged_at TEXT NOT NULL, PRIMARY KEY (user_id, date, key));
    CREATE TABLE IF NOT EXISTS plan_reviews (
      id INTEGER PRIMARY KEY, athlete_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, goal_id INTEGER NOT NULL,
      reviewer_id INTEGER REFERENCES users(id) ON DELETE SET NULL, academy_id INTEGER REFERENCES academies(id) ON DELETE SET NULL,
      decision TEXT NOT NULL, note TEXT, fingerprint TEXT NOT NULL, calc_version TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS plan_reviews_goal ON plan_reviews(athlete_id, goal_id, id);
    CREATE TABLE IF NOT EXISTS self_waivers (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, accepted_at TEXT NOT NULL, text_version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      shared_meals TEXT NOT NULL DEFAULT 'breakfast,lunch,dinner', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS household_members (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      display_name TEXT, joined_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS household_invites (
      code_hash TEXT PRIMARY KEY, household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, used_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
    CREATE TABLE IF NOT EXISTS user_identities (
      provider TEXT NOT NULL, subject TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, PRIMARY KEY (provider, subject));
    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      html TEXT NOT NULL, created_at TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at TEXT, views INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS platform_owners (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, granted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS academy_branding (
      academy_id INTEGER PRIMARY KEY REFERENCES academies(id) ON DELETE CASCADE, signature TEXT, logo TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, academy_id INTEGER, actor_id INTEGER NOT NULL, action TEXT NOT NULL, target_id INTEGER);
  `);
  try { db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT'); } catch { /* column exists */ }
  try { db.exec("ALTER TABLE academies ADD COLUMN kind TEXT NOT NULL DEFAULT 'academy'"); } catch { /* column exists */ }
  // migration: plan versions keep a reason (older databases lack the column)
  try { db.exec('ALTER TABLE weekplans ADD COLUMN reason TEXT'); } catch { /* column exists */ }

  const q = (sql) => db.prepare(sql);
  const now = () => new Date().toISOString();

  return {
    raw: db,
    close: () => db.close(),
    createUser: (email, hash) => q('INSERT INTO users (email, pass_hash, created_at) VALUES (?, ?, ?)').run(email, hash, now()).lastInsertRowid,
    userByEmail: (email) => q('SELECT * FROM users WHERE email = ?').get(email),
    userById: (id) => q('SELECT id, email, created_at FROM users WHERE id = ?').get(id),
    // ---- account export / deletion / retention ----
    allGoals: (userId) => q('SELECT id, created_at, active, input_json, plan_json, start_date FROM goals WHERE user_id = ? ORDER BY id').all(userId)
      .map((g) => ({ id: g.id, createdAt: g.created_at, active: !!g.active, startDate: g.start_date, input: JSON.parse(g.input_json), plan: JSON.parse(g.plan_json) })),
    allWeekPlans: (userId) => q('SELECT id, goal_id, created_at, reason, data_json FROM weekplans WHERE user_id = ? ORDER BY id').all(userId)
      .map((r) => ({ id: r.id, goalId: r.goal_id, createdAt: r.created_at, reason: r.reason, plan: JSON.parse(r.data_json) })),
    sharingAsAthlete: (userId) => q('SELECT academy_id AS academyId, share_health AS shareHealth, decided_at AS decidedAt FROM sharing WHERE athlete_id = ?').all(userId).map((r) => ({ ...r, shareHealth: !!r.shareHealth })),
    guardianLinks: (userId) => q('SELECT academy_id AS academyId, parent_id AS parentId, athlete_id AS athleteId FROM guardians WHERE parent_id = ? OR athlete_id = ?').all(userId, userId).map((r) => ({ ...r })),
    adminAcademies: (userId) => q("SELECT academy_id AS id FROM memberships WHERE user_id = ? AND role = 'admin'").all(userId).map((r) => r.id),
    academyMemberCount: (academyId) => q('SELECT COUNT(DISTINCT user_id) AS n FROM memberships WHERE academy_id = ?').get(academyId).n,
    otherAdmin: (academyId, userId) => { const r = q("SELECT user_id FROM memberships WHERE academy_id = ? AND role = 'admin' AND user_id <> ? LIMIT 1").get(academyId, userId); return r ? r.user_id : null; },
    deleteAcademy: (academyId) => q('DELETE FROM academies WHERE id = ?').run(academyId),
    reassignAcademyCreator: (academyId, userId) => q('UPDATE academies SET created_by = ? WHERE id = ?').run(userId, academyId),
    academiesCreatedBy: (userId) => q('SELECT id FROM academies WHERE created_by = ?').all(userId).map((r) => r.id),
    deleteInvitesBy: (userId) => q('DELETE FROM invites WHERE created_by = ? AND used_by IS NULL').run(userId),
    deleteUser: (userId) => q('DELETE FROM users WHERE id = ?').run(userId).changes,
    transaction(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    purgeAudit: (beforeIso) => q('DELETE FROM audit_log WHERE at < ?').run(beforeIso).changes,
    purgeInvites: (beforeMs) => q('DELETE FROM invites WHERE expires_at < ?').run(beforeMs).changes,
    addNotification: (userId, n) => q(`INSERT OR IGNORE INTO notifications (user_id, kind, due_key, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(userId, n.kind, n.key, n.title, n.body, now()).changes,
    inbox: (userId) => q('SELECT id, kind, title, body, created_at AS createdAt, read_at AS readAt FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId).map((r) => ({ ...r })),
    unreadCount: (userId) => q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n,
    markRead: (userId, id) => q('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(now(), id, userId).changes,
    markAllRead: (userId) => q('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), userId).changes,
    pendingExternal: (maxAttempts) => q(`SELECT id, user_id AS userId, title, body FROM notifications WHERE external_status IN ('pending','failed') AND external_attempts < ? ORDER BY id LIMIT 200`).all(maxAttempts).map((r) => ({ ...r })),
    markExternal: (id, status) => q('UPDATE notifications SET external_status = ?, external_attempts = external_attempts + 1 WHERE id = ?').run(status, id),
    purgeNotifications: (beforeIso) => q('DELETE FROM notifications WHERE created_at < ? AND read_at IS NOT NULL').run(beforeIso).changes,
    getProfessional: (userId) => { const r = q('SELECT license_no, issuer, status, submitted_at, decided_at, note FROM professionals WHERE user_id = ?').get(userId);
      return r ? { licenseNo: r.license_no, issuer: r.issuer, status: r.status, submittedAt: r.submitted_at, decidedAt: r.decided_at, note: r.note } : null; },
    setProfessional: (userId, p) => q(`INSERT INTO professionals (user_id, license_no, issuer, status, submitted_at, decided_at, decided_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET license_no = excluded.license_no, issuer = excluded.issuer, status = excluded.status,
      decided_at = excluded.decided_at, decided_by = excluded.decided_by, note = excluded.note`).run(userId, p.licenseNo, p.issuer, p.status, now(),
      p.status === 'pending' ? null : now(), p.decidedBy ?? null, p.note ?? null),
    professionals: () => q('SELECT p.user_id AS userId, u.email, p.license_no AS licenseNo, p.issuer, p.status, p.submitted_at AS submittedAt FROM professionals p JOIN users u ON u.id = p.user_id ORDER BY p.status, p.submitted_at DESC').all().map((r) => ({ ...r })),
    getProSub: (userId) => { const r = q('SELECT status, starts_on, ends_on FROM pro_subscriptions WHERE user_id = ?').get(userId); return r ? { status: r.status, startsOn: r.starts_on, endsOn: r.ends_on } : null; },
    setProSub: (userId, s) => q(`INSERT INTO pro_subscriptions (user_id, status, starts_on, ends_on, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, starts_on = excluded.starts_on, ends_on = excluded.ends_on, updated_by = excluded.updated_by,
      updated_at = excluded.updated_at`).run(userId, s.status, s.startsOn, s.endsOn, s.by ?? null, now()),
    // shared (multi-process on one host) throttle store
    throttleCount: (key, sinceMs) => q('SELECT COUNT(*) AS n FROM throttle_events WHERE key = ? AND at_ms > ?').get(key, sinceMs).n,
    throttleAdd: (key, atMs) => q('INSERT INTO throttle_events (key, at_ms) VALUES (?, ?)').run(key, atMs),
    purgeThrottle: (beforeMs) => q('DELETE FROM throttle_events WHERE at_ms < ?').run(beforeMs).changes,
    // one-time tokens (password reset / e-mail verification); only hashes are stored
    addAuthToken: (hash, userId, purpose, expiresAt, nowMs) => q('INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(hash, userId, purpose, expiresAt, nowMs),
    useAuthToken: (hash, purpose, nowMs) => {
      const r = q('SELECT user_id FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?').get(hash, purpose, nowMs);
      if (!r) return null;
      return q('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(nowMs, hash).changes ? r.user_id : null;
    },
    invalidateAuthTokens: (userId, purpose) => q('UPDATE auth_tokens SET used_at = 0 WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(userId, purpose),
    purgeAuthTokens: (beforeMs) => q('DELETE FROM auth_tokens WHERE expires_at < ?').run(beforeMs).changes,
    setPassword: (userId, hash) => q('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, userId),
    deleteSessionsFor: (userId) => q('DELETE FROM sessions WHERE user_id = ?').run(userId).changes,
    setEmailVerified: (userId) => q('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL').run(now(), userId),
    emailVerifiedAt: (userId) => (q('SELECT email_verified_at AS v FROM users WHERE id = ?').get(userId) || {}).v || null,
    getMinorConsent: (athleteId) => { const r = q('SELECT guardian_id, academy_id, granted_at FROM minor_consents WHERE athlete_id = ?').get(athleteId); return r ? { guardianId: r.guardian_id, academyId: r.academy_id, grantedAt: r.granted_at } : null; },
    setMinorConsent: (athleteId, guardianId, academyId) => q(`INSERT INTO minor_consents (athlete_id, guardian_id, academy_id, granted_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(athlete_id) DO UPDATE SET guardian_id = excluded.guardian_id, academy_id = excluded.academy_id, granted_at = excluded.granted_at`).run(athleteId, guardianId, academyId, now()),
    clearMinorConsent: (athleteId) => q('DELETE FROM minor_consents WHERE athlete_id = ?').run(athleteId).changes,
    setAcademyKind: (academyId, kind) => q('UPDATE academies SET kind = ? WHERE id = ?').run(kind, academyId),
    familyOf: (userId) => { const r = q(`SELECT a.id FROM academies a JOIN memberships m ON m.academy_id = a.id WHERE a.kind = 'family' AND a.created_by = ? AND m.user_id = ? LIMIT 1`).get(userId, userId); return r ? r.id : null; },
    mealLogs: (userId, from, to) => q('SELECT date, key, entry, logged_at FROM meal_logs WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date, key').all(userId, from, to)
      .map((r) => ({ ...JSON.parse(r.entry), date: r.date, key: r.key, loggedAt: r.logged_at })),
    setMealLog: (userId, goalId, date, key, entry) => q(`INSERT INTO meal_logs (user_id, goal_id, date, key, entry, logged_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date, key) DO UPDATE SET goal_id = excluded.goal_id, entry = excluded.entry, logged_at = excluded.logged_at`).run(userId, goalId, date, key, JSON.stringify(entry), new Date().toISOString()),
    deleteMealLog: (userId, date, key) => q('DELETE FROM meal_logs WHERE user_id = ? AND date = ? AND key = ?').run(userId, date, key).changes,
    addPlanReview: (r) => q(`INSERT INTO plan_reviews (athlete_id, goal_id, reviewer_id, academy_id, decision, note, fingerprint, calc_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.athleteId, r.goalId, r.reviewerId, r.academyId, r.decision, r.note, r.fingerprint, r.calcVersion, new Date().toISOString()).lastInsertRowid,
    planReviews: (athleteId, goalId) => q(`SELECT r.id, r.decision, r.note, r.fingerprint, r.calc_version, r.created_at, r.reviewer_id, r.academy_id
      FROM plan_reviews r WHERE r.athlete_id = ? AND r.goal_id = ? ORDER BY r.id`).all(athleteId, goalId)
      .map((r) => ({ id: r.id, decision: r.decision, note: r.note, fingerprint: r.fingerprint, calcVersion: r.calc_version, at: r.created_at, reviewerId: r.reviewer_id, academyId: r.academy_id })),
    getCalorieOverride: (userId) => { const r = q('SELECT kcal, starts_on, ends_on, created_at FROM calorie_overrides WHERE user_id = ?').get(userId); return r ? { kcal: r.kcal, startsOn: r.starts_on, endsOn: r.ends_on, createdAt: r.created_at } : null; },
    setCalorieOverride: (userId, kcal, startsOn, endsOn) => q(`INSERT INTO calorie_overrides (user_id, kcal, starts_on, ends_on, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET kcal = excluded.kcal, starts_on = excluded.starts_on, ends_on = excluded.ends_on, created_at = excluded.created_at`).run(userId, kcal, startsOn, endsOn, now()),
    clearCalorieOverride: (userId) => q('DELETE FROM calorie_overrides WHERE user_id = ?').run(userId).changes,
    getSelfWaiver: (userId) => { const r = q('SELECT accepted_at, text_version FROM self_waivers WHERE user_id = ?').get(userId); return r ? { acceptedAt: r.accepted_at, version: r.text_version } : null; },
    setSelfWaiver: (userId, version) => q('INSERT INTO self_waivers (user_id, accepted_at, text_version) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET accepted_at = excluded.accepted_at, text_version = excluded.text_version').run(userId, now(), version),
    clearSelfWaiver: (userId) => q('DELETE FROM self_waivers WHERE user_id = ?').run(userId).changes,
    createHousehold: (name, userId) => Number(q('INSERT INTO households (name, created_by, created_at) VALUES (?, ?, ?)').run(name, userId, now()).lastInsertRowid),
    householdOf: (userId) => { const r = q('SELECT h.id, h.name, h.created_by, h.shared_meals FROM household_members m JOIN households h ON h.id = m.household_id WHERE m.user_id = ?').get(userId);
      return r ? { id: r.id, name: r.name, created_by: r.created_by, sharedMeals: r.shared_meals ? r.shared_meals.split(',').filter(Boolean) : [] } : null; },
    addHouseholdMember: (hid, userId, displayName) => q('INSERT INTO household_members (user_id, household_id, display_name, joined_at) VALUES (?, ?, ?, ?)').run(userId, hid, displayName, now()),
    removeHouseholdMember: (hid, userId) => q('DELETE FROM household_members WHERE household_id = ? AND user_id = ?').run(hid, userId).changes,
    householdMembers: (hid) => q('SELECT user_id, display_name FROM household_members WHERE household_id = ? ORDER BY joined_at, rowid').all(hid).map((r) => ({ userId: r.user_id, displayName: r.display_name })),
    deleteHousehold: (hid) => q('DELETE FROM households WHERE id = ?').run(hid),
    setHouseholdOwner: (hid, userId) => q('UPDATE households SET created_by = ? WHERE id = ?').run(userId, hid),
    renameHousehold: (hid, name) => q('UPDATE households SET name = ? WHERE id = ?').run(name, hid),
    setHouseholdMeals: (hid, kinds) => q('UPDATE households SET shared_meals = ? WHERE id = ?').run(kinds.join(','), hid),
    createHouseholdInvite: (hash, hid, by, exp) => q('INSERT INTO household_invites (code_hash, household_id, created_by, expires_at) VALUES (?, ?, ?, ?)').run(hash, hid, by, exp),
    householdInviteByHash: (hash) => { const r = q('SELECT household_id, expires_at, used_by FROM household_invites WHERE code_hash = ?').get(hash); return r ? { ...r } : null; },
    useHouseholdInvite: (hash, userId) => q('UPDATE household_invites SET used_by = ? WHERE code_hash = ? AND used_by IS NULL').run(userId, hash).changes,
    purgeHouseholdInvites: (beforeMs) => q('DELETE FROM household_invites WHERE expires_at < ?').run(beforeMs).changes,
    identity: (provider, subject) => q('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').get(provider, subject) || null,
    linkIdentity: (provider, subject, userId) => q('INSERT INTO user_identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)').run(provider, subject, userId, now()),
    identitiesOf: (userId) => q('SELECT provider, created_at AS createdAt FROM user_identities WHERE user_id = ?').all(userId).map((r) => ({ ...r })),
    addShare: (hash, userId, html, expiresAt) => Number(q('INSERT INTO share_links (token_hash, user_id, html, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(hash, userId, html, now(), expiresAt).lastInsertRowid),
    shareByHash: (hash) => { const r = q('SELECT id, user_id, html, expires_at, revoked_at FROM share_links WHERE token_hash = ?').get(hash); return r ? { ...r } : null; },
    countShareView: (id) => q('UPDATE share_links SET views = views + 1 WHERE id = ?').run(id),
    shares: (userId) => q('SELECT id, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, views FROM share_links WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId).map((r) => ({ ...r })),
    activeShareCount: (userId, nowMs) => q('SELECT COUNT(*) AS n FROM share_links WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?').get(userId, nowMs).n,
    revokeShare: (userId, id) => q('UPDATE share_links SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), id, userId).changes,
    purgeShares: (beforeMs) => q('DELETE FROM share_links WHERE expires_at < ?').run(beforeMs).changes,
    isOwner: (userId) => !!q('SELECT 1 FROM platform_owners WHERE user_id = ?').get(userId),
    grantOwner: (userId) => q('INSERT OR IGNORE INTO platform_owners (user_id, granted_at) VALUES (?, ?)').run(userId, now()),
    revokeOwner: (userId) => q('DELETE FROM platform_owners WHERE user_id = ?').run(userId).changes,
    purgeSessions: (nowMs) => q('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs).changes,
    usersWithoutSubscription: () => q('SELECT u.id FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id WHERE s.user_id IS NULL').all().map((r) => r.id),
    allUsers: () => q('SELECT id, email FROM users ORDER BY id DESC LIMIT 500').all().map((r) => ({ ...r })),

    createSession: (tokenHash, userId, expiresAt) => q('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt),
    sessionUser: (tokenHash) => q('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now()),
    deleteSession: (tokenHash) => q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash),

    saveGoal(userId, input, plan) {
      db.exec('BEGIN');
      try {
        q('UPDATE goals SET active = 0 WHERE user_id = ?').run(userId);
        const id = q(`INSERT INTO goals (user_id, created_at, input_json, plan_json, start_date, start_weight, target_weight, weekly_rate_kg, last_projection)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, now(), JSON.stringify(input), JSON.stringify(plan), input.startDate,
          input.currentWeight, input.targetWeight, plan.effectiveRateKg, plan.timeline.completionDate).lastInsertRowid;
        db.exec('COMMIT');
        return id;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    activeGoal(userId) {
      const g = q('SELECT * FROM goals WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(userId);
      if (!g) return null;
      return { id: g.id, createdAt: g.created_at, input: JSON.parse(g.input_json), plan: JSON.parse(g.plan_json), startDate: g.start_date,
        startWeight: g.start_weight, targetWeight: g.target_weight, weeklyRateKg: g.weekly_rate_kg,
        calorieAdjustment: g.calorie_adjustment, lastProjection: g.last_projection };
    },
    updateGoalPlan: (userId, goalId, input, plan) => q('UPDATE goals SET input_json = ?, plan_json = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(input), JSON.stringify(plan), goalId, userId),
    setProjection: (userId, goalId, date) => q('UPDATE goals SET last_projection = ? WHERE id = ? AND user_id = ?').run(date, goalId, userId),
    setCalorieAdjustment: (userId, goalId, kcal) => q('UPDATE goals SET calorie_adjustment = ? WHERE id = ? AND user_id = ?').run(kcal, goalId, userId),

    upsertWeight: (userId, goalId, date, kg) => q(`INSERT INTO weights (user_id, goal_id, date, weight_kg) VALUES (?, ?, ?, ?)
      ON CONFLICT(goal_id, date) DO UPDATE SET weight_kg = excluded.weight_kg`).run(userId, goalId, date, kg),
    deleteWeight: (userId, goalId, date) => q('DELETE FROM weights WHERE user_id = ? AND goal_id = ? AND date = ?').run(userId, goalId, date).changes,
    weights: (userId, goalId) => q('SELECT date, weight_kg AS weightKg FROM weights WHERE user_id = ? AND goal_id = ? ORDER BY date').all(userId, goalId).map((r) => ({ ...r })),

    upsertCheckin: (userId, goalId, week, data) => q(`INSERT INTO checkins (user_id, goal_id, week, data_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(goal_id, week) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`).run(userId, goalId, week, JSON.stringify(data), now()),
    checkins: (userId, goalId) => q('SELECT week, data_json FROM checkins WHERE user_id = ? AND goal_id = ? ORDER BY week').all(userId, goalId)
      .map((r) => ({ ...JSON.parse(r.data_json), week: r.week })),

    addAdjustment: (userId, goalId, a) => q(`INSERT INTO adjustments (user_id, goal_id, created_at, kind, action, kcal_change, reasons_json, status, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, goalId, now(), a.kind, a.action, a.kcalChange || 0, JSON.stringify(a.reasons || []),
      a.status || 'pending', a.status && a.status !== 'pending' ? now() : null).lastInsertRowid,
    adjustment: (userId, id) => q('SELECT * FROM adjustments WHERE id = ? AND user_id = ?').get(id, userId),
    decideAdjustment: (userId, id, status, note) => q("UPDATE adjustments SET status = ?, decided_at = ?, decision_note = ? WHERE id = ? AND user_id = ? AND status = 'pending'").run(status, now(), note || null, id, userId).changes,
    expirePending: (userId, goalId) => q("UPDATE adjustments SET status = 'superseded', decided_at = ? WHERE user_id = ? AND goal_id = ? AND status = 'pending'").run(now(), userId, goalId),
    adjustments: (userId, goalId) => q('SELECT * FROM adjustments WHERE user_id = ? AND goal_id = ? ORDER BY id').all(userId, goalId).map((r) => ({
      id: r.id, createdAt: r.created_at, kind: r.kind, action: r.action, kcalChange: r.kcal_change, reasons: JSON.parse(r.reasons_json),
      status: r.status, decidedAt: r.decided_at, decisionNote: r.decision_note })),

    getPrefs: (userId) => { const r = q('SELECT data_json FROM prefs WHERE user_id = ?').get(userId); return r ? JSON.parse(r.data_json) : null; },
    setPrefs: (userId, data) => q(`INSERT INTO prefs (user_id, data_json) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json`).run(userId, JSON.stringify(data)),
    // Every change saves a new version; the newest is the current plan. Older than the last
    // PLAN_VERSIONS versions are pruned automatically (retention, not user deletion).
    saveWeekPlan(userId, goalId, plan, reason = 'generated') {
      const id = q('INSERT INTO weekplans (user_id, goal_id, created_at, data_json, reason) VALUES (?, ?, ?, ?, ?)').run(userId, goalId, now(), JSON.stringify(plan), reason).lastInsertRowid;
      q(`DELETE FROM weekplans WHERE user_id = ? AND goal_id = ? AND id NOT IN
        (SELECT id FROM weekplans WHERE user_id = ? AND goal_id = ? ORDER BY id DESC LIMIT ${PLAN_VERSIONS})`).run(userId, goalId, userId, goalId);
      return id;
    },
    weekPlan: (userId, goalId) => { const r = q('SELECT id, data_json FROM weekplans WHERE user_id = ? AND goal_id = ? ORDER BY id DESC LIMIT 1').get(userId, goalId); return r ? { ...JSON.parse(r.data_json), versionId: r.id } : null; },
    weekPlanVersion: (userId, goalId, id) => { const r = q('SELECT id, data_json FROM weekplans WHERE id = ? AND user_id = ? AND goal_id = ?').get(id, userId, goalId); return r ? JSON.parse(r.data_json) : null; },
    weekPlanHistory: (userId, goalId) => q('SELECT id, created_at, reason, data_json FROM weekplans WHERE user_id = ? AND goal_id = ? ORDER BY id DESC').all(userId, goalId)
      .map((r) => { const p = JSON.parse(r.data_json); return { id: r.id, createdAt: r.created_at, reason: r.reason || 'generated', startDate: p.startDate,
        avgKcal: p.weekTotals ? Math.round(p.weekTotals.kcal / 7) : null }; }),

    getScreening: (userId) => { const r = q('SELECT data_json, consent_at, updated_at FROM screenings WHERE user_id = ?').get(userId); return r ? { ...JSON.parse(r.data_json), consentAt: r.consent_at, updatedAt: r.updated_at } : null; },
    setScreening: (userId, data) => q(`INSERT INTO screenings (user_id, data_json, consent_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`).run(userId, JSON.stringify(data), now(), now()),

    // ---- academies (every query is scoped by academy_id; access policy lives in src/academy.js) ----
    createAcademy(name, userId, displayName) {
      db.exec('BEGIN');
      try {
        const id = Number(q('INSERT INTO academies (name, created_by, created_at) VALUES (?, ?, ?)').run(name, userId, now()).lastInsertRowid);
        q('INSERT INTO memberships (academy_id, user_id, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, 'admin', displayName || null, now());
        db.exec('COMMIT');
        return id;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    academy: (id) => q('SELECT id, name, kind, created_at AS createdAt FROM academies WHERE id = ?').get(id) || null,
    membershipsOf: (userId) => q(`SELECT m.academy_id AS academyId, a.name, m.role, m.display_name AS displayName FROM memberships m JOIN academies a ON a.id = m.academy_id
      WHERE m.user_id = ? ORDER BY a.id, m.role`).all(userId).map((r) => ({ ...r })),
    rolesIn: (userId, academyId) => q('SELECT role FROM memberships WHERE user_id = ? AND academy_id = ?').all(userId, academyId).map((r) => r.role),
    addMembership: (academyId, userId, role, displayName) => q(`INSERT INTO memberships (academy_id, user_id, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(academy_id, user_id, role) DO UPDATE SET display_name = COALESCE(excluded.display_name, memberships.display_name)`).run(academyId, userId, role, displayName || null, now()),
    removeMembership(academyId, userId) {
      q('DELETE FROM memberships WHERE academy_id = ? AND user_id = ?').run(academyId, userId);
      q('DELETE FROM guardians WHERE academy_id = ? AND (parent_id = ? OR athlete_id = ?)').run(academyId, userId, userId);
      q('DELETE FROM sharing WHERE academy_id = ? AND athlete_id = ?').run(academyId, userId);
    },
    members: (academyId) => q(`SELECT m.user_id AS userId, u.email, m.role, m.display_name AS displayName, m.created_at AS createdAt
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.academy_id = ? ORDER BY m.role, m.user_id`).all(academyId).map((r) => ({ ...r })),
    countRole: (academyId, role) => q('SELECT COUNT(*) AS n FROM memberships WHERE academy_id = ? AND role = ?').get(academyId, role).n,
    createInvite: (hash, academyId, role, createdBy, expiresAt, athleteId) => q(`INSERT INTO invites (code_hash, academy_id, role, athlete_id, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(hash, academyId, role, athleteId || null, createdBy, expiresAt),
    inviteByHash: (hash) => { const r = q('SELECT * FROM invites WHERE code_hash = ?').get(hash); return r ? { ...r } : null; },
    useInvite: (hash, userId) => q('UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL').run(userId, now(), hash).changes,
    linkGuardian: (academyId, parentId, athleteId) => q('INSERT OR IGNORE INTO guardians (academy_id, parent_id, athlete_id, created_at) VALUES (?, ?, ?, ?)').run(academyId, parentId, athleteId, now()),
    isGuardian: (academyId, parentId, athleteId) => !!q('SELECT 1 FROM guardians WHERE academy_id = ? AND parent_id = ? AND athlete_id = ?').get(academyId, parentId, athleteId),
    childrenOf: (academyId, parentId) => q('SELECT athlete_id AS id FROM guardians WHERE academy_id = ? AND parent_id = ?').all(academyId, parentId).map((r) => r.id),
    guardiansOf: (academyId, athleteId) => q('SELECT parent_id AS id FROM guardians WHERE academy_id = ? AND athlete_id = ?').all(academyId, athleteId).map((r) => r.id),
    getSharing: (academyId, athleteId) => { const r = q('SELECT share_health, decided_by, decided_at FROM sharing WHERE academy_id = ? AND athlete_id = ?').get(academyId, athleteId);
      return r ? { shareHealth: !!r.share_health, decidedBy: r.decided_by, decidedAt: r.decided_at } : { shareHealth: false, decidedBy: null, decidedAt: null }; },
    setSharing: (academyId, athleteId, share, by) => q(`INSERT INTO sharing (academy_id, athlete_id, share_health, decided_by, decided_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(academy_id, athlete_id) DO UPDATE SET share_health = excluded.share_health, decided_by = excluded.decided_by, decided_at = excluded.decided_at`).run(academyId, athleteId, share ? 1 : 0, by, now()),
    getSubscription: (userId) => { const r = q('SELECT plan, status, starts_on, ends_on FROM subscriptions WHERE user_id = ?').get(userId);
      return r ? { plan: r.plan, status: r.status, startsOn: r.starts_on, endsOn: r.ends_on } : null; },
    setSubscription: (userId, s) => q(`INSERT INTO subscriptions (user_id, plan, status, starts_on, ends_on, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, status = excluded.status, starts_on = excluded.starts_on, ends_on = excluded.ends_on,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(userId, s.plan, s.status, s.startsOn, s.endsOn, s.by ?? null, now()),
    subscriptionEvent: (userId, action, months, endsOn, by, note) => q('INSERT INTO subscription_events (user_id, at, action, months, ends_on, by_user, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, now(), action, months || 0, endsOn || null, by ?? null, note ? String(note).slice(0, 200) : null),
    subscriptionEvents: (userId) => q('SELECT at, action, months, ends_on AS endsOn, note FROM subscription_events WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId).map((r) => ({ ...r })),
    getBranding: (academyId) => { const r = q('SELECT signature, logo FROM academy_branding WHERE academy_id = ?').get(academyId); return r ? { signature: r.signature, logo: r.logo } : null; },
    setBranding: (academyId, b) => q(`INSERT INTO academy_branding (academy_id, signature, logo, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(academy_id) DO UPDATE SET signature = excluded.signature, logo = excluded.logo, updated_at = excluded.updated_at`).run(academyId, b.signature, b.logo, now()),
    audit: (academyId, actorId, action, targetId) => q('INSERT INTO audit_log (at, academy_id, actor_id, action, target_id) VALUES (?, ?, ?, ?, ?)').run(now(), academyId, actorId, action, targetId ?? null),
    auditLog: (academyId) => q('SELECT id, at, actor_id AS actorId, action, target_id AS targetId FROM audit_log WHERE academy_id = ? ORDER BY id DESC LIMIT 200').all(academyId).map((r) => ({ ...r })),

    addHydration: (userId, s) => q('INSERT INTO hydration_logs (user_id, date, data_json, created_at) VALUES (?, ?, ?, ?)').run(userId, s.date, JSON.stringify(s), now()).lastInsertRowid,
    hydrationLogs: (userId) => q('SELECT id, data_json FROM hydration_logs WHERE user_id = ? ORDER BY date, id').all(userId).map((r) => ({ ...JSON.parse(r.data_json), id: r.id })),
    deleteHydration: (userId, id) => q('DELETE FROM hydration_logs WHERE id = ? AND user_id = ?').run(id, userId).changes,

    getCompetition: (userId) => { const r = q('SELECT data_json FROM competitions WHERE user_id = ?').get(userId); return r ? JSON.parse(r.data_json) : null; },
    setCompetition: (userId, data) => q(`INSERT INTO competitions (user_id, data_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`).run(userId, JSON.stringify(data), now()),
    deleteCompetition: (userId) => q('DELETE FROM competitions WHERE user_id = ?').run(userId),

    getNotifications: (userId) => { const r = q('SELECT data_json FROM notification_settings WHERE user_id = ?').get(userId); return r ? JSON.parse(r.data_json) : null; },
    setNotifications: (userId, data) => q(`INSERT INTO notification_settings (user_id, data_json) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data_json = excluded.data_json`).run(userId, JSON.stringify(data)),
  };
}

module.exports = { openDb };
