const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m: m - 1, d };
}

export function formatRange(start, end) {
  if (!start) return 'Dates TBC';
  const s = parts(start);
  if (!end || end === start) return `${s.d} ${MONTHS[s.m]} ${s.y}`;
  const e = parts(end);
  if (s.y === e.y && s.m === e.m) return `${s.d}–${e.d} ${MONTHS[s.m]} ${s.y}`;
  if (s.y === e.y) return `${s.d} ${MONTHS[s.m]} – ${e.d} ${MONTHS[e.m]} ${s.y}`;
  return `${s.d} ${MONTHS[s.m]} ${s.y} – ${e.d} ${MONTHS[e.m]} ${e.y}`;
}

export function daysUntil(startIso, now = Date.now()) {
  if (!startIso) return null;
  const today = Math.floor(now / 86400000) * 86400000;
  return Math.round((Date.parse(`${startIso}T00:00:00Z`) - today) / 86400000);
}
