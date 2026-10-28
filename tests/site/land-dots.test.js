import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { project } from '../../site/js/map-geometry.js';

const data = JSON.parse(readFileSync(new URL('../../site/data/land-dots.json', import.meta.url), 'utf8'));
const size = { width: data.width, height: data.height };
const cells = new Set();
for (let i = 0; i < data.dots.length; i += 2) cells.add(`${data.dots[i]},${data.dots[i + 1]}`);
const hasLandNear = (lat, lon) => {
  const [x, y] = project(lat, lon, size);
  const cx = Math.round(x / data.step);
  const cy = Math.round(y / data.step);
  for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) if (cells.has(`${cx + dx},${cy + dy}`)) return true;
  return false;
};

describe('land dots', () => {
  it('has a plausible number of dots on a regular grid', () => {
    expect(data.dots.length / 2).toBeGreaterThan(2500);
    expect(data.dots.length / 2).toBeLessThan(12000);
    expect(data.dots.every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });
  it('puts land under Berlin, New York and Orlando', () => {
    expect(hasLandNear(52.52, 13.405)).toBe(true);
    expect(hasLandNear(40.7128, -74.006)).toBe(true);
    expect(hasLandNear(28.5383, -81.3792)).toBe(true);
  });
  it('leaves the mid-Atlantic empty', () => {
    expect(hasLandNear(30, -40)).toBe(false);
  });
});
