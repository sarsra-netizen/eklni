'use strict';
// Builds demo/aklny-demo.html: a single self-contained page that runs the real engines and UI
// in the browser. The /api/* routes are served in-page by demo/shim.js (data kept on the device).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// --mobile: the offline Android app (mobile/android). No demo seed or demo bar, no subscription lock, no external
// fonts (offline + strict CSP), and saving/sharing goes through the native bridge (window.EklniAndroid).
const MOBILE = process.argv.includes('--mobile');
const modules = new Map(); // abs path -> { id, code }

function resolve(from, req) {
  let p = path.resolve(path.dirname(from), req);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (fs.existsSync(p + '.js')) return p + '.js';
  if (fs.existsSync(p + '.json')) return p + '.json';
  throw new Error(`Cannot resolve ${req} from ${from}`);
}

function add(file) {
  if (modules.has(file)) return modules.get(file).id;
  const id = modules.size;
  const entry = { id, code: '' };
  modules.set(file, entry);
  let src = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    entry.code = `module.exports = ${src};`;
    return id;
  }
  src = src.replace(/require\((['"])(\.{1,2}\/[^'"]+)\1\)/g, (m, q, req) => `__req(${add(resolve(file, req))})`);
  if (/require\(['"]node:/.test(src)) throw new Error(`${file} uses a Node built-in; it cannot run in the browser`);
  entry.code = src;
  return id;
}

const entryId = add(path.join(__dirname, 'shim.js'));
const bundle = `(function(){
var __defs = {${[...modules.values()].map((m) => `${m.id}: function(module, exports, __req){\n${m.code}\n}`).join(',\n')}};
var __cache = {};
function __req(id){ if (__cache[id]) return __cache[id].exports; var module = { exports: {} }; __cache[id] = module; __defs[id](module, module.exports, __req); return module.exports; }
__req(${entryId});
})();`;

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');

const head = MOBILE ? `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-src 'self' about: data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>أكلني | Eklni</title>
<meta name="theme-color" content="#0e7490">
<script>window.__EKLNI_MOBILE__ = true;</script>
` : `<title>أكلني | Eklni</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="theme-color" content="#0e7490">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap">
`;
const html = `${head}<style>
${read('public/styles.css')}
${read('demo/demo.css')}
</style>
<div id="app-root" dir="rtl" lang="ar">
  <div id="demo-bar" class="demo-bar" role="region" aria-label="${MOBILE ? 'بياناتك' : 'النسخة التجريبية'}"></div>
  <header class="topbar">
    <div class="brand"><span class="logo" aria-hidden="true">أ</span><span>أكلني <small class="brand-en">Eklni</small></span></div>
    <div id="topbar-sub" class="topbar-sub"></div>
  </header>
  <main id="view" class="view" tabindex="-1"><p class="muted center pad">جارٍ التحميل…</p></main>
  <nav id="tabs" class="tabs hidden" aria-label="التنقل الرئيسي"></nav>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <div id="sheet" class="sheet" hidden></div>
</div>
<script>
${esc(bundle)}
</script>
<script>
${esc(read('public/i18n.js'))}
</script>
<script>
${esc(read('public/chart.js'))}
</script>
<script>
${esc(read('public/pdfexport.js'))}
</script>
<script>
${esc(read('public/app.js'))}
</script>
`;

const out = MOBILE ? path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'assets', 'www', 'index.html') : path.join(__dirname, 'aklny-demo.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, MOBILE ? `${html}</html>\n` : html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB, ${modules.size} modules)`);
