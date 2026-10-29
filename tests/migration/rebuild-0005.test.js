import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_TABLES, all, run, seedLegacy, startDb } from './harness.js';

// Migration 0005 rebuilds the 15 tenant tables with composite keys and composite foreign keys. These tests apply it to a
// database that already holds rows in two workspaces, which is the case the worker test pool cannot show.
const UNTOUCHED = ['users', 'prefs', 'page_cache', 'memory', 'workspaces'];
let h;
const before = {};

const dump = async (table) => (await all(h.db, `SELECT * FROM ${table}`)).map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort()))).sort();
const fails = (sql, ...values) => expect(run(h.db, sql, ...values)).rejects.toThrow();
const works = (sql, ...values) => expect(run(h.db, sql, ...values)).resolves.toBeTruthy();

// Workspace 2's rows. Until 0005 several keys are global, so none of them repeats a workspace 1 key.
async function seedWorkspaceTwo(db) {
  await run(db, "INSERT INTO workspaces (id, name, status) VALUES (2, 'Bravo team', 'active')");
  await run(db, "INSERT INTO users (email, name, role, workspace_id) VALUES ('b@example.test', 'B', 'admin', 2)");
  await run(db, "INSERT INTO events (workspace_id, id, name, city, country, start_date) VALUES (2, 'e2', 'Event Two', 'Paris', 'FR', '2027-06-01')");
  await run(db, "INSERT INTO companies (workspace_id, name, name_key, domain) VALUES (2, 'Beta', 'beta', 'beta.test')");
  await run(db, "INSERT INTO people (workspace_id, name, email, company_id) VALUES (2, 'Bob', 'bob@beta.test', 2)");
  await run(db, "INSERT INTO event_people (workspace_id, event_id, person_id, role) VALUES (2, 'e2', 2, 'speaker')");
  await run(db, 'INSERT INTO event_companies (workspace_id, event_id, company_id) VALUES (2, ?, 2)', 'e2');
  await run(db, "INSERT INTO event_sources (workspace_id, event_id, url, domain) VALUES (2, 'e2', 'https://b.test/e2', 'b.test')");
  await run(db, "INSERT INTO icp_config (workspace_id, version, json, created_by) VALUES (2, 50, '{\"version\":50}', 'test')");
  await run(db, "INSERT INTO decisions (workspace_id, event_id, user, choice) VALUES (2, 'e2', 'b@example.test', 'attend')");
  await run(db, "INSERT INTO changes (workspace_id, event_id, kind) VALUES (2, 'e2', 'new_event')");
  await run(db, "INSERT INTO search_runs (workspace_id, query_json, created_by) VALUES (2, '{}', 'b@example.test')");
  await run(db, "INSERT INTO run_items (workspace_id, run_id, outcome) VALUES (2, 2, 'inbox')");
  await run(db, "INSERT INTO candidates (workspace_id, cluster_key, name) VALUES (2, 'k2', 'Other Candidate')");
  await run(db, "INSERT INTO candidate_sources (workspace_id, candidate_id, domain, url, adapter) VALUES (2, 5, 'b.test', 'https://b.test/c', 'exa')");
  await run(db, "INSERT INTO rejections (workspace_id, name_key, start_date, rejected_by) VALUES (2, 'other-event', '2027-06-01', 'b@example.test')");
  await run(db, "INSERT INTO settings (workspace_id, key, value) VALUES (2, 'other', '1')");
  await run(db, "INSERT INTO prefs (user, key, value) VALUES ('kk@example.test', 'theme', 'dark')");
  await run(db, "INSERT INTO page_cache (url_hash, url, text_hash, extracted_json) VALUES ('h1', 'https://x.test/p', 't1', '{}')");
}

beforeAll(async () => {
  h = await startDb();
  for (const n of [1, 2, 3]) await h.applyMigration(n);
  await seedLegacy(h.db);
  await h.applyMigration(4);
  await seedWorkspaceTwo(h.db);
  for (const table of [...TENANT_TABLES, ...UNTOUCHED]) before[table] = await dump(table);
  await h.applyMigration(5);
}, 60000);

afterAll(() => h?.close());

