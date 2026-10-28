// Understands a handful of plain-English questions and maps them to the fixed /api/ask intents.
import { fold } from './shared/clean.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => d.toISOString().slice(0, 10);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parseRange(t, now) {
  const today = new Date(now);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();

  const rolling = /next\s+(\d+)\s+(day|week|month)s?/.exec(t);
  if (rolling) {
    const n = Number(rolling[1]);
    const end = new Date(Date.UTC(year, month, today.getUTCDate()));
    if (rolling[2] === 'month') end.setUTCMonth(end.getUTCMonth() + n);
    else end.setUTCDate(end.getUTCDate() + n * (rolling[2] === 'week' ? 7 : 1));
    return { from: iso(today), to: iso(end) };
  }

  const explicitYear = /\b(20\d\d)\b/.exec(t)?.[1];
  const quarter = /\bq([1-4])\b/.exec(t);
  if (quarter) {
    const q = Number(quarter[1]);
    const y = explicitYear ? Number(explicitYear) : (q * 3 - 1 < month ? year + 1 : year);
    return { from: `${y}-${pad(q * 3 - 2)}-01`, to: `${y}-${pad(q * 3)}-${lastDay(y, q * 3)}` };
  }

  const m = MONTH_RE.exec(t);
  if (m) {
    const idx = MONTHS.indexOf(m[1].slice(0, 3));
    const y = explicitYear ? Number(explicitYear) : (idx < month ? year + 1 : year);
    return { from: `${y}-${pad(idx + 1)}-01`, to: `${y}-${pad(idx + 1)}-${lastDay(y, idx + 1)}` };
  }
  return null;
}

export function parseAsk(text, now = Date.now()) {
  const t = fold(text);
  if (!t) return null;
  const range = parseRange(t, now);
  if (/\btier a\b|\bicp buyers?\b|most (?:tier a |icp )?buyers|top buyers/.test(t)) {
    return { intent: 'tier_a_by_event', params: range ?? {} };
  }
  if (/\bchanged\b|\bwhat'?s new\b|\bany changes\b/.test(t)) return { intent: 'changed_this_week', params: {} };
  if (range || /\bevents?\b/.test(t)) {
    const today = new Date(now);
    const end = new Date(today.getTime() + 90 * 86400000);
    return { intent: 'top_events_in_range', params: range ?? { from: iso(today), to: iso(end) } };
  }
  return null;
}
