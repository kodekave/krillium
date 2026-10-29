const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m: m - 1, d };
}

export function formatRange(start, end) {
  if (!start || !ISO_DATE.test(start)) return 'Dates TBC';
  const s = parts(start);
  if (!end || end === start || !ISO_DATE.test(end)) return `${s.d} ${MONTHS[s.m]} ${s.y}`;
  const e = parts(end);
  if (s.y === e.y && s.m === e.m) return `${s.d}–${e.d} ${MONTHS[s.m]} ${s.y}`;
  if (s.y === e.y) return `${s.d} ${MONTHS[s.m]} – ${e.d} ${MONTHS[e.m]} ${s.y}`;
  return `${s.d} ${MONTHS[s.m]} ${s.y} – ${e.d} ${MONTHS[e.m]} ${e.y}`;
}

// "5 min ago", "3 h ago", "2 d ago", or a date once it is two weeks old. Reads ISO timestamps and the database's
// "YYYY-MM-DD HH:MM:SS" form (UTC); anything else gives an empty string.
export function timeAgo(value, now = Date.now()) {
  if (typeof value !== 'string' || !value) return '';
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} d ago`;
  return formatRange(new Date(then).toISOString().slice(0, 10));
}

export function daysUntil(startIso, now = Date.now()) {
  if (!startIso || !ISO_DATE.test(startIso)) return null;
  const today = Math.floor(now / 86400000) * 86400000;
  return Math.round((Date.parse(`${startIso}T00:00:00Z`) - today) / 86400000);
}

// Every month from the earliest to the latest valid date. Invalid dates are ignored and the span is capped.
export function monthsSpan(events, maxMonths = 120) {
  const dates = events.flatMap((e) => [e.startDate, e.endDate ?? e.startDate]).filter((d) => d && ISO_DATE.test(d)).sort();
  if (!dates.length) return [];
  const [y0, m0] = dates[0].split('-').map(Number);
  const [y1, m1] = dates[dates.length - 1].split('-').map(Number);
  const months = [];
  for (let y = y0, m = m0; (y < y1 || (y === y1 && m <= m1)) && months.length < maxMonths; ) {
    months.push({ y, m });
    if (m === 12) { m = 1; y += 1; } else m += 1;
  }
  return months;
}
