'use strict';
// Client-side PDF of the nutrition file (used by the demo, and by servers without Chromium).
// 1) lays the printable page out in a hidden iframe at A4 content width and finds page cuts between rows;
// 2) draws every page (with the signature footer and the faint logo) to a canvas through an SVG foreignObject;
// 3) writes a minimal PDF with one JPEG per page. No external libraries.
// The text in this PDF is an image (not selectable); the server-side PDF (EKLNI_CHROMIUM) keeps real text.
(function (root) {
  const A4 = { w: 794, h: 1123, top: 53, bottom: 68, side: 45 }; // CSS px at 96 dpi: 210×297 mm, margins 14/18/12 mm
  const CONTENT_W = A4.w - 2 * A4.side;
  const CONTENT_H = A4.h - A4.top - A4.bottom;

  // ---- minimal PDF writer: pages = [{ bytes: Uint8Array (JPEG), w, h }] ----
  function jpegPdf(pages, title = '') {
    const enc = new TextEncoder();
    const chunks = []; let len = 0; const offs = [];
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); len += b.length; };
    const obj = (id, write) => { offs[id] = len; push(`${id} 0 obj\n`); write(); push('\nendobj\n'); };
    push('%PDF-1.4\n%âãÏÓ\n');
    const n = pages.length; const infoId = 3 + 3 * n;
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>`));
    pages.forEach((p, i) => {
      const id = 3 + 3 * i; const cs = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
      obj(id, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
      obj(id + 1, () => push(`<< /Length ${cs.length} >>\nstream\n${cs}\nendstream`));
      obj(id + 2, () => { push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`); push(p.bytes); push('\nendstream'); });
    });
    // Title as a UTF-16BE hex string (Arabic-safe), ASCII producer.
    const hex = (s) => 'FEFF' + Array.from(s).map((ch) => { const c = ch.codePointAt(0); return c > 0xffff ? (0xd800 + ((c - 0x10000) >> 10)).toString(16).padStart(4, '0') + (0xdc00 + ((c - 0x10000) & 0x3ff)).toString(16).padStart(4, '0') : c.toString(16).padStart(4, '0'); }).join('').toUpperCase();
    obj(infoId, () => push(`<< /Title <${hex(title)}> /Producer (Eklni) >>`));
    const xref = len; const size = infoId + 1;
    push(`xref\n0 ${size}\n0000000000 65535 f \n${offs.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
    push(`trailer\n<< /Size ${size} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len); let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  // ---- page cuts: never inside a table row, list item or paragraph; a day block moves whole when it fits ----
  function pageCuts(total, cands, forced, atomic, height = CONTENT_H) {
    const pages = []; let start = 0;
    while (start < total - 2) {
      const limit = start + height;
      const f = forced.find((y) => y > start + 5 && y <= limit);
      let cut;
      if (f) cut = f;
      else if (limit >= total) cut = total;
      else {
        const ok = cands.filter((y) => y > start + height * 0.15 && y <= limit && !atomic.some(([t, b]) => b - t <= height && y > t + 1 && y < b - 1));
        cut = ok.length ? ok[ok.length - 1] : limit;
      }
      pages.push([start, cut]); start = cut;
    }
    return pages;
  }

  const xmlText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const loadImage = (src) => new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('render')); im.src = src; });
  const b64bytes = (dataUrl) => { const s = atob(dataUrl.split(',')[1]); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };

  // Errors carry a stage code so a user can report where it failed on his device.
  const fail = (code, msg) => Object.assign(new Error(msg), { code });
  const withTimeout = (p, ms, code) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(fail(code, 'timeout')), ms))]);

  // Layout without an iframe (works where frames are restricted): parsed HTML in a shadow root.
  function layoutInShadow(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const css = Array.from(parsed.querySelectorAll('style')).map((x) => x.textContent).join('\n').replace(/\bbody\s*\{/g, '.pdfbody{');
    const sigEl = parsed.querySelector('.sig'); const wmImg = parsed.querySelector('.wm img');
    const out = { css, sigHtml: sigEl ? sigEl.innerHTML : '', logo: wmImg ? wmImg.getAttribute('src') : null };
    parsed.querySelectorAll('.bar, .wm, .sig, script').forEach((e) => e.remove());
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = `position:absolute;left:-12000px;top:0;width:${CONTENT_W}px;pointer-events:none`;
    const shadow = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style'); st.textContent = css;
    const wrap = document.createElement('div'); wrap.className = 'pdfbody'; wrap.setAttribute('dir', 'rtl');
    wrap.style.cssText = `margin:0;padding:0;width:${CONTENT_W}px;background:#fff`;
    Array.from(parsed.body.childNodes).forEach((n) => wrap.appendChild(document.importNode(n, true)));
    shadow.append(st, wrap);
    document.body.appendChild(host);
    return { ...out, root: wrap, cleanup: () => host.remove() };
  }
  // Layout in a same-origin iframe (the app: the page keeps its own CSP).
  async function layoutInIframe(url) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = `position:fixed;left:-12000px;top:0;width:${CONTENT_W}px;height:${A4.h}px;border:0;opacity:0;pointer-events:none`;
    const loaded = new Promise((r) => { frame.onload = r; });
    frame.src = url;
    document.body.appendChild(frame);
    await withTimeout(loaded, 15000, 'PDF-1');
    const doc = frame.contentDocument;
    if (!doc || !doc.body) throw fail('PDF-1', 'frame');
    const css = Array.from(doc.querySelectorAll('style')).map((x) => x.textContent).join('\n').replace(/\bbody\s*\{/g, '.pdfbody{');
    const sigEl = doc.querySelector('.sig'); const wmImg = doc.querySelector('.wm img');
    const out = { css, sigHtml: sigEl ? sigEl.innerHTML : '', logo: wmImg ? wmImg.getAttribute('src') : null };
    doc.querySelectorAll('.bar, .wm, .sig').forEach((e) => e.remove());
    Object.assign(doc.body.style, { margin: '0', padding: '0', width: `${CONTENT_W}px` });
    return { ...out, root: doc.body, cleanup: () => frame.remove() };
  }

  async function drawSvg(svg, scale) {
    let img;
    try { img = await withTimeout(loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)), 15000, 'PDF-2'); }
    catch {
      const u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      try { img = await withTimeout(loadImage(u), 15000, 'PDF-2'); } catch { throw fail('PDF-2', 'image'); } finally { setTimeout(() => URL.revokeObjectURL(u), 1000); }
    }
    const canvas = document.createElement('canvas');
    canvas.width = A4.w * scale; canvas.height = A4.h * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    try { return { bytes: b64bytes(canvas.toDataURL('image/jpeg', 0.9)), w: canvas.width, h: canvas.height }; }
    catch { throw fail('PDF-3', 'canvas'); } // the browser refused to export the drawing (e.g. some Safari versions)
  }

  // source: { html } (laid out in a shadow root) or { url } (same-origin page laid out in an iframe).
  async function nutritionPdf(source, { scale = 2, title = 'ملف التغذية — أكلني | Eklni' } = {}) {
    const L = source.html ? layoutInShadow(source.html) : await layoutInIframe(source.url);
    try {
      const root = L.root;
      if (document.fonts && document.fonts.ready) await withTimeout(document.fonts.ready, 5000, 'PDF-1').catch(() => {});
      const top0 = root.getBoundingClientRect().top;
      const y = (el, edge) => { const r = el.getBoundingClientRect(); return Math.round((edge === 'top' ? r.top : r.bottom) - top0); };
      const total = Math.ceil(root.getBoundingClientRect().height || root.scrollHeight);
      const cands = new Set([total]);
      root.querySelectorAll('tr, li, p, table, ul, div, section').forEach((e) => cands.add(y(e, 'bottom')));
      root.querySelectorAll('h2, h3, section, .page, table').forEach((e) => cands.add(y(e, 'top')));
      const forced = Array.from(root.querySelectorAll('.newpage')).map((e) => y(e, 'top')).sort((a, b) => a - b);
      const atomic = Array.from(root.querySelectorAll('.page')).map((e) => [y(e, 'top'), y(e, 'bottom')]);
      const cuts = pageCuts(total, [...cands].filter((v) => v > 0).sort((a, b) => a - b), forced, atomic);
      const ser = new XMLSerializer();
      const bodyX = Array.from(root.childNodes).map((n) => ser.serializeToString(n)).join('');
      const pages = [];
      for (let i = 0; i < cuts.length; i++) {
        const [s, e] = cuts[i];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${A4.w}" height="${A4.h}"><foreignObject x="0" y="0" width="${A4.w}" height="${A4.h}">`
          + `<div xmlns="http://www.w3.org/1999/xhtml" dir="rtl" lang="ar" style="width:${A4.w}px;height:${A4.h}px;position:relative;overflow:hidden;background:#fff">`
          + `<style>${xmlText(L.css)}</style>`
          + (L.logo ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><img src="${L.logo.replace(/"/g, '&quot;')}" style="max-width:55%;max-height:55%;opacity:.06" alt=""/></div>` : '')
          + `<div style="position:absolute;top:${A4.top}px;left:${A4.side}px;width:${CONTENT_W}px;height:${e - s}px;overflow:hidden">`
          + `<div class="pdfbody" style="position:absolute;top:${-s}px;left:0;width:${CONTENT_W}px;margin:0;padding:0">${bodyX}</div></div>`
          + `<div style="position:absolute;left:${A4.side}px;right:${A4.side}px;bottom:30px;border-top:1px solid #e5e7eb;padding-top:4px;text-align:center;font:11px Tahoma,sans-serif;color:#374151">${L.sigHtml}</div>`
          + `<div style="position:absolute;left:${A4.side}px;bottom:14px;font:10px Tahoma,sans-serif;color:#9ca3af" dir="ltr">${i + 1} / ${cuts.length}</div>`
          + '</div></foreignObject></svg>';
        pages.push(await drawSvg(svg, scale));
      }
      return { bytes: jpegPdf(pages, title), pages: pages.length };
    } finally { L.cleanup(); }
  }

  const api = { jpegPdf, pageCuts, nutritionPdf, A4, CONTENT_H };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EklniPdf = api;
})(typeof window !== 'undefined' ? window : globalThis);
