'use strict';
// Calendar-correct date helpers. All dates are handled as UTC calendar days
// ("YYYY-MM-DD") so time zones and DST never shift a day.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

function parseDate(s) {
  if (s instanceof Date) return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  const m = ISO_RE.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Reject impossible dates such as 2026-02-30
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return d;
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = parseDate(dateStr);
  return fmt(new Date(d.getTime() + Math.round(days) * DAY_MS));
}

function diffDays(fromStr, toStr) {
  return Math.round((parseDate(toStr) - parseDate(fromStr)) / DAY_MS);
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

// Whole calendar months + remaining days between two dates (respects month lengths).
function monthsAndDays(fromStr, toStr) {
  const a = parseDate(fromStr);
  const b = parseDate(toStr);
  if (b < a) return { months: 0, days: 0 };
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  const anchor = () => {
    const y = a.getUTCFullYear() + Math.floor((a.getUTCMonth() + months) / 12);
    const mo = (a.getUTCMonth() + months) % 12;
    const day = Math.min(a.getUTCDate(), daysInMonth(y, mo));
    return new Date(Date.UTC(y, mo, day));
  };
  let an = anchor();
  if (an > b) { months -= 1; an = anchor(); }
  return { months, days: Math.round((b - an) / DAY_MS) };
}

// Same day-of-month n months later (clamped to the month's last day): 2026-01-31 + 1 → 2026-02-28.
function addMonths(dateStr, n) {
  const a = parseDate(dateStr);
  const total = a.getUTCMonth() + n;
  const y = a.getUTCFullYear() + Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  return fmt(new Date(Date.UTC(y, mo, Math.min(a.getUTCDate(), daysInMonth(y, mo)))));
}

module.exports = { parseDate, fmt, addDays, addMonths, diffDays, monthsAndDays, DAY_MS };
