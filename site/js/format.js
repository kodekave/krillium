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