describe('migration 0005 (strict rebuild)', () => {
  it('keeps every row of the 15 rebuilt tables, with its ids', async () => {
    for (const table of TENANT_TABLES) {
      expect(before[table].length, `${table} was seeded`).toBeGreaterThan(0);
      expect(await dump(table), table).toEqual(before[table]);
    }
  });

  it('leaves users, prefs, page_cache, memory and workspaces untouched', async () => {
    for (const table of UNTOUCHED) expect(await dump(table), table).toEqual(before[table]);
  });

  it('leaves foreign_key_check empty', async () => {
    expect(await all(h.db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('makes workspace_id NOT NULL with no default on all 15 tables', async () => {
    for (const table of TENANT_TABLES) {
      const column = (await all(h.db, `PRAGMA table_info(${table})`)).find((c) => c.name === 'workspace_id');
      expect(column, `${table} has workspace_id`).toBeTruthy();
      expect(column.notnull, `${table} NOT NULL`).toBe(1);
      expect(column.dflt_value, `${table} has no default`).toBeNull();
    }
  });

  it("refuses a child row that points into another workspace's parent", async () => {
    await fails("INSERT INTO event_people (workspace_id, event_id, person_id) VALUES (2, 'e1', 2)");
    await fails("INSERT INTO event_people (workspace_id, event_id, person_id) VALUES (2, 'e2', 1)");
    await fails("INSERT INTO event_companies (workspace_id, event_id, company_id) VALUES (2, 'e2', 1)");
    await fails("INSERT INTO event_sources (workspace_id, event_id, url, domain) VALUES (2, 'e1', 'https://x.test/n', 'x.test')");
    await fails("INSERT INTO decisions (workspace_id, event_id, user, choice) VALUES (2, 'e1', 'b@example.test', 'skip')");
    await fails("INSERT INTO changes (workspace_id, event_id, kind) VALUES (2, 'e1', 'lineup')");
    await fails("INSERT INTO people (workspace_id, name, company_id) VALUES (2, 'Cross Company', 1)");
    await fails("INSERT INTO candidate_sources (workspace_id, candidate_id, domain, url, adapter) VALUES (2, 1, 'x.test', 'https://x.test/cs', 'exa')");
    await fails("INSERT INTO run_items (workspace_id, run_id, outcome) VALUES (2, 1, 'inbox')");
    await works("INSERT INTO changes (workspace_id, event_id, kind) VALUES (2, 'e2', 'lineup')");
    await works("INSERT INTO changes (workspace_id, event_id, kind) VALUES (2, NULL, 'removed')");
  });

  it('allows the same key in two workspaces and refuses a duplicate inside one', async () => {
    await works("INSERT INTO events (workspace_id, id, name) VALUES (2, 'e1', 'Same id, other workspace')");
    await fails("INSERT INTO events (workspace_id, id, name) VALUES (1, 'e1', 'Duplicate')");

    await works("INSERT INTO companies (workspace_id, name, domain) VALUES (2, 'Acme again', 'acme.test')");
    await fails("INSERT INTO companies (workspace_id, name, domain) VALUES (1, 'Acme twice', 'acme.test')");

    await works("INSERT INTO people (workspace_id, name, email) VALUES (2, 'Pat again', 'pat@acme.test')");
    await fails("INSERT INTO people (workspace_id, name, email) VALUES (1, 'Pat twice', 'pat@acme.test')");

    await works("INSERT INTO candidates (workspace_id, cluster_key, name) VALUES (2, 'k-inbox', 'Same key')");
    await fails("INSERT INTO candidates (workspace_id, cluster_key, name) VALUES (1, 'k-inbox', 'Duplicate key')");

    await works("INSERT INTO settings (workspace_id, key, value) VALUES (2, 'paused', 'true')");
    await fails("INSERT INTO settings (workspace_id, key, value) VALUES (1, 'paused', 'true')");

    await works("INSERT INTO icp_config (workspace_id, version, json) VALUES (2, 1, '{}')");
    await fails("INSERT INTO icp_config (workspace_id, version, json) VALUES (1, 1, '{}')");

    await works("INSERT INTO rejections (workspace_id, name_key, start_date, rejected_by) VALUES (2, 'rejected-event', '2027-05-01', 'b@example.test')");
    await fails("INSERT INTO rejections (workspace_id, name_key, start_date, rejected_by) VALUES (1, 'rejected-event', '2027-05-01', 'kk@example.test')");
  });

  it('refuses a row whose workspace does not exist', async () => {
    await fails("INSERT INTO events (workspace_id, id, name) VALUES (99, 'ghost', 'Nobody owns this')");
  });

  it('keeps the one-running-search-per-person rule and the other indexes', async () => {
    await works("INSERT INTO search_runs (workspace_id, query_json, created_by, status) VALUES (1, '{}', 'solo@example.test', 'running')");
    await fails("INSERT INTO search_runs (workspace_id, query_json, created_by, status) VALUES (1, '{}', 'solo@example.test', 'running')");
    const names = (table) => all(h.db, `PRAGMA index_list(${table})`).then((rows) => rows.map((r) => r.name));
    expect(await names('search_runs')).toEqual(expect.arrayContaining(['idx_one_running_search_per_user', 'idx_search_runs_user']));
    expect(await names('companies')).toContain('idx_companies_name_key');
    expect(await names('candidates')).toContain('idx_candidates_status');
    expect(await names('run_items')).toContain('idx_run_items_run');
  });

  it('keeps numbering new rows after the largest existing id', async () => {
    const max = (await all(h.db, 'SELECT MAX(id) AS m FROM companies'))[0].m;
    await run(h.db, "INSERT INTO companies (workspace_id, name, domain) VALUES (1, 'Numbering', 'numbering.test')");
    const added = (await all(h.db, "SELECT id FROM companies WHERE domain = 'numbering.test'"))[0].id;
    expect(added).toBeGreaterThan(max);
  });
});
