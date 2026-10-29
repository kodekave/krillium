import { describe, it, expect } from 'vitest';
import { artShapes, ART_KINDS, ART_BOX } from '../../site/js/art.js';

describe('empty-state art', () => {
  it('has one illustration for each moment the app can be empty', () => {
    expect([...ART_KINDS].sort()).toEqual(['load-error', 'no-changes', 'no-events', 'no-matches']);
  });

  it.each(['no-events', 'no-changes', 'load-error', 'no-matches'])('%s is a real drawing with a single amber accent', (kind) => {
    const shapes = artShapes(kind);
    expect(shapes.length).toBeGreaterThanOrEqual(5);
    expect(shapes.filter((s) => s.accent)).toHaveLength(1);
  });

  it.each(['no-events', 'no-changes', 'load-error', 'no-matches'])('%s stays inside the drawing box', (kind) => {
    for (const s of artShapes(kind)) {
      if (s.t === 'circle') {
        expect(s.cx - s.r).toBeGreaterThanOrEqual(0);
        expect(s.cx + s.r).toBeLessThanOrEqual(ART_BOX.w);
        expect(s.cy - s.r).toBeGreaterThanOrEqual(0);
        expect(s.cy + s.r).toBeLessThanOrEqual(ART_BOX.h);
      } else {
        const nums = s.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
        for (let i = 0; i < nums.length; i += 2) {
          expect(nums[i]).toBeGreaterThanOrEqual(0);
          expect(nums[i]).toBeLessThanOrEqual(ART_BOX.w);
          expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
          expect(nums[i + 1]).toBeLessThanOrEqual(ART_BOX.h);
        }
      }
    }
  });

  it('refuses a kind it does not have', () => {
    expect(() => artShapes('sunset')).toThrow(/unknown art/i);
  });
});
