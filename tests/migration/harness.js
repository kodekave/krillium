// Data-bearing migration tests: a throwaway Miniflare D1 database that migrations can be applied to one at a time,
// with rows seeded in between. The worker test pool applies every migration to an empty database up front, so it
// cannot show what a migration does to data that already exists.
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export async function startDb() {
  // Miniflare 5 takes a new options shape; the plugin converts the familiar one with this helper, and so do we.
  const mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: 'migration-test',
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      compatibilityDate: '2024-04-01',
      d1Databases: { DB: 'migration-test' },
    }],
  }));
  const db = await mf.getD1Database('DB');
  const migrations = await readD1Migrations('worker/migrations');
  return {
    db,
    // D1 exec treats each line as a statement, so a migration is run as the statement list the plugin parsed from it,
    // as one batch: D1 applies a migration atomically, so a failing statement leaves nothing half-applied.
    async applyMigration(n) {
      const prefix = String(n).padStart(4, '0');
      const migration = migrations.find((m) => m.name.startsWith(prefix));
      if (!migration) throw new Error(`no migration numbered ${prefix}`);
      await db.batch(migration.queries.map((query) => db.prepare(query)));
    },
    close: () => mf.dispose(),
  };
}

export const run = (db, sql, ...values) => db.prepare(sql).bind(...values).run();
export const all = async (db, sql, ...values) => (await db.prepare(sql).bind(...values).all()).results;

// One row in every table that 0004 and 0005 touch, written against the schema as it is after migration 0003.
export async function seedLegacy(db) {
  await run(db, "INSERT INTO users (email, name, role, active) VALUES ('kk@example.test', 'KK', 'admin', 1)");
  await run(
    db,
    `INSERT INTO events (id, name, organiser, url, city, country, start_date, end_date, fit, public_names, timing, distance, sectors)
     VALUES ('e1', 'Event One', 'Org', 'https://x.test/e1', 'Berlin', 'DE', '2027-03-08', '2027-03-11', 4, 4, 4, 4, '["procurement"]')`,
  );
  await run(db, "INSERT INTO companies (name, name_key, domain) VALUES ('Acme', 'acme', 'acme.test')");
  await run(db, "INSERT INTO people (name, email, company_id, title) VALUES ('Pat Person', 'pat@acme.test', 1, 'CFO')");
  await run(db, "INSERT INTO event_people (event_id, person_id, role, fit, contact) VALUES ('e1', 1, 'speaker', 30, 'verified_email')");
  await run(db, "INSERT INTO event_companies (event_id, company_id) VALUES ('e1', 1)");
  await run(db, "INSERT INTO event_sources (event_id, url, domain, adapter) VALUES ('e1', 'https://x.test/e1', 'x.test', 'exa')");
  await run(db, "INSERT INTO icp_config (version, json, created_by) VALUES (1, '{\"version\":1}', 'system')");
  await run(db, "INSERT INTO icp_config (version, json, created_by) VALUES (2, '{\"version\":2}', 'kk@example.test')");
  await run(
    db,
    "INSERT INTO decisions (event_id, user, choice, reason, score_snapshot, config_version) VALUES ('e1', 'kk@example.test', 'skip', 'Too small', 61.5, 1)",
  );
  await run(db, "INSERT INTO changes (event_id, kind, summary) VALUES ('e1', 'imported', 'Imported from the Sheet')");
  await run(db, "INSERT INTO search_runs (query_json, status, created_by, model_spend) VALUES ('{}', 'done', 'kk@example.test', 0.1)");
  await run(db, "INSERT INTO run_items (run_id, outcome, name, url) VALUES (1, 'inbox', 'Inbox Event', 'https://x.test/inbox')");
  const candidate = (key, name, status, over = {}) =>
    run(
      db,
      `INSERT INTO candidates (cluster_key, name, organiser, city, country, start_date, status, event_id, sectors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      key, name, over.organiser ?? 'ORG', over.city ?? 'Paris', over.country ?? 'FR', '2027-05-01', status, over.eventId ?? null, over.sectors ?? '["pharma"]',
    );
  await candidate('k-inbox', 'Inbox Event', 'inbox');
  await candidate('k-rej', 'Rejected Event', 'rejected');
  await candidate('k-app', 'Approved Event', 'approved', { eventId: 'e1' });
  await candidate('k-auto', 'Auto Event', 'auto_added', { eventId: 'e1' });
  await run(db, "INSERT INTO candidate_sources (candidate_id, domain, url, adapter) VALUES (2, 'a.test', 'https://a.test/1', 'exa')");
  await run(db, "INSERT INTO candidate_sources (candidate_id, domain, url, adapter) VALUES (2, 'b.test', 'https://b.test/1', 'exa')");
  await run(db, "INSERT INTO rejections (name_key, start_date, rejected_by) VALUES ('rejected-event', '2027-05-01', 'kk@example.test')");
  await run(db, "INSERT INTO settings (key, value) VALUES ('paused', 'false')");
}

// The 15 tables that gain workspace_id.
export const TENANT_TABLES = [
  'events', 'companies', 'people', 'event_people', 'event_companies', 'event_sources', 'icp_config', 'decisions',
  'changes', 'search_runs', 'run_items', 'candidates', 'candidate_sources', 'rejections', 'settings',
];
