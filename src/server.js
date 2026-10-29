'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const auth = require('./auth');
const { validateGoalInput, validateWeightEntry, validateCheckin } = require('./engine/validate');
const { createPlan } = require('./engine/planner');
const { recommendRate } = require('./engine/rate');
const { SPORTS } = require('./engine/energy');
const { SCENARIOS } = require('./engine/timeline');
const { foodsMeta, listRecipes } = require('./engine/meals');
const service = require('./service');
const academy = require('./academy');
const subscription = require('./subscription');
const account = require('./account');
const notify = require('./notify');
const pro = require('./pro');
const security = require('./security');
const share = require('./share');
const google = require('./google');
const pdfRender = require('./pdfRender');
const household = require('./household');
const crypto = require('node:crypto');
const { renderReport, renderCsv } = require('./report');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const MAX_BODY = 100 * 1024;
const { diffDays } = require('./engine/dates');
// Behind a reverse proxy set TRUST_PROXY=1 so throttling uses the real client address.
const clientIp = (req) => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function createApp({ dbPath = process.env.EKLNI_DB || path.join(__dirname, '..', 'eklni.db'), today = () => todayIn(process.env.APP_TZ || 'Africa/Cairo'), secureCookies = process.env.COOKIE_SECURE === '1',
  trialDays = Number(process.env.EKLNI_TRIAL_DAYS ?? 7),
  registerLimitPerHour = Number(process.env.EKLNI_REGISTER_LIMIT ?? 20),
  notifications = process.env.EKLNI_NOTIFICATIONS !== '0',
  googleAuth = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : null,
  pricing = { priceEgp: process.env.EKLNI_PRICE_EGP ? Number(process.env.EKLNI_PRICE_EGP) : null, paymentNote: process.env.EKLNI_PAYMENT_NOTE || null } } = {}) {
  const db = openDb(dbPath);
  const throttle = security.dbThrottle(db);
  const allowedOrigins = (process.env.EKLNI_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const baseUrlOf = (req) => process.env.EKLNI_PUBLIC_URL
    || `${secureCookies || (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http'}://${req.headers.host}`;
  const resetUrl = (t) => `${process.env.EKLNI_PUBLIC_URL || ''}/#reset=${t}`;
  const verifyUrl = (t) => `${process.env.EKLNI_PUBLIC_URL || ''}/#verify=${t}`;
  // Accounts created before subscriptions existed get the normal trial once, instead of being locked on upgrade.
  for (const uid of db.usersWithoutSubscription()) subscription.startTrial(db, uid, today(), Math.max(trialDays, 1));

  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === 'string';
    res.writeHead(status, {
      'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      ...(secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}), ...headers,
    });
    res.end(isStr ? body : JSON.stringify(body));
  };

  const readJson = (req, limit = MAX_BODY) => new Promise((resolve, reject) => {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      let v;
      try { v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
      // every endpoint expects a JSON object; null / arrays / primitives are rejected instead of crashing handlers
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(Object.assign(new Error('JSON body must be an object'), { status: 400 }));
      resolve(v);
    });
    req.on('error', reject);
  });

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'",
      });
      res.end(data);
    });
  }

  // Public read-only share page. Same answer for unknown, expired or revoked links (no enumeration).
  function serveShare(res, token) {
    const l = db.shareByHash(auth.sha256(`share:${token}`));
    const live = l && !l.revoked_at && l.expires_at > Date.now() && subOf(l.user_id).active;
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'" };
    if (!live) {
      res.writeHead(410, headers);
      return res.end('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>أكلني | Eklni</title><body style="font-family:sans-serif;padding:24px">الرابط ده انتهى أو اتلغى.</body></html>');
    }
    db.countShareView(l.id);
    res.writeHead(200, headers);
    res.end(l.html);
  }

  const routes = [];
  // open: no subscription needed · staff: platform OR professional subscription (team / clinical tools)
  const route = (method, pattern, handler, { authed = true, open = false, staff = false } = {}) => routes.push({ method, pattern, handler, authed, open, staff });
  // Platform owners are granted only from the server console (scripts/owner.js) — never by matching an
  // e-mail address at sign-up, because e-mail addresses are not verified.
  const isOwner = (userId) => !!userId && db.isOwner(userId);
  const subOf = (userId) => subscription.status(db, userId, today(), { owner: isOwner(userId) });

  // ---- auth ----
  route('POST', /^\/api\/auth\/register$/, async (req, res) => {
    const { email, password } = await readJson(req);
    const em = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return send(res, 400, { error: 'VALIDATION', errors: { email: 'البريد الإلكتروني غير صحيح.' } });
    if (em.length > 254) return send(res, 400, { error: 'VALIDATION', errors: { email: 'البريد الإلكتروني طويل جدًا.' } });
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return send(res, 400, { error: 'VALIDATION', errors: { password: 'كلمة المرور من 8 لـ 200 حرف.' } });
    if (throttle.limited(`register|${clientIp(req)}`, registerLimitPerHour, 60)) return send(res, 429, { error: 'TOO_MANY', message: 'محاولات تسجيل كتير؛ حاول بعد ساعة.' });
    throttle.hit(`register|${clientIp(req)}`);
    if (db.userByEmail(em)) return send(res, 409, { error: 'EMAIL_TAKEN', message: 'هذا البريد مسجل بالفعل.' });
    const id = Number(db.createUser(em, auth.hashPassword(password)));
    subscription.startTrial(db, id, today(), trialDays);
    const token = auth.newSession(db, id);
    send(res, 201, { user: { id, email: em } }, { 'Set-Cookie': auth.sessionCookie(token, { secure: secureCookies }) });
  }, { authed: false });

  route('POST', /^\/api\/auth\/login$/, async (req, res) => {
    const { email, password } = await readJson(req);
    const em = String(email || '').trim().toLowerCase();
    if (typeof password !== 'string' || password.length > 200) return send(res, 401, { error: 'BAD_CREDENTIALS', message: 'البريد أو كلمة المرور غير صحيحة.' });
    const key = `${em}|${clientIp(req)}`;
    if (throttle.limited(key, 10, 15)) return send(res, 429, { error: 'TOO_MANY', message: 'محاولات كثيرة؛ حاول بعد 15 دقيقة.' });
    const u = db.userByEmail(em);
    if (!u || typeof password !== 'string' || !auth.verifyPassword(password, u.pass_hash)) {
      throttle.hit(key);
      return send(res, 401, { error: 'BAD_CREDENTIALS', message: 'البريد أو كلمة المرور غير صحيحة.' });
    }
    const token = auth.newSession(db, u.id);
    send(res, 200, { user: { id: u.id, email: u.email } }, { 'Set-Cookie': auth.sessionCookie(token, { secure: secureCookies }) });
  }, { authed: false });

  // ---- Sign in with Google (OIDC code flow + PKCE). Enabled only when GOOGLE_CLIENT_ID/SECRET are set. ----
  const gFetch = (googleAuth && googleAuth.fetch) || ((...a) => fetch(...a));
  const gKey = googleAuth ? google.jwksCache(gFetch) : null;
  const gRedirect = (req) => `${process.env.EKLNI_PUBLIC_URL || baseUrlOf(req)}/api/auth/google/callback`;
  const G_COOKIE = 'eklni_g';
  const gCookie = (v, maxAge) => `${G_COOKIE}=${v}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  const redirect = (res, to, headers = {}) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers }); res.end(); };
  route('GET', /^\/api\/auth\/google$/, async (req, res) => {
    if (!googleAuth) return send(res, 404, { error: 'NOT_CONFIGURED' });
    const f = google.newFlow();
    redirect(res, google.authUrl({ clientId: googleAuth.clientId, redirectUri: gRedirect(req), state: f.state, nonce: f.nonce, challenge: f.challenge }),
      { 'Set-Cookie': gCookie(`${f.state}.${f.verifier}.${f.nonce}`, 600) });
  }, { authed: false });
  route('GET', /^\/api\/auth\/google\/callback$/, async (req, res) => {
    if (!googleAuth) return send(res, 404, { error: 'NOT_CONFIGURED' });
    const fail = (why) => { console.error(`google sign-in rejected: ${why}`); redirect(res, '/#google=failed', { 'Set-Cookie': gCookie('', 0) }); };
    const key = `google|${clientIp(req)}`;
    if (throttle.limited(key, 20, 15)) return fail('throttled');
    throttle.hit(key);
    const url = new URL(req.url, 'http://x');
    const [state, verifier, nonce] = String(auth.parseCookies(req.headers.cookie)[G_COOKIE] || '').split('.');
    const qs = url.searchParams.get('state') || '';
    if (!state || !verifier || qs.length !== state.length || !crypto.timingSafeEqual(Buffer.from(qs), Buffer.from(state))) return fail('state');
    if (url.searchParams.get('error') || !url.searchParams.get('code')) return fail('cancelled');
    let claims;
    try {
      const idToken = await google.exchangeCode({ code: url.searchParams.get('code'), verifier, clientId: googleAuth.clientId, clientSecret: googleAuth.clientSecret, redirectUri: gRedirect(req), fetchImpl: gFetch });
      claims = await google.verifyIdToken(idToken, { clientId: googleAuth.clientId, nonce, getKey: gKey, nowSec: googleAuth.nowSec });
    } catch (e) { return fail(e.message); }
    const r = google.signIn(db, claims, { startTrial: (id) => subscription.startTrial(db, id, today(), trialDays) });
    if (r.error) return fail(r.error);
    const token = auth.newSession(db, r.userId);
    redirect(res, r.created ? '/#google=new' : '/#google=ok', { 'Set-Cookie': [gCookie('', 0), auth.sessionCookie(token, { secure: secureCookies })] });
  }, { authed: false });
  // A Google-only account can add a password once (needed e.g. to delete the account).
  route('POST', /^\/api\/auth\/set-password$/, async (req, res, { userId }) => {
    const { password } = await readJson(req);
    const u = db.userByEmail(db.userById(userId).email);
    if (google.hasPassword(u.pass_hash)) return send(res, 409, { error: 'HAS_PASSWORD', message: 'الحساب له كلمة مرور بالفعل؛ استخدم «نسيت كلمة المرور».' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) return send(res, 400, { error: 'VALIDATION', errors: { password: 'كلمة المرور من 8 لـ 200 حرف.' } });
    db.setPassword(userId, auth.hashPassword(password));
    send(res, 200, { ok: true });
  }, { open: true });

  route('POST', /^\/api\/auth\/logout$/, async (req, res) => {
    const t = auth.parseCookies(req.headers.cookie).eklni_sid;
    if (t) db.deleteSession(auth.sha256(t));
    send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }, { authed: false });

  // ---- password reset & e-mail verification (one-time tokens; only hashes stored) ----
  const gateway = process.env.NOTIFY_WEBHOOK_URL ? notify.webhookSender(process.env.NOTIFY_WEBHOOK_URL, process.env.NOTIFY_WEBHOOK_TOKEN) : null;
  route('POST', /^\/api\/auth\/reset-request$/, async (req, res) => {
    const { email } = await readJson(req);
    const em = String(email || '').trim().toLowerCase().slice(0, 254);
    const key = `reset|${clientIp(req)}`;
    if (throttle.limited(key, 5, 60)) return send(res, 429, { error: 'TOO_MANY', message: 'طلبات كتير؛ حاول بعد ساعة.' });
    throttle.hit(key);
    const u = EMAIL_RE.test(em) ? db.userByEmail(em) : null;
    if (u && gateway) {
      const { token } = security.issueToken(db, u.id, 'reset');
      gateway({ to: u.email, title: 'استعادة كلمة المرور — أكلني', body: `الرابط صالح 30 دقيقة ولمرة واحدة: ${resetUrl(token)}` }).catch(() => console.error('reset mail failed'));
    }
    // same answer whether or not the e-mail exists (no account enumeration)
    send(res, 200, { ok: true, delivery: gateway ? 'email' : 'contact_admin', message: gateway ? 'لو الإيميل مسجل هيوصلك رابط.' : 'تواصل مع إدارة المنصة علشان تبعتلك رابط الاستعادة.' });
  }, { authed: false });
  route('POST', /^\/api\/auth\/reset$/, async (req, res) => {
    const b = await readJson(req);
    const key = `resetuse|${clientIp(req)}`;
    if (throttle.limited(key, 10, 15)) return send(res, 429, { error: 'TOO_MANY', message: 'محاولات كتير.' });
    throttle.hit(key);
    const r = security.resetPassword(db, b.token, b.password);
    if (r.error) return send(res, r.status, r);
    send(res, 200, { ok: true, message: 'اتغيرت كلمة المرور؛ سجّل الدخول من جديد.' });
  }, { authed: false });
  route('POST', /^\/api\/auth\/verify-request$/, async (req, res, { userId }) => {
    if (db.emailVerifiedAt(userId)) return send(res, 200, { verified: true });
    if (throttle.limited(`verify|${userId}`, 5, 60)) return send(res, 429, { error: 'TOO_MANY', message: 'طلبات كتير.' });
    throttle.hit(`verify|${userId}`);
    if (!gateway) return send(res, 200, { verified: false, sent: false, message: 'إرسال الإيميلات مش متفعّل على المنصة.' });
    const { token } = security.issueToken(db, userId, 'verify');
    gateway({ to: db.userById(userId).email, title: 'تأكيد الإيميل — أكلني', body: `رابط التأكيد (صالح 24 ساعة): ${verifyUrl(token)}` }).catch(() => console.error('verify mail failed'));
    send(res, 200, { verified: false, sent: true });
  }, { open: true });
  route('POST', /^\/api\/auth\/verify$/, async (req, res) => {
    const b = await readJson(req);
    const userId = security.consumeToken(db, b.token, 'verify');
    if (!userId) return send(res, 400, { error: 'INVALID_TOKEN', message: 'الرابط غير صحيح أو انتهى.' });
    db.setEmailVerified(userId);
    send(res, 200, { verified: true });
  }, { authed: false });
  // owner-assisted reset when no e-mail gateway exists: the owner gives the link to the user out of band
  route('POST', /^\/api\/owner\/reset-link$/, async (req, res, ctx) => {
    if (!isOwner(ctx.userId)) return send(res, 404, { error: 'NOT_FOUND' });
    const u = db.userByEmail(String((await readJson(req)).email || '').trim().toLowerCase());
    if (!u) return send(res, 404, { error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' });
    const { token, expiresInMin } = security.issueToken(db, u.id, 'reset');
    send(res, 200, { link: resetUrl(token), token, expiresInMin, note: 'ابعته للمستخدم بنفسك؛ بيشتغل مرة واحدة.' });
  }, { open: true });

  route('GET', /^\/api\/me$/, async (req, res, { userId }) => send(res, 200, { emailVerified: !!db.emailVerifiedAt(userId), hasPassword: google.hasPassword(db.userByEmail(db.userById(userId).email).pass_hash), signInMethods: db.identitiesOf(userId).map((i) => i.provider), user: db.userById(userId), subscription: subOf(userId), isOwner: isOwner(userId), pricing, pro: pro.proStatus(db, userId, today()) }), { open: true });

  // ---- subscription (monthly; payment recorded by the platform owner) ----
  route('GET', /^\/api\/subscription$/, async (req, res, { userId }) => send(res, 200, { subscription: subOf(userId), events: db.subscriptionEvents(userId), pricing }), { open: true });
  const ownerOnly = (fn) => async (req, res, ctx) => (isOwner(ctx.userId) ? fn(req, res, ctx) : send(res, 404, { error: 'NOT_FOUND' }));
  const targetUser = (email) => db.userByEmail(String(email || '').trim().toLowerCase());
  route('GET', /^\/api\/owner\/subscriptions$/, ownerOnly(async (req, res) => {
    const email = new URL(req.url, 'http://x').searchParams.get('email');
    if (email) {
      const u = targetUser(email);
      if (!u) return send(res, 404, { error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' });
      return send(res, 200, { user: { id: u.id, email: u.email }, subscription: subOf(u.id), events: db.subscriptionEvents(u.id) });
    }
    send(res, 200, { users: db.allUsers().map((u) => ({ id: u.id, email: u.email, subscription: subOf(u.id) })) });
  }), { open: true });
  route('POST', /^\/api\/owner\/subscriptions$/, ownerOnly(async (req, res, { userId }) => {
    const b = await readJson(req);
    const u = targetUser(b.email);
    if (!u) return send(res, 404, { error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' });
    const r = subscription.extend(db, userId, u.id, Number(b.months), today(), b.note);
    if (r.error) return send(res, r.status, r);
    send(res, 200, { user: { id: u.id, email: u.email }, subscription: subOf(u.id), events: db.subscriptionEvents(u.id) });
  }), { open: true });
  route('POST', /^\/api\/owner\/subscriptions\/cancel$/, ownerOnly(async (req, res, { userId }) => {
    const b = await readJson(req);
    const u = targetUser(b.email);
    if (!u) return send(res, 404, { error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' });
    const r = subscription.cancel(db, userId, u.id, today(), b.confirm);
    if (r.error) return send(res, r.status, r);
    send(res, 200, { user: { id: u.id, email: u.email }, subscription: subOf(u.id), events: db.subscriptionEvents(u.id) });
  }), { open: true });

  // ---- reference data ----
  route('GET', /^\/api\/meta$/, async (req, res) => send(res, 200, {
    appName: 'أكلني', appNameEn: 'Eklni', fullName: 'أكلني | Eklni', fullNameEn: 'Eklni Nutrition Platform', tagline: 'منصة التغذية الذكية | Smart Nutrition Platform', today: today(), googleEnabled: !!googleAuth, pdfDownload: pdfRender.available(),
    sports: Object.entries(SPORTS).map(([k, v]) => ({ key: k, ar: v.ar })),
    scenarios: SCENARIOS, foodsMeta,
  }), { authed: false });

  route('GET', /^\/api\/recipes$/, async (req, res) => send(res, 200, listRecipes()), { authed: false });

  // ---- goal ----
  route('POST', /^\/api\/goal\/preview$/, async (req, res, { userId }) => {
    const body = await readJson(req);
    const v = validateGoalInput(body, { today: today() });
    if (Object.keys(v.errors).length) return send(res, 400, { error: 'VALIDATION', errors: v.errors });
    try {
      const plan = createPlan(v.value, today(), { selfWaiver: !!db.getSelfWaiver(userId) });
      send(res, 200, { input: v.value, plan, inputWarnings: v.warnings });
    } catch (e) {
      if (e.code) return send(res, 400, { error: e.code, errors: { [e.field || 'weeklyRateKg']: e.message }, recommendation: e.recommendation || recommendRate({ ...v.value, weightKg: v.value.currentWeight, selfWaiver: !!db.getSelfWaiver(userId) }, today()) });
      throw e;
    }
  });

  route('POST', /^\/api\/goal$/, async (req, res, { userId }) => {
    const body = await readJson(req);
    const v = validateGoalInput(body, { today: today() });
    if (Object.keys(v.errors).length) return send(res, 400, { error: 'VALIDATION', errors: v.errors });
    let plan;
    try { plan = createPlan(v.value, today(), { selfWaiver: !!db.getSelfWaiver(userId) }); } catch (e) {
      if (e.code) return send(res, 400, { error: e.code, errors: { [e.field || 'weeklyRateKg']: e.message } });
      throw e;
    }
    plan.inputWarnings = v.warnings;
    const goalId = db.saveGoal(userId, v.value, plan);
    db.upsertWeight(userId, goalId, v.value.startDate, v.value.currentWeight);
    send(res, 201, service.buildState(db, userId, today()));
  });

  route('POST', /^\/api\/goal\/recalculate$/, async (req, res, { userId }) => {
    const r = service.recalculate(db, userId, today());
    if (r.error) return send(res, 400, r);
    send(res, 200, service.buildState(db, userId, today()));
  });

  route('GET', /^\/api\/state$/, async (req, res, { userId }) => send(res, 200, service.buildState(db, userId, today())));

  // ---- weights ----
  route('POST', /^\/api\/weights$/, async (req, res, { userId }) => {
    const goal = db.activeGoal(userId);
    if (!goal) return send(res, 400, { error: 'NO_GOAL' });
    const v = validateWeightEntry(await readJson(req));
    if (Object.keys(v.errors).length) return send(res, 400, { error: 'VALIDATION', errors: v.errors });
    if (v.value.date < goal.startDate) return send(res, 400, { error: 'VALIDATION', errors: { date: 'التاريخ قبل بداية الخطة.' } });
    if (v.value.date > today()) return send(res, 400, { error: 'VALIDATION', errors: { date: 'لا يمكن تسجيل وزن بتاريخ مستقبلي.' } });
    db.upsertWeight(userId, goal.id, v.value.date, v.value.weightKg);
    send(res, 200, service.buildState(db, userId, today()));
  });

  route('DELETE', /^\/api\/weights\/(\d{4}-\d{2}-\d{2})$/, async (req, res, { userId, m }) => {
    const goal = db.activeGoal(userId);
    if (!goal) return send(res, 400, { error: 'NO_GOAL' });
    if (!db.deleteWeight(userId, goal.id, m[1])) return send(res, 404, { error: 'NOT_FOUND' });
    send(res, 200, service.buildState(db, userId, today()));
  });

  // ---- weekly check-in ----
  route('POST', /^\/api\/checkins$/, async (req, res, { userId }) => {
    const goal = db.activeGoal(userId);
    if (!goal) return send(res, 400, { error: 'NO_GOAL' });
    const v = validateCheckin(await readJson(req));
    if (Object.keys(v.errors).length) return send(res, 400, { error: 'VALIDATION', errors: v.errors });
    const currentWeek = Math.floor(diffDays(goal.startDate, today()) / 7);
    if (v.value.week > Math.max(0, currentWeek)) return send(res, 400, { error: 'VALIDATION', errors: { week: `لسه ما وصلناش للأسبوع ده (الأسبوع الحالي ${Math.max(0, currentWeek) + 1}).` } });
    db.upsertCheckin(userId, goal.id, v.value.week, v.value);
    send(res, 200, service.buildState(db, userId, today()));
  });

  // ---- adaptive adjustments ----
  route('POST', /^\/api\/adjustments\/evaluate$/, async (req, res, { userId }) => {
    const r = service.proposeAdjustment(db, userId, today());
    if (r.error) return send(res, 400, r);
    send(res, 200, { ...r, state: service.buildState(db, userId, today()) });
  });

  route('POST', /^\/api\/adjustments\/(\d+)\/decision$/, async (req, res, { userId, m }) => {
    const { decision, note } = await readJson(req);
    if (!['accepted', 'rejected'].includes(decision)) return send(res, 400, { error: 'VALIDATION', errors: { decision: 'قرار غير صحيح.' } });
    const r = service.decideAdjustment(db, userId, Number(m[1]), decision, typeof note === 'string' ? note.slice(0, 300) : null);
    if (r.error) return send(res, r.error === 'GUARD' ? 422 : 404, r);
    send(res, 200, service.buildState(db, userId, today()));
  });

  // ---- food preferences & weekly plan ----
  const seed = () => Math.floor(Math.random() * 2 ** 31);
  route('GET', /^\/api\/prefs$/, async (req, res, { userId }) => send(res, 200, { prefs: service.getPrefs(db, userId), options: service.prefsOptions() }));
  route('PUT', /^\/api\/prefs$/, async (req, res, { userId }) => {
    const r = service.savePrefs(db, userId, await readJson(req));
    send(res, r.error ? 400 : 200, r);
  });
  route('GET', /^\/api\/weekplan$/, async (req, res, { userId }) => { const r = service.getWeekPlan(db, userId, today()); send(res, r.error ? 400 : 200, r); });
  route('POST', /^\/api\/weekplan$/, async (req, res, { userId }) => { const r = service.newWeekPlan(db, userId, today(), seed()); send(res, r.error ? 400 : 200, r); });
  route('POST', /^\/api\/weekplan\/swap$/, async (req, res, { userId }) => {
    const b = await readJson(req);
    const day = Number(b.day), slot = Number(b.slot);
    if (!Number.isInteger(day) || !Number.isInteger(slot) || day < 0 || day > 6 || slot < 0 || slot > 12) return send(res, 400, { error: 'VALIDATION' });
    const r = service.swapWeekMeal(db, userId, day, slot, seed(), today());
    send(res, r.error ? 400 : 200, r);
  });

  const bodyInt = (v, lo, hi) => Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;
  route('POST', /^\/api\/weekplan\/extras$/, async (req, res, { userId }) => {
    const b = await readJson(req);
    if (!bodyInt(b.day, 0, 6) || typeof b.recipeId !== 'string') return send(res, 400, { error: 'VALIDATION' });
    if (b.servings != null && !(typeof b.servings === 'number' && b.servings >= 0.5 && b.servings <= 3 && Number.isInteger(b.servings * 2))) {
      return send(res, 400, { error: 'VALIDATION', errors: { servings: 'عدد الحصص من 0.5 لـ 3 (بزيادة نص).' } });
    }
    const r = service.addWeekExtra(db, userId, { day: Number(b.day), recipeId: b.recipeId, servings: b.servings, attachTo: b.attachTo == null ? null : Number(b.attachTo), compensate: b.compensate }, today());
    send(res, r.error ? 400 : 200, r);
  });
  route('DELETE', /^\/api\/weekplan\/extras\/(\d)\/([\w-]+)$/, async (req, res, { userId, m }) => {
    const r = service.removeWeekExtra(db, userId, { day: Number(m[1]), entryId: m[2] }, today());
    send(res, r.error ? 400 : 200, r);
  });
  route('GET', /^\/api\/weekplan\/sauces\/(\d)\/(\d{1,2})$/, async (req, res, { userId, m }) => { const r = service.weekSauces(db, userId, Number(m[1]), Number(m[2])); send(res, r.error ? 400 : 200, r); });
  route('GET', /^\/api\/weekplan\/history$/, async (req, res, { userId }) => { const r = service.weekPlanHistory(db, userId); send(res, r.error ? 400 : 200, r); });
  route('POST', /^\/api\/weekplan\/restore\/(\d+)$/, async (req, res, { userId, m }) => { const r = service.restoreWeekPlan(db, userId, Number(m[1]), today()); send(res, r.error ? (r.error === 'NOT_FOUND' ? 404 : 400) : 200, r); });

  // ---- health screening (self-report → referral flags; never a diagnosis) ----
  route('GET', /^\/api\/intake$/, async (req, res, { userId }) => { const r = service.intakeWeek(db, userId, today()); send(res, r.error ? r.status || 400 : 200, r); });
  route('PUT', /^\/api\/intake$/, async (req, res, { userId }) => { const r = service.logIntake(db, userId, await readJson(req), today()); send(res, r.error ? r.status || 400 : 200, r); });
  route('PUT', /^\/api\/calorie-override$/, async (req, res, { userId }) => {
    const r = service.setCalorieOverride(db, userId, await readJson(req), today(), seed());
    send(res, r.error ? r.status : 200, r);
  });
  route('DELETE', /^\/api\/calorie-override$/, async (req, res, { userId }) => send(res, 200, service.setCalorieOverride(db, userId, { clear: true }, today(), seed())), { open: true });
  route('PUT', /^\/api\/self-waiver$/, async (req, res, { userId }) => {
    const r = service.setSelfWaiver(db, userId, await readJson(req), today(), seed());
    send(res, r.error ? r.status : 200, r);
  });
  route('GET', /^\/api\/screening$/, async (req, res, { userId }) => send(res, 200, service.getScreening(db, userId)));
  route('PUT', /^\/api\/screening$/, async (req, res, { userId }) => { const r = service.saveScreening(db, userId, await readJson(req), today(), seed()); send(res, r.error ? 400 : 200, r); });

  // ---- hydration / sweat rate ----
  route('GET', /^\/api\/hydration$/, async (req, res, { userId }) => send(res, 200, service.getHydration(db, userId)));
  route('POST', /^\/api\/hydration$/, async (req, res, { userId }) => { const r = service.addHydration(db, userId, await readJson(req), today()); send(res, r.error ? 400 : 201, r); });
  route('DELETE', /^\/api\/hydration\/(\d+)$/, async (req, res, { userId, m }) => { const r = service.deleteHydration(db, userId, Number(m[1])); send(res, r.error ? 404 : 200, r); });
  route('POST', /^\/api\/hydration\/check$/, async (req, res) => send(res, 200, require('./engine/hydration').wutCheck(await readJson(req))));

  // ---- reference values & references registry ----
  route('GET', /^\/api\/dri$/, async (req, res, { userId }) => { const r = service.getDri(db, userId); send(res, r.error ? 400 : 200, r); });
  route('GET', /^\/api\/references$/, async (req, res) => send(res, 200, { ...require('./data/references.json'), foodQuality: require('./engine/meals').foodQuality() }), { authed: false });

  route('PUT', /^\/api\/goal\/season$/, async (req, res, { userId }) => {
    const b = await readJson(req);
    const r = service.setSeasonPhase(db, userId, b.seasonPhase, today());
    if (r.error) return send(res, 400, r);
    send(res, 200, service.buildState(db, userId, today()));
  });
  route('GET', /^\/api\/competition$/, async (req, res, { userId }) => send(res, 200, service.getCompetition(db, userId)));
  route('PUT', /^\/api\/competition$/, async (req, res, { userId }) => {
    const r = service.saveCompetition(db, userId, await readJson(req), today());
    send(res, r.error ? 400 : 200, r);
  });
  route('DELETE', /^\/api\/competition$/, async (req, res, { userId }) => send(res, 200, service.deleteCompetition(db, userId)));

  // ---- notifications: preferences (saved here) are separate from delivery (scheduler below) ----
  const externalConfigured = !!process.env.NOTIFY_WEBHOOK_URL;
  const notifInfo = () => ({ deliveryImplemented: true, channels: { inapp: true, external: externalConfigured } });
  route('GET', /^\/api\/notifications$/, async (req, res, { userId }) => send(res, 200, { settings: { ...notify.DEFAULTS, ...(db.getNotifications(userId) || {}) }, ...notifInfo() }));
  route('PUT', /^\/api\/notifications$/, async (req, res, { userId }) => {
    const v = notify.validateSettings(await readJson(req));
    if (Object.keys(v.errors).length) return send(res, 400, { error: 'VALIDATION', errors: v.errors });
    if (v.value.externalChannel && !externalConfigured) return send(res, 400, { error: 'VALIDATION', errors: { externalChannel: 'الإرسال الخارجي مش متفعّل على المنصة.' } });
    db.setNotifications(userId, v.value);
    send(res, 200, { settings: v.value, ...notifInfo() });
  });
  route('GET', /^\/api\/inbox$/, async (req, res, { userId }) => send(res, 200, { items: db.inbox(userId), unread: db.unreadCount(userId) }), { open: true });
  route('POST', /^\/api\/inbox\/(\d+)\/read$/, async (req, res, { userId, m }) => (db.markRead(userId, Number(m[1])) ? send(res, 200, { unread: db.unreadCount(userId) }) : send(res, 404, { error: 'NOT_FOUND' })), { open: true });
  route('POST', /^\/api\/inbox\/read-all$/, async (req, res, { userId }) => { db.markAllRead(userId); send(res, 200, { unread: 0 }); }, { open: true });

  // ---- household: shared dishes for people living together (src/household.js) ----
  const planOf = (uid) => service.currentPlanOf(db, uid);
  route('GET', /^\/api\/household$/, async (req, res, { userId }) => out(res, household.state(db, userId, planOf)), { open: true });
  route('POST', /^\/api\/household$/, async (req, res, { userId }) => out(res, household.create(db, userId, await readJson(req)), 201));
  route('PUT', /^\/api\/household$/, async (req, res, { userId }) => out(res, household.settings(db, userId, await readJson(req))));
  route('POST', /^\/api\/household\/invite$/, async (req, res, { userId }) => out(res, household.invite(db, userId, householdDeps), 201));
  route('POST', /^\/api\/household\/join$/, async (req, res, { userId }) => {
    const key = `hhjoin|${userId}`;
    if (throttle.limited(key, 10, 15)) return send(res, 429, { error: 'TOO_MANY', message: 'محاولات كتير؛ حاول بعد شوية.' });
    const r = household.join(db, userId, await readJson(req), householdDeps);
    if (r.error) throttle.hit(key);
    out(res, r);
  });
  route('POST', /^\/api\/household\/leave$/, async (req, res, { userId }) => out(res, household.leave(db, userId)), { open: true });
  route('DELETE', /^\/api\/household\/members\/(\d+)$/, async (req, res, { userId, m }) => out(res, household.removeMember(db, userId, Number(m[1]))));
  route('GET', /^\/api\/household\/grocery$/, async (req, res, { userId }) => out(res, household.grocery(db, userId, planOf)));

  // ---- academies, roles & consent (policy enforced in src/academy.js) ----
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const inviteDeps = {
    randomCode: () => { const b = crypto.randomBytes(10); let c = ''; for (let i = 0; i < 10; i++) c += ALPH[b[i] % ALPH.length]; return `${c.slice(0, 5)}-${c.slice(5)}`; },
    hash: (c) => auth.sha256(`invite:${c}`), nowMs: () => Date.now(),
  };
  const householdDeps = { ...inviteDeps, hash: (c) => auth.sha256(`household:${c}`) };
  const out = (res, r, ok = 200) => send(res, r && r.error ? r.status || 400 : ok, r);
  route('GET', /^\/api\/academies$/, async (req, res, { userId }) => out(res, academy.myAcademies(db, userId)), { staff: true });
  route('POST', /^\/api\/academies$/, async (req, res, { userId }) => out(res, academy.createAcademy(db, userId, await readJson(req)), 201), { staff: true });
  route('POST', /^\/api\/invites\/accept$/, async (req, res, { userId }) => out(res, academy.acceptInvite(db, userId, await readJson(req), inviteDeps)), { staff: true });
  route('POST', /^\/api\/academies\/(\d+)\/invites$/, async (req, res, { userId, m }) => out(res, academy.createInvite(db, userId, Number(m[1]), await readJson(req), inviteDeps), 201), { staff: true });
  route('GET', /^\/api\/academies\/(\d+)\/members$/, async (req, res, { userId, m }) => out(res, academy.listMembers(db, userId, Number(m[1]))), { staff: true });
  route('DELETE', /^\/api\/academies\/(\d+)\/members\/(\d+)$/, async (req, res, { userId, m }) => out(res, academy.removeMember(db, userId, Number(m[1]), Number(m[2]), await readJson(req))), { staff: true });
  route('PUT', /^\/api\/academies\/(\d+)\/sharing$/, async (req, res, { userId, m }) => out(res, academy.setSharing(db, userId, Number(m[1]), await readJson(req))), { staff: true });
  route('GET', /^\/api\/academies\/(\d+)\/athletes$/, async (req, res, { userId, m }) => out(res, academy.roster(db, userId, Number(m[1]), today())), { staff: true });
  route('GET', /^\/api\/academies\/(\d+)\/athletes\/(\d+)$/, async (req, res, { userId, m }) => out(res, academy.viewAthlete(db, userId, Number(m[1]), Number(m[2]), today())), { staff: true });
  route('POST', /^\/api\/academies\/(\d+)\/athletes\/(\d+)\/review$/, async (req, res, { userId, m }) => out(res, academy.reviewPlan(db, userId, Number(m[1]), Number(m[2]), await readJson(req), today())), { staff: true });
  route('GET', /^\/api\/academies\/(\d+)\/branding$/, async (req, res, { userId, m }) => out(res, academy.getBranding(db, userId, Number(m[1]))), { staff: true });
  route('PUT', /^\/api\/academies\/(\d+)\/branding$/, async (req, res, { userId, m }) => out(res, academy.setBranding(db, userId, Number(m[1]), await readJson(req, 600 * 1024))), { staff: true });
  // guardian link for athletes without an academy; consent stays reachable after a subscription ends
  route('POST', /^\/api\/family\/invite$/, async (req, res, { userId }) => out(res, academy.inviteGuardian(db, userId, await readJson(req), inviteDeps), 201), { open: true });
  route('PUT', /^\/api\/academies\/(\d+)\/minor-consent$/, async (req, res, { userId, m }) => out(res, academy.setMinorConsent(db, userId, Number(m[1]), await readJson(req))), { open: true });
  route('GET', /^\/api\/academies\/(\d+)\/audit$/, async (req, res, { userId, m }) => out(res, academy.auditLog(db, userId, Number(m[1]))), { staff: true });

  // ---- export ----
  route('GET', /^\/api\/report$/, async (req, res, { userId }) => {
    const st = service.buildState(db, userId, today());
    if (!st.goal) return send(res, 400, 'لا توجد خطة.');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'" });
    const iw = service.intakeWeek(db, userId, today());
    res.end(renderReport(st, db.userById(userId), academy.brandingFor(db, userId), iw && !iw.error ? iw : null));
  });
  // Real PDF download (needs EKLNI_CHROMIUM). Same content as the printable page, without the print bar.
  route('GET', /^\/api\/nutrition-file\.pdf$/, async (req, res, { userId }) => {
    if (!pdfRender.available()) return send(res, 501, { error: 'PDF_UNAVAILABLE', message: 'تنزيل PDF مش متفعّل على السيرفر ده؛ افتح الملف واختار «حفظ PDF / طباعة».' });
    const key = `pdf|${userId}`;
    if (throttle.limited(key, 10, 15)) return send(res, 429, { error: 'TOO_MANY', message: 'طلبات كتير؛ حاول بعد شوية.' });
    throttle.hit(key);
    const r = service.nutritionFile(db, userId, today(), academy.brandingFor(db, userId));
    if (r.error) return send(res, 400, r);
    let pdf;
    try { pdf = await pdfRender.render(r.html.replace(/<div class="bar">[\s\S]*?<\/div>/, '')); }
    catch { console.error('nutrition pdf render failed'); return send(res, 500, { error: 'PDF_FAILED', message: 'تعذر عمل الملف؛ جرّب «حفظ PDF / طباعة».' }); }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="eklni-nutrition-${today()}.pdf"` });
    res.end(pdf);
  });
  route('GET', /^\/api\/nutrition-file$/, async (req, res, { userId }) => {
    const r = service.nutritionFile(db, userId, today(), academy.brandingFor(db, userId));
    if (r.error) return send(res, 400, r.message || 'لا توجد خطة.');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline'" });
    res.end(r.html);
  });
  // ---- professional (dietitian) accounts: separate from the platform subscription ----
  route('GET', /^\/api\/pro$/, async (req, res, { userId }) => send(res, 200, pro.proStatus(db, userId, today())), { staff: true });
  route('POST', /^\/api\/pro\/apply$/, async (req, res, { userId }) => { const r = pro.apply(db, userId, await readJson(req)); send(res, r.error ? r.status : 200, r.error ? r : pro.proStatus(db, userId, today())); }, { staff: true });
  route('GET', /^\/api\/owner\/pro$/, ownerOnly(async (req, res) => send(res, 200, { professionals: db.professionals().map((p) => ({ ...p, ...pro.proStatus(db, p.userId, today()) })) })), { open: true });
  route('POST', /^\/api\/owner\/pro\/decision$/, ownerOnly(async (req, res, { userId }) => {
    const b = await readJson(req); const u = targetUser(b.email);
    if (!u) return send(res, 404, { error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' });
    const r = pro.decide(db, userId, u.id, b.decision, b.note);
    send(res, r.error ? r.status : 200, r.error ? r : pro.proStatus(db, u.id, today()));
  }), { open: true });
  route('POST', /^\/api\/owner\/pro\/subscriptions$/, ownerOnly(async (req, res, { userId }) => {
    const b = await readJson(req); const u = targetUser(b.email);
    if (!u) return send(res, 404, { error: 'NOT_FOUND', message: 'مفيش مستخدم بالإيميل ده.' });
    const r = pro.extend(db, userId, u.id, Number(b.months), today());
    send(res, r.error ? r.status : 200, r.error ? r : pro.proStatus(db, u.id, today()));
  }), { open: true });

  // ---- personal data: full export & account deletion (open even after the subscription expires) ----
  route('GET', /^\/api\/export\.json$/, async (req, res, { userId }) => {
    send(res, 200, account.exportData(db, userId), { 'Content-Disposition': 'attachment; filename="eklni-my-data.json"' });
  }, { open: true });
  route('DELETE', /^\/api\/account$/, async (req, res, { userId }) => {
    const r = account.deleteAccount(db, userId, await readJson(req), { verifyPassword: auth.verifyPassword });
    if (r.error) return send(res, r.status, r);
    send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }, { open: true });

  // ---- share links for the nutrition plan (e-mail / WhatsApp / Telegram) ----
  route('POST', /^\/api\/share$/, async (req, res, { userId }) => {
    const r = share.create(db, userId, await readJson(req), {
      randomToken: () => crypto.randomBytes(24).toString('base64url'), hash: (t) => auth.sha256(`share:${t}`), nowMs: () => Date.now(), baseUrl: baseUrlOf(req),
      render: (o) => service.nutritionFile(db, userId, today(), academy.brandingFor(db, userId), o),
    });
    send(res, r.error ? r.status : 201, r);
  });
  route('GET', /^\/api\/share$/, async (req, res, { userId }) => send(res, 200, { links: db.shares(userId).map((l) => ({ ...l, expiresAt: new Date(l.expiresAt).toISOString(), active: !l.revokedAt && l.expiresAt > Date.now() })) }), { open: true });
  route('DELETE', /^\/api\/share\/(\d+)$/, async (req, res, { userId, m }) => (db.revokeShare(userId, Number(m[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'NOT_FOUND' })), { open: true });

  // CSV export stays available after expiry: users can always take their own data.
  route('GET', /^\/api\/export\.csv$/, async (req, res, { userId }) => {
    const st = service.buildState(db, userId, today());
    if (!st.goal) return send(res, 400, 'لا توجد خطة.');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="eklni-progress.csv"', 'Cache-Control': 'no-store' });
    res.end(renderCsv(st));
  }, { open: true });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
        const sm = /^\/s\/([A-Za-z0-9_-]{20,64})$/.exec(url.pathname);
        if (sm) return serveShare(res, sm[1]);
        return serveStatic(req, res, url.pathname);
      }
      let pathMatched = false;
      for (const r of routes) {
        const m = r.pattern.exec(url.pathname);
        if (m) pathMatched = true;
        if (!m || r.method !== req.method) continue;
        const csrf = security.csrfCheck(req, allowedOrigins);
        if (csrf) return send(res, 403, { error: 'CSRF', message: 'طلب من موقع تاني اترفض.' });
        const userId = auth.currentUserId(db, req);
        if (r.authed && !userId) return send(res, 401, { error: 'UNAUTHENTICATED' });
        if (r.authed && !r.open) {
          const sub = subOf(userId);
          if (!sub.active && !(r.staff && pro.proStatus(db, userId, today()).subscription.active)) return send(res, 402, { error: 'SUBSCRIPTION_REQUIRED', message: 'الاشتراك انتهى؛ جدّد الاشتراك علشان تكمل استخدام الأدوات.', subscription: sub, pricing });
        }
        return await r.handler(req, res, { userId, m });
      }
      send(res, pathMatched ? 405 : 404, { error: pathMatched ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND' });
    } catch (e) {
      if (e.status) return send(res, e.status, { error: 'BAD_REQUEST', message: e.message });
      console.error(e);
      send(res, 500, { error: 'SERVER_ERROR' });
    }
  });
  // Retention housekeeping: at start-up and once a day (timer does not keep the process alive).
  account.maintenance(db);
  const maint = setInterval(() => { try { account.maintenance(db); } catch (e) { console.error('maintenance failed'); } }, 86400000);
  maint.unref();
  // Notification delivery: one tick per minute in the app's time zone (disabled with notifications:false).
  const tz = process.env.APP_TZ || 'Africa/Cairo';
  const localCtx = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: today(), hhmm: `${p.hour}:${p.minute}`, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
  };
  const sender = externalConfigured ? notify.webhookSender(process.env.NOTIFY_WEBHOOK_URL, process.env.NOTIFY_WEBHOOK_TOKEN) : null;
  const tick = () => notify.runDue(db, localCtx(), { subOf, send: sender }).catch(() => console.error('notification tick failed'));
  const notifTimer = notifications ? setInterval(tick, 60000) : null;
  if (notifTimer) notifTimer.unref();
  server.on('close', () => { clearInterval(maint); if (notifTimer) clearInterval(notifTimer); db.close(); });
  return { server, db, runNotifications: (ctx, opts = {}) => notify.runDue(db, ctx, { subOf, send: opts.send === undefined ? sender : opts.send }) };
}

if (require.main === module) {
  const cfg = require('./config').checkConfig();
  for (const w of cfg.warnings) console.warn(`config warning: ${w}`);
  if (cfg.errors.length) {
    for (const e of cfg.errors) console.error(`config error: ${e}`);
    if (cfg.production) process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);
  const { server } = createApp();
  server.listen(port, () => console.log(`أكلني | Eklni running on http://localhost:${port}`));
}

module.exports = { createApp, todayIn };
