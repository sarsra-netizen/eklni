'use strict';
// Server-side PDF of the nutrition file with a headless Chromium ("print to PDF"): real, selectable Arabic text,
// and the signature/watermark repeat on every page (position:fixed elements print on each page).
// Enabled only when EKLNI_CHROMIUM points at a chrome/chromium/headless_shell binary. JavaScript is disabled
// scripts are blocked by a CSP meta tag (the --blink-settings script switch breaks print-to-pdf), and the network is cut off for the render; the HTML is the app's own escaped output.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let chain = Promise.resolve(); // one render at a time

function available(env = process.env) {
  const p = env.EKLNI_CHROMIUM;
  if (!p) return false;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function args(inFile, outFile, env) {
  return [
    '--headless', '--disable-gpu', '--no-first-run', '--disable-extensions', '--disable-sync', '--mute-audio',
    '--proxy-server=socks5://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', // no network access
    '--no-pdf-header-footer', '--print-to-pdf-no-header',
    ...(env.EKLNI_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    `--print-to-pdf=${outFile}`, pathToFileURL(inFile).href,
  ];
}

function render(html, { env = process.env, timeoutMs = 45000 } = {}) {
  const run = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklni-pdf-'));
    const inFile = path.join(dir, 'file.html'); const outFile = path.join(dir, 'file.pdf');
    try {
      const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">';
      fs.writeFileSync(inFile, html.replace(/<head>/i, `<head>${csp}`), { mode: 0o600 });
      await new Promise((resolve, reject) => {
        execFile(env.EKLNI_CHROMIUM, args(inFile, outFile, env), { timeout: timeoutMs, env: { HOME: dir, PATH: process.env.PATH || '' } },
          (err) => (err && !fs.existsSync(outFile) ? reject(new Error('pdf render failed')) : resolve()));
      });
      const buf = fs.readFileSync(outFile);
      if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('pdf render failed');
      return buf;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

module.exports = { render, available };
