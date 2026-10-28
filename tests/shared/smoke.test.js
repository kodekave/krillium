import { describe, it, expect } from 'vitest';

describe('shared project', () => {
  it('runs under node', () => {
    expect(1 + 1).toBe(2);
  });
});
