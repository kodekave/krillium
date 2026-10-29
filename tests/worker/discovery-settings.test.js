import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS, SettingsError, daySpend, getSettings, putSettings, validateSettings } from '../../worker/src/discovery/settings.js';
import { addEvent, resetData } from './helpers.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');

beforeEach(resetData);

describe('settings', () => {
  it('defaults apply when nothing is stored', async () => {
    expect(await getSettings(env.DB, 1)).toEqual(DEFAULT_SETTINGS);
  });

  it('a patch merges with the defaults and persists', async () => {
    const saved = await putSettings(env.DB, 1, { runCapUsd: 1.5, paused: true });
    expect(saved.runCapUsd).toBe(1.5);
    expect(saved.paused).toBe(true);
    expect(saved.dayCapUsd).toBe(DEFAULT_SETTINGS.dayCapUsd);
    expect(saved.sectors).toEqual(DEFAULT_SETTINGS.sectors);
    expect(await getSettings(env.DB, 1)).toEqual(saved);
  });

  it('a second patch keeps what the first one stored', async () => {
    await putSettings(env.DB, 1, { maxSearches: 5 });
    const saved = await putSettings(env.DB, 1, { maxPages: 50 });
    expect(saved.maxSearches).toBe(5);
    expect(saved.maxPages).toBe(50);
  });

  it('starts with the five starter sectors, all on', async () => {
    const { sectors } = await getSettings(env.DB, 1);
    expect(sectors.map((s) => s.id)).toEqual(['procurement', 'finance-ops', 'pharma', 'manufacturing', 'banking']);
    expect(sectors.every((s) => s.enabled)).toBe(true);
  });

  it('trims sector names and topics before storing them, and stores nothing else about a sector', async () => {
    const saved = await putSettings(env.DB, 1, { sectors: [{ id: 'p', name: ' Pharma ', topics: ['  ERP ', 'supply chain'], enabled: false, extra: 1 }] });
    expect(saved.sectors).toEqual([{ id: 'p', name: 'Pharma', topics: ['ERP', 'supply chain'], enabled: false }]);
    expect(await getSettings(env.DB, 1)).toEqual(saved);
  });

  it('returns sectors that can be changed without touching the defaults', async () => {
    const { sectors } = await getSettings(env.DB, 1);
    sectors[0].topics.push('changed');
    sectors[0].name = 'Changed';
    expect((await getSettings(env.DB, 1)).sectors[0]).toEqual(DEFAULT_SETTINGS.sectors[0]);
  });

  it('ignores the retired topics row and a stored sectors value that is not valid', async () => {
    await env.DB.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (1, 'topics', '[\"erp\"]'), (1, 'sectors', '[{\"id\":\"A b\"}]')").run();
    const settings = await getSettings(env.DB, 1);
    expect(settings).not.toHaveProperty('topics');
    expect(settings.sectors).toEqual(DEFAULT_SETTINGS.sectors);
  });

  it('rejects bad values and stores nothing', async () => {
    const bad = [
      { runCapUsd: -1 }, { runCapUsd: '1' }, { dayCapUsd: Number.NaN }, { priceInPerMtok: -0.1 }, { priceOutPerMtok: Number.NaN }, { maxSearches: 0 },
      { maxSearches: 1.5 }, { maxSearches: 41 }, { maxPages: 1001 }, { sectors: [] },
      { sectors: 'erp' }, { sectors: [{ id: 'A b', name: 'x', topics: ['t'], enabled: true }] }, { sectors: [{ id: 'p', name: 'x', topics: [' '], enabled: true }] },
      { topics: ['erp'] }, { paused: 'yes' },
      { bogus: 1 }, null, [], 'x',
    ];
    for (const patch of bad) {
      expect(validateSettings(patch).ok, JSON.stringify(patch)).toBe(false);
      await expect(putSettings(env.DB, 1, patch)).rejects.toThrow(SettingsError);
    }
    expect(await getSettings(env.DB, 1)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the Claude prices, which only count when an Anthropic key is set', async () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ priceInPerMtok: 1, priceOutPerMtok: 5 });
    const saved = await putSettings(env.DB, 1, { priceInPerMtok: 2 });
    expect(saved.priceInPerMtok).toBe(2);
    expect(saved.priceOutPerMtok).toBe(5);
  });

  it('accepts an empty patch', async () => {
    expect(validateSettings({}).ok).toBe(true);
  });

  it('ignores a stored value that cannot be read', async () => {
    await env.DB.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (1, 'runCapUsd', '{not json')").run();
    expect((await getSettings(env.DB, 1)).runCapUsd).toBe(DEFAULT_SETTINGS.runCapUsd);
  });
});

describe('daySpend', () => {
  const run = (started, spend) =>
    env.DB.prepare("INSERT INTO search_runs (workspace_id, query_json, created_by, started, model_spend, status) VALUES (1, '{}', 'member@example.test', ?, ?, 'done')").bind(started, spend).run();

  it("sums only today's runs, whatever timestamp format they were stored in", async () => {
    await run('2026-10-29T08:00:00.000Z', 0.1);
    await run('2026-10-29 09:00:00', 0.2);
    await run('2026-10-28T23:59:59.000Z', 5);
    expect(await daySpend(env.DB, 1, NOW)).toBeCloseTo(0.3, 6);
  });

  it('is 0 when nothing ran today', async () => {
    expect(await daySpend(env.DB, 1, NOW)).toBe(0);
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

  it('adds sectors to events and candidates, empty until something is tagged', async () => {
    const event = await addEvent();
    expect((await env.DB.prepare('SELECT sectors FROM events WHERE id = ?').bind(event.id).first()).sectors).toBe('[]');
    await env.DB.prepare("INSERT INTO candidates (workspace_id, cluster_key, name) VALUES (1, 'k|2027-03-08', 'K')").run();
    expect((await env.DB.prepare('SELECT sectors FROM candidates').first()).sectors).toBe('[]');
  });

  it('rejects a second candidate with the same cluster key and a second source with the same url', async () => {
    const insert = () => env.DB.prepare("INSERT INTO candidates (workspace_id, cluster_key, name) VALUES (1, 'k|2027-03-08', 'K')").run();
    await insert();
    await expect(insert()).rejects.toThrow();
    const id = (await env.DB.prepare('SELECT id FROM candidates').first()).id;
    const source = () => env.DB.prepare("INSERT INTO candidate_sources (workspace_id, candidate_id, domain, url, adapter) VALUES (1, ?, 'a.com', 'https://a.com/x', 'exa')").bind(id).run();
    await source();
    await expect(source()).rejects.toThrow();
  });
});
