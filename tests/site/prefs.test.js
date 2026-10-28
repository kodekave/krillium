import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPrefs } from '../../site/js/prefs.js';

const makeApi = (data = {}) => ({
  get: vi.fn(async () => ({ ok: true, data })),
  put: vi.fn(async () => ({ ok: true, data: {} })),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPrefs', () => {
  it('loads the saved preferences and exposes them by key', async () => {
    const prefs = createPrefs(makeApi({ theme: 'light', filters: '{"region":"europe"}' }));
    await prefs.load();
    expect(prefs.get('theme')).toBe('light');
    expect(prefs.getJson('filters')).toEqual({ region: 'europe' });
    expect(prefs.get('missing')).toBeNull();
  });

  it('survives a failed load and returns defaults', async () => {
    const api = { get: vi.fn(async () => ({ ok: false, stale: true })), put: vi.fn() };
    const prefs = createPrefs(api);
    await prefs.load();
    expect(prefs.get('theme')).toBeNull();
    expect(prefs.getJson('filters')).toBeNull();
  });

  it('ignores a stored value that is not valid JSON', async () => {
    const prefs = createPrefs(makeApi({ filters: '{not json' }));
    await prefs.load();
    expect(prefs.getJson('filters')).toBeNull();
  });

  it('saves only the last of several quick changes to a key', async () => {
    const api = makeApi();
    const prefs = createPrefs(api, { delay: 400 });
    prefs.set('filters', 'one');
    prefs.set('filters', 'two');
    expect(api.put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(api.put).toHaveBeenCalledOnce();
    expect(api.put).toHaveBeenCalledWith('/api/prefs', { key: 'filters', value: 'two' });
    expect(prefs.get('filters')).toBe('two');
  });

  it('does not write a value over 4 KB', async () => {
    const api = makeApi();
    const prefs = createPrefs(api, { delay: 10 });
    prefs.set('filters', 'x'.repeat(4097));
    await vi.advanceTimersByTimeAsync(10);
    expect(api.put).not.toHaveBeenCalled();
  });
});
