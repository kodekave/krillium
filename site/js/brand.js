// Krillium mark: a shoal. An amber lead dot with a cone of smaller dots trailing behind it, like a krill swarm
// or a cluster of pins. The same geometry draws the in-app mark and the files made by scripts/gen-brand.mjs.
import { s } from './dom.js';

export const MARK_BOX = 64;
const MARGIN = 3;

// [x, y, radius] in rough, uncentred units. The first dot is the lead; the rest shrink as they trail away.
const DOTS = {
  full: [[46, 18, 8.6], [29.6, 20, 6.4], [40, 34, 5.6], [22, 36, 5], [32, 47, 4.4], [14, 48, 3.8], [22, 57, 3.2], [40, 58, 2.6], [8, 58, 2.2]],
  small: [[44, 20, 11], [24, 24, 8], [36, 44, 6.6], [16, 46, 5], [30, 58, 3.4]],
};
const TONES = [1, 0.95, 0.9, 0.85, 0.78, 0.7, 0.62, 0.55, 0.48];

// Centre the cluster in the box and scale it to fill the box minus a margin.
export function markShapes(variant = 'full') {
  const dots = DOTS[variant];
  const x0 = Math.min(...dots.map(([x, , r]) => x - r));
  const x1 = Math.max(...dots.map(([x, , r]) => x + r));
  const y0 = Math.min(...dots.map(([, y, r]) => y - r));
  const y1 = Math.max(...dots.map(([, y, r]) => y + r));
  const k = (MARK_BOX - 2 * MARGIN) / Math.max(x1 - x0, y1 - y0);
  const ox = MARK_BOX / 2 - ((x0 + x1) / 2) * k;
  const oy = MARK_BOX / 2 - ((y0 + y1) / 2) * k;
  return dots.map(([x, y, r], i) => ({
    cx: Number((x * k + ox).toFixed(2)),
    cy: Number((y * k + oy).toFixed(2)),
    r: Number((r * k).toFixed(2)),
    role: i === 0 ? 'head' : 'tail',
    tone: TONES[i],
  }));
}

export const variantForSize = (size) => (size < 40 ? 'small' : 'full');

// Inline, theme-aware mark: tail takes the text colour, head takes --amber.
export function markElement({ size = 32, variant = variantForSize(size), label = null } = {}) {
  return s('svg', { class: 'mark', viewBox: `0 0 ${MARK_BOX} ${MARK_BOX}`, width: size, height: size, role: label ? 'img' : null, 'aria-label': label, 'aria-hidden': label ? null : 'true' },
    ...markShapes(variant).map((d) => s('circle', { class: d.role === 'head' ? 'mark-head' : 'mark-tail', cx: d.cx, cy: d.cy, r: d.r, opacity: d.role === 'head' ? null : d.tone })));
}
