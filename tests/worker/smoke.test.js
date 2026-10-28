import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('worker project', () => {
  it('exposes the D1 binding', () => {
    expect(env.DB).toBeDefined();
  });
});
