// Empty-state illustrations in the Krillium style: dots, rings, one amber accent. Drawn with currentColor so they follow the theme.
import { s } from './dom.js';

export const ART_BOX = { w: 160, h: 120 };
export const ART_KINDS = ['no-events', 'no-changes', 'load-error', 'no-matches'];

const ring = (cx, cy, r, opacity = 0.28, dash = null) => ({ t: 'circle', cx, cy, r, line: true, opacity, dash });
const dot = (cx, cy, r, opacity = 1, accent = false) => ({ t: 'circle', cx, cy, r, opacity, accent });
const path = (d, opacity = 0.5, dash = null, accent = false) => ({ t: 'path', d, line: true, opacity, dash, accent });

const SHAPES = {
  // An empty radar waiting for its first event.
  'no-events': [
    ring(80, 62, 14), ring(80, 62, 30), ring(80, 62, 46, 0.18),
    path('M 80 62 L 108 34', 0.35),
    ring(104, 40, 7, 0.5, '2 3'),
    dot(80, 62, 2.4, 0.7),
    dot(104, 40, 3.2, 1, true),
    dot(48, 86, 1.8, 0.35), dot(120, 80, 1.8, 0.35),
  ],
  // Still water with a small shoal resting on it.
  'no-changes': [
    path('M 20 40 L 140 40', 0.2, '1 6'), path('M 20 56 L 140 56', 0.2, '1 6'), path('M 20 88 L 140 88', 0.2, '1 6'),
    dot(88, 72, 6.2, 1, true), dot(72, 74, 4.6, 0.9), dot(60, 77, 3.4, 0.75), dot(51, 79, 2.6, 0.6), dot(104, 76, 3.8, 0.8),
    path('M 20 72 L 140 72', 0.2, '1 6'),
  ],
  // An arc between two dots with a gap where the connection fails.
  'load-error': [
    dot(26, 78, 5, 0.9), dot(134, 78, 5, 0.9),
    path('M 31 76 Q 52 34 70 40', 0.55), path('M 90 40 Q 108 34 129 76', 0.55),
    path('M 76 52 L 84 60 M 84 52 L 76 60', 1, null, true),
    dot(80, 100, 1.8, 0.3), dot(66, 100, 1.8, 0.3), dot(94, 100, 1.8, 0.3),
  ],
  // A scatter of faint dots with a lens over the empty middle.
  'no-matches': [
    dot(24, 30, 3, 0.35), dot(46, 92, 2.6, 0.3), dot(130, 28, 3.4, 0.35), dot(138, 88, 2.4, 0.3), dot(30, 62, 2, 0.3), dot(118, 54, 2, 0.3),
    ring(76, 56, 26, 0.7), path('M 95 75 L 112 92', 0.7),
    ring(76, 56, 14, 0.25, '2 3'),
    dot(76, 56, 3, 1, true),
  ],
};

export function artShapes(kind) {
  if (!SHAPES[kind]) throw new Error(`Unknown art: ${kind}`);
  return SHAPES[kind];
}

export function artElement(kind) {
  return s('svg', { class: 'art', viewBox: `0 0 ${ART_BOX.w} ${ART_BOX.h}`, width: ART_BOX.w, height: ART_BOX.h, 'aria-hidden': 'true', focusable: 'false' },
    ...artShapes(kind).map((d) => {
      const base = { class: `${d.line ? 'a-line' : 'a-dot'}${d.accent ? ' a-accent' : ''}`, opacity: d.opacity === 1 ? null : d.opacity, 'stroke-dasharray': d.dash };
      return d.t === 'circle' ? s('circle', { ...base, cx: d.cx, cy: d.cy, r: d.r }) : s('path', { ...base, d: d.d });
    }));
}
