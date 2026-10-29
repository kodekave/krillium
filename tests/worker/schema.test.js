import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../../site/js/shared/scoring.js';
import { getActiveConfig, saveConfig } from '../../worker/src/db.js';
import { getSettings, putSettings } from '../../worker/src/discovery/settings.js';
import { addWorkspace, resetData } from './helpers.js';

const TABLES = [
  'events', 'companies', 'people', 'event_people', 'event_companies', 'signals', 'icp_config',
  'decisions', 'users', 'prefs', 'runs', 'changes', 'calendar_tokens', 'workspaces', 'memory',
];

beforeEach(resetData);

describe('schema', () => {
  it('creates all 13 tables from the spec', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'",
    ).all();
    const names = results.map((r) => r.name);
    for (const table of TABLES) expect(names).toContain(table);
  });

  it('has workspace 1 active with shared keys after migration', async () => {
    const w = await env.DB.prepare('SELECT name, status, shared_keys FROM workspaces WHERE id = 1').first();
    expect(w).toEqual({ name: 'Main workspace', status: 'active', shared_keys: 1 });
  });

  it('rejects two people with the same email in one workspace but allows it across workspaces', async () => {
    const other = await addWorkspace();
    const insert = (workspaceId) =>
      env.DB.prepare('INSERT INTO people (workspace_id, name, email) VALUES (?, ?, ?)').bind(workspaceId, 'A Person', 'same@example.test').run();
    await insert(1);
    await expect(insert(1)).rejects.toThrow();
    await expect(insert(other)).resolves.toBeTruthy();
  });

  it('rejects two companies with the same domain in one workspace but allows it across workspaces', async () => {
    const other = await addWorkspace();
    const insert = (workspaceId) =>
      env.DB.prepare('INSERT INTO companies (workspace_id, name, domain) VALUES (?, ?, ?)').bind(workspaceId, 'Acme', 'acme-unique.test').run();
    await insert(1);
    await expect(insert(1)).rejects.toThrow();
    await expect(insert(other)).resolves.toBeTruthy();
  });

  it('lets two workspaces hold the same event id, and refuses a duplicate inside one', async () => {
    const other = await addWorkspace();
    const insert = (workspaceId) => env.DB.prepare('INSERT INTO events (workspace_id, id, name) VALUES (?, ?, ?)').bind(workspaceId, 'shared-id', 'Event').run();
    await insert(1);
    await expect(insert(1)).rejects.toThrow();
    await expect(insert(other)).resolves.toBeTruthy();
  });

  it('refuses a row that points at another workspace\'s event', async () => {
    const other = await addWorkspace();
    await env.DB.prepare("INSERT INTO events (workspace_id, id, name) VALUES (1, 'only-here', 'Event')").run();
    await expect(
      env.DB.prepare("INSERT INTO decisions (workspace_id, event_id, user, choice) VALUES (?, 'only-here', 'x@example.test', 'attend')").bind(other).run(),
    ).rejects.toThrow();
  });
});

describe('config store', () => {
  it('seeds version 1 from the default config when the table is empty', async () => {
    const cfg = await getActiveConfig(env.DB, 1);
    expect(cfg).toEqual({ ...DEFAULT_CONFIG, version: 1 });
  });

  it('does not duplicate version 1 on a second read', async () => {
    await getActiveConfig(env.DB, 1);
    await getActiveConfig(env.DB, 1);
    const { results } = await env.DB.prepare('SELECT version FROM icp_config').all();
    expect(results).toHaveLength(1);
  });

  it('saves a new version and returns it as active', async () => {
    const base = await getActiveConfig(env.DB, 1);
    const edited = structuredClone(base);
    edited.thresholds.mustAttend = 75;
    const version = await saveConfig(env.DB, 1, edited, 'kk@example.test');
    expect(version).toBe(2);
    const active = await getActiveConfig(env.DB, 1);
    expect(active.version).toBe(2);
    expect(active.thresholds.mustAttend).toBe(75);
  });

  it('gives a new workspace its own default ICP at version 1, without touching workspace 1', async () => {
    const other = await addWorkspace();
    const edited = structuredClone(await getActiveConfig(env.DB, 1));
    edited.thresholds.mustAttend = 75;
    await saveConfig(env.DB, 1, edited, 'kk@example.test');

    const fresh = await getActiveConfig(env.DB, other);
    expect(fresh).toEqual({ ...DEFAULT_CONFIG, version: 1 });
    expect((await getActiveConfig(env.DB, 1)).version).toBe(2);
    const rows = await env.DB.prepare('SELECT workspace_id, version FROM icp_config ORDER BY workspace_id, version').all();
    expect(rows.results).toEqual([{ workspace_id: 1, version: 1 }, { workspace_id: 1, version: 2 }, { workspace_id: other, version: 1 }]);
  });
});

describe('settings', () => {
  it('lets two workspaces store the same setting without affecting each other', async () => {
    const other = await addWorkspace();
    await putSettings(env.DB, 1, { dayCapUsd: 7 });
    await putSettings(env.DB, other, { dayCapUsd: 3 });
    await putSettings(env.DB, 1, { dayCapUsd: 8 });
    expect((await getSettings(env.DB, 1)).dayCapUsd).toBe(8);
    expect((await getSettings(env.DB, other)).dayCapUsd).toBe(3);
  });
});
