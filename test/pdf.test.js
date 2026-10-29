'use strict';
// Downloadable nutrition PDF: the browser-side writer/paginator (public/pdfexport.js) and the server route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { jpegPdf, pageCuts, CONTENT_H } = require('../public/pdfexport');

test('pdf writer: valid header, one page object per image, correct xref offsets', () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const bytes = jpegPdf([{ bytes: jpg, w: 2, h: 3 }, { bytes: jpg, w: 2, h: 3 }], 'ملف التغذية');
  const s = Buffer.from(bytes).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.match(s, /\/Type \/Pages \/Count 2/);
  assert.equal((s.match(/\/Type \/Page /g) || []).length, 2);
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(xref, xref + 4), 'xref');
  const offsets = s.slice(xref).split('\n').filter((l) => / 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
  offsets.forEach((o, i) => assert.equal(s.slice(o, o + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
});

test('page cuts: forced breaks, no cut inside a block that fits a page, every pixel on exactly one page', () => {
  const total = 3000;
  const cands = [100, 400, 700, 950, 1200, 1500, 1900, 2300, 2700, 3000];
  const forced = [2300];
  const atomic = [[900, 1300]];
  const cuts = pageCuts(total, cands, forced, atomic, 1000);
  assert.equal(cuts[0][0], 0);
  assert.equal(cuts[cuts.length - 1][1], total);
  for (let i = 1; i < cuts.length; i++) assert.equal(cuts[i][0], cuts[i - 1][1]);
  for (const [s, e] of cuts) assert.ok(e - s <= 1000);
  assert.ok(cuts.some(([s]) => s === 2300), 'forced break respected');
  assert.ok(!cuts.some(([, e]) => e > 900 && e < 1300), 'no cut inside the atomic block');
  assert.ok(CONTENT_H > 900 && CONTENT_H < 1123);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-pdf-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function serverWith(env, name) {
  const keep = { EKLNI_CHROMIUM: process.env.EKLNI_CHROMIUM, EKLNI_CHROMIUM_NO_SANDBOX: process.env.EKLNI_CHROMIUM_NO_SANDBOX };
  Object.assign(process.env, env);
  for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
  delete require.cache[require.resolve('../src/server')];
  const { createApp } = require('../src/server');
  const app = createApp({ dbPath: path.join(dir, `${name}.db`), today: () => '2026-10-22', trialDays: 30, notifications: false, registerLimitPerHour: 100 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const c = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r;
  };
  const close = async () => {
    app.server.closeAllConnections(); await new Promise((r) => app.server.close(r));
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  await c('POST', '/api/auth/register', { email: `${name}@x.test`, password: 'longpass1' });
  await c('PUT', '/api/screening', { consent: true });
  await c('POST', '/api/goal', { sex: 'male', age: 28, heightCm: 178, currentWeight: 84, targetWeight: 78, startDate: '2026-10-22', sport: 'swimming', sessionsPerWeek: 5, minutesPerSession: 90 });
  return { c, close };
}

test('server PDF: 501 with a clear message when Chromium is not configured', async () => {
  const s = await serverWith({ EKLNI_CHROMIUM: undefined }, 'nochrome');
  try {
    assert.equal((await (await s.c('GET', '/api/meta')).json()).pdfDownload, false);
    const r = await s.c('GET', '/api/nutrition-file.pdf');
    assert.equal(r.status, 501);
    assert.equal((await r.json()).error, 'PDF_UNAVAILABLE');
  } finally { await s.close(); }
});

const CHROME = ['/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell', process.env.EKLNI_TEST_CHROMIUM].find((p) => p && fs.existsSync(p));
test('server PDF: real A4 PDF download with the signature on the pages (needs a Chromium binary)', { skip: !CHROME && 'no Chromium binary on this machine' }, async () => {
  const s = await serverWith({ EKLNI_CHROMIUM: CHROME, EKLNI_CHROMIUM_NO_SANDBOX: '1' }, 'chrome');
  try {
    assert.equal((await (await s.c('GET', '/api/meta')).json()).pdfDownload, true);
    assert.equal((await s.c('GET', '/api/nutrition-file.pdf')).status, 400, 'no week plan yet');
    await s.c('POST', '/api/weekplan', {});
    const r = await s.c('GET', '/api/nutrition-file.pdf');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="eklni-nutrition-2026-10-22\.pdf"$/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok((buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length >= 3);
  } finally { await s.close(); }
});
