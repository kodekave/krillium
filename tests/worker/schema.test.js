import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../../site/js/shared/scoring.js';
import { getActiveConfig, saveConfig } from '../../worker/src/db.js';

const TABLES = [
  'events', 'companies', 'people', 'event_people', 'event_companies', 'signals', 'icp_config',
  'decisions', 'users', 'prefs', 'runs', 'changes', 'calendar_tokens',
];

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM icp_config').run();
  await env.DB.prepare('DELETE FROM people').run();
});

describe('schema', () => {
  it('creates all 13 tables from the spec', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
    ).all();
    const names = results.map((r) => r.name);
    for (const table of TABLES) expect(names).toContain(table);
  });

  it('rejects two people with the same email', async () => {
    const insert = () =>
      env.DB.prepare('INSERT INTO people (name, email) VALUES (?, ?)').bind('A Person', 'same@example.test').run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('rejects two companies with the same domain', async () => {
    const insert = () =>
      env.DB.prepare('INSERT INTO companies (name, domain) VALUES (?, ?)').bind('Acme', 'acme-unique.test').run();
    await insert();
    await expect(insert()).rejects.toThrow();
  });
});

describe('config store', () => {
  it('seeds version 1 from the default config when the table is empty', async () => {
    const cfg = await getActiveConfig(env.DB);
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, version: 1 });
  });

  it('does not duplicate version 1 on a second read', async () => {
    await getActiveConfig(env.DB);
    await getActiveConfig(env.DB);
    const { results } = await env.DB.prepare('SELECT version FROM icp_config').all();
    expect(results).toHaveLength(1);
  });

  it('saves a new version and returns it as active', async () => {
    const base = await getActiveConfig(env.DB);
    const edited = structuredClone(base);
    edited.thresholds.mustAttend = 75;
    const version = await saveConfig(env.DB, edited, 'kk@example.test');
    expect(version).toBe(2);
    const active = await getActiveConfig(env.DB);
    expect(active.version).toBe(2);
    expect(active.thresholds.mustAttend).toBe(75);
  });
});
