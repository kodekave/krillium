import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_TABLES, all, seedLegacy, startDb } from './harness.js';

let h;

beforeAll(async () => {
  h = await startDb();
  for (const n of [1, 2, 3]) await h.applyMigration(n);
  await seedLegacy(h.db);
  await h.applyMigration(4);
}, 60000);

afterAll(() => h?.close());

describe('migration 0004 (additive)', () => {
  it('creates workspace 1 as active with shared keys on', async () => {
    const [w] = await all(h.db, 'SELECT id, name, status, shared_keys, approved_at FROM workspaces');
    expect(w).toMatchObject({ id: 1, name: 'Main workspace', status: 'active', shared_keys: 1 });
    expect(w.approved_at).toBeTruthy();
  });

  it('moves every existing user into workspace 1 with the operator flag off', async () => {
    const users = await all(h.db, 'SELECT email, workspace_id, operator FROM users');
    expect(users).toEqual([{ email: 'kk@example.test', workspace_id: 1, operator: 0 }]);
  });

  it('adds workspace_id, defaulting to 1, to each of the 15 tenant tables and fills existing rows with 1', async () => {
    for (const table of TENANT_TABLES) {
      const column = (await all(h.db, `PRAGMA table_info(${table})`)).find((c) => c.name === 'workspace_id');
      expect(column, `${table} has workspace_id`).toBeTruthy();
      expect(column.notnull, `${table} is NOT NULL`).toBe(1);
      expect(column.dflt_value, `${table} defaults to 1`).toBe('1');
      const rows = await all(h.db, `SELECT DISTINCT workspace_id FROM ${table}`);
      expect(rows, `${table} has rows, all in workspace 1`).toEqual([{ workspace_id: 1 }]);
    }
  });

  it('creates the unique indexes the scoped upserts target', async () => {
    const wanted = {
      events: ['workspace_id', 'id'],
      companies: ['workspace_id', 'domain'],
      people: [['workspace_id', 'email'], ['workspace_id', 'linkedin_url']],
      icp_config: ['workspace_id', 'version'],
      settings: ['workspace_id', 'key'],
      rejections: ['workspace_id', 'name_key', 'start_date'],
      candidates: ['workspace_id', 'cluster_key'],
      event_people: ['workspace_id', 'event_id', 'person_id'],
      event_companies: ['workspace_id', 'event_id', 'company_id'],
      event_sources: ['workspace_id', 'event_id', 'url'],
    };
    for (const [table, spec] of Object.entries(wanted)) {
      const specs = Array.isArray(spec[0]) ? spec : [spec];
      const indexes = await all(h.db, `PRAGMA index_list(${table})`);
      const found = [];
      for (const index of indexes.filter((i) => i.unique)) {
        found.push((await all(h.db, `PRAGMA index_info(${index.name})`)).sort((a, b) => a.seqno - b.seqno).map((c) => c.name));
      }
      for (const columns of specs) expect(found, `${table} (${columns.join(', ')})`).toContainEqual(columns);
    }
  });

  it('adds the memory table', async () => {
    const columns = (await all(h.db, 'PRAGMA table_info(memory)')).map((c) => c.name);
    expect(columns).toEqual(['id', 'workspace_id', 'at', 'actor', 'kind', 'subject', 'detail']);
  });

  it('backfills memory from decisions, human candidate outcomes and saved ICP versions', async () => {
    const rows = (await all(h.db, 'SELECT workspace_id, actor, kind, subject, detail FROM memory ORDER BY kind, subject'))
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
    expect(rows.map((r) => r.kind)).toEqual(['candidate.approved', 'candidate.rejected', 'event.decision', 'icp.saved']);
    expect(rows.every((r) => r.workspace_id === 1 && r.detail.backfilled === true)).toBe(true);

    const decision = rows.find((r) => r.kind === 'event.decision');
    expect(decision).toMatchObject({ actor: 'kk@example.test', subject: 'e1' });
    expect(decision.detail).toEqual({
      choice: 'skip', reason: 'Too small', name: 'Event One', organiser: 'Org', city: 'Berlin', country: 'DE',
      sectors: ['procurement'], priority: 61.5, icpVersion: 1, backfilled: true,
    });

    const rejected = rows.find((r) => r.kind === 'candidate.rejected');
    expect(rejected.actor).toBe('unknown');
    expect(rejected.detail).toMatchObject({
      name: 'Rejected Event', organiser: 'ORG', city: 'Paris', country: 'FR', startDate: '2027-05-01', sectors: ['pharma'],
      sites: ['a.test', 'b.test'], siteCount: 2, inboxReason: null,
    });

    const icp = rows.find((r) => r.kind === 'icp.saved');
    expect(icp).toMatchObject({ actor: 'kk@example.test', subject: '2' });
    expect(icp.detail).toMatchObject({ version: 2, changed: [] });
  });
});
