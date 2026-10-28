// Pure map maths: Miller projection, arcs, pin sizing, date windows. No DOM.

const MILLER = 1.25;
const LAT_TOP = 80;
const LAT_BOTTOM = -58;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n) => Number(n.toFixed(2));

const millerY = (lat) => deg(MILLER * Math.log(Math.tan(Math.PI / 4 + 0.4 * rad(clamp(lat, -85, 85)))));
const Y_TOP = millerY(LAT_TOP);
const Y_BOTTOM = millerY(LAT_BOTTOM);

export const WORLD = { width: 1800, height: Math.round((1800 * (Y_TOP - Y_BOTTOM)) / 360) };

export function project(lat, lon, { width, height }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return [((lon + 180) / 360) * width, ((Y_TOP - millerY(lat)) / (Y_TOP - Y_BOTTOM)) * height];
}

export function unproject(x, y, { width, height }) {
  const lon = (x / width) * 360 - 180;
  const projected = Y_TOP - (y / height) * (Y_TOP - Y_BOTTOM);
  const lat = deg((Math.atan(Math.exp(rad(projected) / MILLER)) - Math.PI / 4) / 0.4);
  return [lat, lon];
}

export function arcPath([ax, ay], [bx, by], bow = 0.22) {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const lift = Math.hypot(bx - ax, by - ay) * bow;
  return `M ${round(ax)} ${round(ay)} Q ${round(mx)} ${round(my - lift)} ${round(bx)} ${round(by)}`;
}

export const pinRadius = (priority) => 5 + 11 * clamp(priority / 100, 0, 1);

export function dateWindow(events, fromIso, toIso) {
  return events.filter((e) => !e.startDate || (e.startDate <= toIso && (e.endDate ?? e.startDate) >= fromIso));
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export function nearestBase(event, bases) {
  if (!Number.isFinite(event.lat) || !Number.isFinite(event.lon) || !bases?.length) return null;
  return bases.reduce((best, b) =>
    distanceKm(event.lat, event.lon, b.lat, b.lon) < distanceKm(event.lat, event.lon, best.lat, best.lon) ? b : best,
  );
}

export function fitView(points, aspect, padding = 0) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  let w = Math.max(...xs) - Math.min(...xs) + 2 * padding;
  let h = Math.max(...ys) - Math.min(...ys) + 2 * padding;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
