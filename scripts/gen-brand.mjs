#!/usr/bin/env node
// Writes the Krillium brand files from the geometry in site/js/brand.js: SVG mark, SVG favicon, PNG icons, ICO, manifest.
// No image library: a few lines of supersampled circle rasterising and a minimal PNG encoder.
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { MARK_BOX, markShapes } from '../site/js/brand.js';

const out = (p) => new URL(`../site/${p}`, import.meta.url);
const INK = [10, 22, 18];
const SAGE = [134, 195, 169];
const AMBER = [243, 178, 62];
const AMBER_HEX = '#f3b23e';

const circles = (shapes, attrs) => shapes.map((d) => `<circle ${attrs(d)} cx="${d.cx}" cy="${d.cy}" r="${d.r}"/>`).join('\n  ');

writeFileSync(out('assets/mark.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_BOX} ${MARK_BOX}" fill="none">
  <title>Krillium</title>
  ${circles(markShapes('full'), (d) => (d.role === 'head' ? `fill="${AMBER_HEX}"` : `fill="currentColor" opacity="${d.tone}"`))}
</svg>
`);

writeFileSync(out('assets/favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_BOX} ${MARK_BOX}">
  <style>
    .t { fill: #1f4a39; }
    .h { fill: #c27d08; }
    @media (prefers-color-scheme: dark) { .t { fill: #86c3a9; } .h { fill: ${AMBER_HEX}; } }
  </style>
  ${circles(markShapes('small'), (d) => `class="${d.role === 'head' ? 'h' : 't'}"`)}
</svg>
`);

// ---- raster
function raster(size, { variant, scale, rounded = 0 }) {
  const shapes = markShapes(variant);
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  const k = (size * scale) / MARK_BOX;
  const off = (size - size * scale) / 2;
  const radius = rounded * size;
  const inRounded = (x, y) => {
    if (!radius) return true;
    const dx = Math.max(radius - x, 0, x - (size - radius));
    const dy = Math.max(radius - y, 0, y - (size - radius));
    return dx * dx + dy * dy <= radius * radius;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!inRounded(fx, fy)) continue;
          let c = INK;
          for (const d of shapes) {
            const dx = fx - (off + d.cx * k);
            const dy = fy - (off + d.cy * k);
            if (dx * dx + dy * dy <= (d.r * k) ** 2) {
              const base = d.role === 'head' ? AMBER : SAGE;
              c = [0, 1, 2].map((i) => Math.round(INK[i] + (base[i] - INK[i]) * d.tone));
            }
          }
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

function png(size, rgba) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0;
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const write = (name, size, opts) => {
  writeFileSync(out(name), png(size, raster(size, opts)));
  return name;
};

write('assets/apple-touch-icon.png', 180, { variant: 'full', scale: 0.78 });
write('assets/icon-192.png', 192, { variant: 'full', scale: 0.78, rounded: 0.2 });
write('assets/icon-512.png', 512, { variant: 'full', scale: 0.78, rounded: 0.2 });
write('assets/icon-maskable-512.png', 512, { variant: 'full', scale: 0.56 });

// favicon.ico: PNG images at 16, 32 and 48 pixels (small mark on a rounded ink tile).
const icoSizes = [16, 32, 48];
const images = icoSizes.map((n) => png(n, raster(n, { variant: 'small', scale: 0.84, rounded: 0.22 })));
const header = Buffer.alloc(6 + 16 * icoSizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icoSizes.length, 4);
let offset = header.length;
icoSizes.forEach((n, i) => {
  const e = 6 + i * 16;
  header[e] = n;
  header[e + 1] = n;
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(images[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
writeFileSync(out('favicon.ico'), Buffer.concat([header, ...images]));

writeFileSync(out('manifest.webmanifest'), `${JSON.stringify({
  name: 'Krillium',
  short_name: 'Krillium',
  description: 'Which events to attend, and why.',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#0a1612',
  theme_color: '#0a1612',
  icons: [
    { src: 'assets/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'assets/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2)}\n`);
console.log('wrote brand files');
