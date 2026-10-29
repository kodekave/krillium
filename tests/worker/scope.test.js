import { describe, expect, it } from 'vitest';
import { wsId } from '../../worker/src/scope.js';

describe('wsId', () => {
  it('returns a positive integer unchanged', () => {
    expect(wsId(1)).toBe(1);
    expect(wsId(7)).toBe(7);
  });

  it.each([0, -1, 1.5, '1', null, undefined, Number.NaN, {}, []])('rejects %s', (value) => {
    expect(() => wsId(value)).toThrow(TypeError);
    expect(() => wsId(value)).toThrow('workspaceId must be a positive integer');
  });
});
