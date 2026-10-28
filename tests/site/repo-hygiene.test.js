import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

const ignored = (path) => spawnSync('git', ['check-ignore', '-q', path]).status === 0;

describe('what git ignores', () => {
  it('does not ignore the map data the site needs at runtime', () => {
    expect(ignored('site/data/land-dots.json')).toBe(false);
    expect(ignored('site/data/land-outline.json')).toBe(false);
  });

  it('still ignores lead data and secrets', () => {
    expect(ignored('data/leads.csv')).toBe(true);
    expect(ignored('import.sql')).toBe(true);
    expect(ignored('.dev.vars')).toBe(true);
  });
});
