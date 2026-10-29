import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { markShapes, variantForSize, MARK_BOX } from '../../site/js/brand.js';

const site = (p) => new URL(`../../site/${p}`, import.meta.url);
const read = (p) => readFileSync(site(p), 'utf8');

describe.each(['full', 'small'])('mark geometry (%s)', (variant) => {
  const shapes = markShapes(variant);

  it('has an amber head that is the largest dot, followed by a shrinking tail', () => {
    expect(shapes[0].role).toBe('head');
    expect(shapes.slice(1).every((s) => s.role === 'tail')).toBe(true);
    for (let i = 1; i < shapes.length; i += 1) expect(shapes[i].r).toBeLessThan(shapes[i - 1].r);
  });

  it('keeps every dot inside the box', () => {
    for (const s of shapes) {
      expect(s.cx - s.r).toBeGreaterThanOrEqual(0);
      expect(s.cx + s.r).toBeLessThanOrEqual(MARK_BOX);
      expect(s.cy - s.r).toBeGreaterThanOrEqual(0);
      expect(s.cy + s.r).toBeLessThanOrEqual(MARK_BOX);
    }
  });

  it('keeps a visible gap between every pair of dots', () => {
    for (let i = 0; i < shapes.length; i += 1) {
      for (let j = i + 1; j < shapes.length; j += 1) {
        const a = shapes[i];
        const b = shapes[j];
        expect(Math.hypot(a.cx - b.cx, a.cy - b.cy) - a.r - b.r, `dots ${i} and ${j}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('is centred in the box', () => {
    const xs = shapes.flatMap((d) => [d.cx - d.r, d.cx + d.r]);
    const ys = shapes.flatMap((d) => [d.cy - d.r, d.cy + d.r]);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(MARK_BOX / 2, 0);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(MARK_BOX / 2, 0);
  });

  it('fades the tail from the head outward', () => {
    expect(shapes[0].tone).toBe(1);
    for (let i = 2; i < shapes.length; i += 1) expect(shapes[i].tone).toBeLessThanOrEqual(shapes[i - 1].tone);
  });
});

describe('variantForSize', () => {
  it('uses the bolder five-dot mark below 40px and the full mark from 40px', () => {
    expect(variantForSize(16)).toBe('small');
    expect(variantForSize(32)).toBe('small');
    expect(variantForSize(39)).toBe('small');
    expect(variantForSize(40)).toBe('full');
    expect(variantForSize(96)).toBe('full');
  });
});

describe('mark variants', () => {
  it('uses more dots in the full mark than in the small one', () => {
    expect(markShapes('full').length).toBe(9);
    expect(markShapes('small').length).toBe(5);
  });
});

const pngSize = (file) => {
  const b = readFileSync(site(file));
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

describe('brand files', () => {
  it('ships the standalone mark in currentColor with an amber head', () => {
    const svg = read('assets/mark.svg');
    expect(svg).toContain('currentColor');
    expect(svg).toContain('#f3b23e');
    expect(svg).toContain('viewBox="0 0 64 64"');
  });

  it('ships an SVG favicon that adapts to the browser theme', () => {
    const svg = read('assets/favicon.svg');
    expect(svg).toContain('prefers-color-scheme: dark');
    expect(svg.match(/<circle/g)).toHaveLength(5);
  });

  it('ships PNG icons at the sizes the manifest and iOS expect', () => {
    expect(pngSize('assets/apple-touch-icon.png')).toEqual([180, 180]);
    expect(pngSize('assets/icon-192.png')).toEqual([192, 192]);
    expect(pngSize('assets/icon-512.png')).toEqual([512, 512]);
    expect(pngSize('assets/icon-maskable-512.png')).toEqual([512, 512]);
  });

  it('ships an ICO holding 16, 32 and 48 pixel images', () => {
    const b = readFileSync(site('favicon.ico'));
    expect(b.readUInt16LE(0)).toBe(0);
    expect(b.readUInt16LE(2)).toBe(1);
    expect(b.readUInt16LE(4)).toBe(3);
    const dims = [0, 1, 2].map((i) => b.readUInt8(6 + i * 16));
    expect(dims).toEqual([16, 32, 48]);
  });

  it('has a manifest named Krillium whose icons exist', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'));
    expect(manifest.name).toBe('Krillium');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);
    for (const icon of manifest.icons) {
      expect(existsSync(site(icon.src))).toBe(true);
      expect(icon.sizes).toMatch(/^\d+x\d+$/);
    }
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });
});

describe('index.html', () => {
  const html = read('index.html');

  it('links the favicon set and manifest by relative paths that exist', () => {
    for (const href of ['assets/favicon.svg', 'favicon.ico', 'assets/apple-touch-icon.png', 'manifest.webmanifest']) {
      expect(html).toContain(`href="${href}"`);
      expect(existsSync(site(href))).toBe(true);
    }
  });

  it('is titled Krillium', () => {
    expect(html).toMatch(/<title>Krillium<\/title>/);
  });
});

describe('product name', () => {
  it('no longer shows the working title to users', () => {
    for (const file of ['index.html', 'js/main.js', 'js/auth.js', 'js/drawer.js', 'js/ask.js', 'js/views/radar.js', 'js/views/events.js', 'js/views/feed.js', 'js/views/graph.js', 'js/views/icp.js']) {
      expect(read(file), file).not.toMatch(/GTM Radar/);
    }
  });
});
