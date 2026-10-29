'use strict';
// Goal timeline chart (hand-built SVG, no external libraries).
// One y-axis (kg). Planned/scenario lines are straight lines at explicit rates; actual = weekly averages.
window.TimelineChart = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const DAY = 86400000;
  const d2n = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
  const shortDate = (ms) => { const d = new Date(ms); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }

  function render(container, tl, goal) {
    container.innerHTML = '';
    const W = 640, H = 300, L = 40, R = 14, T = 16, B = 34;
    const start = d2n(goal.startDate);
    const scen = Object.fromEntries(tl.scenarios.map((s) => [s.key, s]));
    const endDate = Math.max(d2n(scen.slowest.completionDate), d2n(tl.projection.completionDate),
      ...tl.actual.map((a) => d2n(a.date) + 7 * DAY));
    const ys = [tl.startWeight, tl.targetWeight, ...tl.actual.map((a) => a.weight)];
    const lo = Math.floor(Math.min(...ys) - 0.5), hi = Math.ceil(Math.max(...ys) + 0.5);
    const x = (ms) => L + ((ms - start) / (endDate - start)) * (W - L - R);
    const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', direction: 'ltr',
      'aria-label': `مخطط الوزن: من ${tl.startWeight} إلى ${tl.targetWeight} كجم، الوزن الحالي ${tl.currentWeight} كجم` }, container);

    // grid + y labels
    const step = Math.max(1, Math.round((hi - lo) / 5));
    for (let v = lo; v <= hi; v += step) {
      el('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'svg-grid', 'stroke-width': 1 }, svg);
      el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'svg-axis' }, svg).textContent = v;
    }
    // x ticks (about 5)
    const spanDays = (endDate - start) / DAY;
    const tickEvery = Math.max(7, Math.ceil(spanDays / 5 / 7) * 7);
    for (let d = 0; d <= spanDays; d += tickEvery) {
      el('text', { x: x(start + d * DAY), y: H - 12, 'text-anchor': 'middle', class: 'svg-axis' }, svg).textContent = shortDate(start + d * DAY);
    }

    // target line
    el('line', { x1: L, x2: W - R, y1: y(tl.targetWeight), y2: y(tl.targetWeight), class: 'svg-target', 'stroke-width': 1.5, 'stroke-dasharray': '2 4' }, svg);
    el('text', { x: W - R, y: y(tl.targetWeight) - 6, 'text-anchor': 'end', class: 'svg-label' }, svg).textContent = `الهدف ${tl.targetWeight}`;

    const lineTo = (s, cls, dash) => {
      el('line', { x1: x(start), y1: y(tl.startWeight), x2: x(d2n(s.completionDate)), y2: y(tl.targetWeight),
        class: cls, 'stroke-width': 2, 'stroke-linecap': 'round', ...(dash ? { 'stroke-dasharray': dash } : {}) }, svg);
    };
    lineTo(scen.slowest, 'svg-slow', '2 5');
    lineTo(scen.conservative, 'svg-cons', '8 5');
    lineTo(scen.medium, 'svg-plan', '5 4');

    // actual weekly averages
    const act = tl.actual.map((a) => ({ ...a, ms: d2n(a.date) + 3 * DAY }));
    if (act.length) {
      el('path', { d: act.map((p, i) => `${i ? 'L' : 'M'}${x(p.ms).toFixed(1)},${y(p.weight).toFixed(1)}`).join(' '),
        class: 'svg-actual', fill: 'none', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, svg);
      act.forEach((p) => el('circle', { cx: x(p.ms), cy: y(p.weight), r: 4.5, class: 'svg-actual-dot' }, svg));
      const lp = act[act.length - 1];
      el('text', { x: x(lp.ms), y: y(lp.weight) - 10, 'text-anchor': 'middle', class: 'svg-label' }, svg).textContent = `${lp.weight}`;
    }
    // projected date marker
    const pd = d2n(tl.projection.completionDate);
    el('line', { x1: x(pd), x2: x(pd), y1: y(tl.targetWeight) - 8, y2: y(tl.targetWeight) + 8, class: 'svg-actual', 'stroke-width': 2 }, svg);

    // hover layer: crosshair + tooltip per week
    const cross = el('line', { y1: T, y2: H - B, class: 'svg-cross', 'stroke-width': 1, visibility: 'hidden' }, svg);
    const tip = document.createElement('div');
    tip.className = 'tooltip hidden';
    container.appendChild(tip);
    const hit = el('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' }, svg);
    const plannedAt = (ms, s) => {
      const wk = (ms - start) / (7 * DAY);
      return Math.max(tl.targetWeight, tl.startWeight - s.rateKg * wk);
    };
    const move = (evt) => {
      const pt = svg.createSVGPoint();
      const src = evt.touches ? evt.touches[0] : evt;
      pt.x = src.clientX; pt.y = src.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      const ms = start + ((p.x - L) / (W - L - R)) * (endDate - start);
      const wk = Math.max(0, Math.round((ms - start) / (7 * DAY)));
      const wms = start + wk * 7 * DAY;
      const a = act.find((q) => Math.round((q.ms - 3 * DAY - start) / (7 * DAY)) === wk);
      cross.setAttribute('x1', x(wms)); cross.setAttribute('x2', x(wms)); cross.setAttribute('visibility', 'visible');
      tip.innerHTML = '';
      const lines = [`الأسبوع ${wk + 1} · ${fmtDate(wms)}`, `المخطط: ${plannedAt(wms, scen.medium).toFixed(1)} كجم`];
      if (a) lines.push(`المتوسط الفعلي: ${a.weight} كجم`);
      lines.forEach((s, i) => { const d = document.createElement('div'); d.textContent = s; if (i === 0) d.className = 'muted'; tip.appendChild(d); });
      const box = container.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(src.clientX - box.left, 70), box.width - 70)}px`;
      tip.style.top = `${src.clientY - box.top}px`;
      tip.classList.remove('hidden');
    };
    const leave = () => { cross.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); };
    hit.addEventListener('mousemove', move);
    hit.addEventListener('touchmove', move, { passive: true });
    hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchend', leave);
  }

  return { render };
})();
