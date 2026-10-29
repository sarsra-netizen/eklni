'use strict';
// 0.7.0: share the nutrition plan as a read-only link (e-mail / WhatsApp / Telegram).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/server');
const { shareTargets } = require('../src/share');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-share-'));
const dbPath = path.join(dir, 's.db');
let app, base, day = '2026-10-22';
test.before(async () => {
  app = createApp({ dbPath, today: () => day, trialDays: 30, notifications: false, registerLimitPerHour: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
test.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}
const GOAL = { sex: 'female', age: 24, heightCm: 168, currentWeight: 66, targetWeight: 62, startDate: '2026-10-22', sport: 'triathlon', discipline: 'olympic', sessionsPerWeek: 6, minutesPerSession: 80 };
async function athlete(email) {
  const c = client();
  await c('POST', '/api/auth/register', { email, password: 'longpass1' });
  await c('PUT', '/api/screening', { consent: true, menstrual: 'regular' });
  await c('POST', '/api/goal', GOAL);
  return c;
}
const pathOf = (url) => new URL(url).pathname;

test('share needs consent, a valid duration and a plan', async () => {
  const c = await athlete('a1@x.test');
  assert.equal((await c('POST', '/api/share', { days: 7 })).body.error, 'CONFIRM_REQUIRED');
  assert.equal((await c('POST', '/api/share', { days: 3, confirm: true })).status, 400);
  assert.equal((await c('POST', '/api/share', { days: 7, confirm: true })).status, 400, 'no week plan yet');
  assert.equal((await client()('POST', '/api/share', { days: 7, confirm: true })).status, 401);
});

test('link works without login, hides private data, is noindex, and can be revoked', async () => {
  const c = await athlete('private.person@x.test');
  await c('POST', '/api/weekplan', {});
  const r = await c('POST', '/api/share', { days: 7, confirm: true });
  assert.equal(r.status, 201);
  assert.match(r.body.whatsapp, /^https:\/\/wa\.me\/\?text=/);
  assert.match(r.body.telegram, /^https:\/\/t\.me\/share\/url\?url=/);
  assert.match(r.body.email, /^mailto:\?subject=/);
  const page = await fetch(base + pathOf(r.body.url));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.ok(!html.includes('private.person'), 'e-mail never in the shared page');
  assert.ok(!html.includes('<script'), 'no scripts in the shared page');
  // token is stored only as a hash
  const raw = new DatabaseSync(dbPath);
  const token = pathOf(r.body.url).slice(3);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM share_links WHERE token_hash = ?').get(token).n, 0);
  raw.close();
  const list = (await c('GET', '/api/share')).body.links;
  assert.equal(list[0].views, 1);
  assert.equal(list[0].active, true);
  // another user cannot revoke it
  const other = await athlete('other@x.test');
  assert.equal((await other('DELETE', `/api/share/${r.body.id}`)).status, 404);
  assert.equal((await c('DELETE', `/api/share/${r.body.id}`)).status, 200);
  assert.equal((await fetch(base + pathOf(r.body.url))).status, 410);
  assert.equal((await fetch(base + '/s/' + 'x'.repeat(32))).status, 410, 'unknown token: same answer');
});

test('expired links and links of an inactive subscription stop working', async () => {
  const c = await athlete('exp@x.test');
  await c('POST', '/api/weekplan', {});
  const a = (await c('POST', '/api/share', { days: 1, confirm: true })).body;
  const b = (await c('POST', '/api/share', { days: 30, confirm: true })).body;
  const raw = new DatabaseSync(dbPath);
  raw.prepare('UPDATE share_links SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, a.id);
  raw.close();
  assert.equal((await fetch(base + pathOf(a.url))).status, 410);
  assert.equal((await fetch(base + pathOf(b.url))).status, 200);
  day = '2027-03-01'; // trial over, no payment
  try { assert.equal((await fetch(base + pathOf(b.url))).status, 410); } finally { day = '2026-10-22'; }
});

test('deleting the account removes its links', async () => {
  const c = await athlete('del@x.test');
  await c('POST', '/api/weekplan', {});
  const s = (await c('POST', '/api/share', { days: 7, confirm: true })).body;
  assert.equal((await c('DELETE', '/api/account', { password: 'longpass1', confirm: 'DELETE' })).status, 200);
  assert.equal((await fetch(base + pathOf(s.url))).status, 410);
});

test('share targets encode the URL', () => {
  const t = shareTargets('https://e.example/s/abc', 7);
  assert.ok(t.whatsapp.includes(encodeURIComponent('https://e.example/s/abc')));
  assert.ok(t.text.includes('7 أيام'));
});
