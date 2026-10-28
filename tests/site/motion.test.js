import { describe, it, expect, afterEach } from 'vitest';
import { prefersReducedMotion, countValue } from '../../site/js/motion.js';

const original = globalThis.matchMedia;
afterEach(() => {
  if (original) globalThis.matchMedia = original;
  else delete globalThis.matchMedia;
});

describe('prefersReducedMotion', () => {
  it('is true when the reduced-motion media query matches', () => {
    let asked = '';
    globalThis.matchMedia = (q) => { asked = q; return { matches: true }; };
    expect(prefersReducedMotion()).toBe(true);
    expect(asked).toBe('(prefers-reduced-motion: reduce)');
  });

  it('is false when the query does not match', () => {
    globalThis.matchMedia = () => ({ matches: false });
    expect(prefersReducedMotion()).toBe(false);
  });

  it('is false when matchMedia is unavailable', () => {
    delete globalThis.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('countValue', () => {
  it('starts at 0 and ends exactly on the target', () => {
    expect(countValue(97, 0)).toBe(0);
    expect(countValue(97, 1)).toBe(97);
  });

  it('rises monotonically and stays a whole number', () => {
    let last = -1;
    for (let t = 0; t <= 1; t += 0.1) {
      const v = countValue(97, t);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('clamps progress outside 0 to 1', () => {
    expect(countValue(50, -1)).toBe(0);
    expect(countValue(50, 3)).toBe(50);
  });
});
