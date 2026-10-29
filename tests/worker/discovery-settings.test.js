import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, SettingsError, daySpend, getSettings, putSettings, validateSettings } from '../../worker/src/discovery/settings.js';
import { addEvent, resetData } from './helpers.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');

beforeEach(resetData);

describe('settings', () => {
  it('defaults apply when nothing is stored', async () => {
    expect(await getSettings(env.DB)).toEqual(DEFAULT_SETTINGS);
  });

  it('a patch merges with the defaults and persists', async () => {
    const saved = await putSettings(env.DB, { runCapUsd: 1.5, paused: true });
    expect(saved.runCapUsd).toBe(1.5);
    expect(saved.paused).toBe(true);
    expect(saved.dayCapUsd).toBe(DEFAULT_SETTINGS.dayCapUsd);
    expect(saved.topics).toEqual([...DEFAULT_SETTINGS.topics]);
    expect(await getSettings(env.DB)).toEqual(saved);
  });

  it('a second patch keeps what the first one stored', async () => {
    await putSettings(env.DB, { maxSearches: 5 });
    const saved = await putSettings(env.DB, { maxPages: 50 });
    expect(saved.maxSearches).toBe(5);
    expect(saved.maxPages).toBe(50);
  });

  it('trims topics before storing them', async () => {
    const saved = await putSettings(env.DB, { topics: ['  ERP ', 'supply chain'] });
    expect(saved.topics).toEqual(['ERP', 'supply chain']);
  });

  it('rejects bad values and stores nothing', async () => {
    const bad = [
      { runCapUsd: -1 }, { runCapUsd: '1' }, { dayCapUsd: Number.NaN }, { priceInPerMtok: -0.1 }, { maxSearches: 0 },
      { maxSearches: 1.5 }, { maxSearches: 41 }, { maxPages: 1001 }, { topics: new Array(9).fill('erp') },
      { topics: ['a'.repeat(61)] }, { topics: [1] }, { topics: [' '] }, { topics: 'erp' }, { paused: 'yes' },
      { bogus: 1 }, null, [], 'x',
    ];
    for (const patch of bad) {
      expect(validateSettings(patch).ok, JSON.stringify(patch)).toBe(false);
      await expect(putSettings(env.DB, patch)).rejects.toThrow(SettingsError);
    }
    expect(await getSettings(env.DB)).toEqual(DEFAULT_SETTINGS);
  });

  it('accepts an empty patch', async () => {
    expect(validateSettings({}).ok).toBe(true);
  });

  it('ignores a stored value that cannot be read', async () => {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('runCapUsd', '{not json')").run();
    expect((await getSettings(env.DB)).runCapUsd).toBe(DEFAULT_SETTINGS.runCapUsd);
  });
});

describe('daySpend', () => {
  const run = (started, spend) =>
    env.DB.prepare("INSERT INTO search_runs (query_json, created_by, started, model_spend) VALUES ('{}', 'member@example.test', ?, ?)").bind(started, spend).run();

  it("sums only today's runs, whatever timestamp format they were stored in", async () => {
    await run('2026-10-29T08:00:00.000Z', 0.1);
    await run('2026-10-29 09:00:00', 0.2);
    await run('2026-10-28T23:59:59.000Z', 5);
    expect(await daySpend(env.DB, NOW)).toBeCloseTo(0.3, 6);
  });

  it('is 0 when nothing ran today', async () => {
    expect(await daySpend(env.DB, NOW)).toBe(0);
  });
});

describe('discovery schema', () => {
  it('creates the discovery tables', async () => {
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const names = results.map((r) => r.name);
    for (const table of ['search_runs', 'candidates', 'candidate_sources', 'rejections', 'page_cache', 'event_sources', 'settings', 'run_items']) {
      expect(names, table).toContain(table);
    }
  });

  it('adds origin and auto_added with defaults to events', async () => {
    const event = await addEvent();
    const row = await env.DB.prepare('SELECT origin, auto_added FROM events WHERE id = ?').bind(event.id).first();
    expect(row).toEqual({ origin: 'import', auto_added: 0 });
  });

  it('rejects a second candidate with the same cluster key and a second source with the same url', async () => {
    const insert = () => env.DB.prepare("INSERT INTO candidates (cluster_key, name) VALUES ('k|2027-03-08', 'K')").run();
    await insert();
    await expect(insert()).rejects.toThrow();
    const id = (await env.DB.prepare('SELECT id FROM candidates').first()).id;
    const source = () => env.DB.prepare("INSERT INTO candidate_sources (candidate_id, domain, url, adapter) VALUES (?, 'a.com', 'https://a.com/x', 'exa')").bind(id).run();
    await source();
    await expect(source()).rejects.toThrow();
  });
});
