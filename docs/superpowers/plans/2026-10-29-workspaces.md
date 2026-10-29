# Private Workspaces and Memory Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every sign-in a private, operator-approved workspace, scope all data and discovery spend to it, and record each workspace's decisions in an append-only memory log from day one.

**Architecture:** One D1 database; `workspace_id` on 15 existing tables plus a new `memory` table; composite keys and foreign keys make the database itself refuse cross-workspace rows. The schema change ships as two migrations (additive `0004`, strict rebuild `0005`) so the test suite stays green while code is converted module by module; `0005` then makes any missed statement fail loudly.

**Tech Stack:** Cloudflare Worker (plain JS ES modules), D1/SQLite, Vitest (`shared` node project, `worker` workerd project), Miniflare for data-bearing migration tests, static ES-module site.

**Spec:** `docs/superpowers/specs/2026-10-29-workspaces-design.md` (approved 2026-10-29). Section numbers below refer to it.

## Global Constraints

- **Commands.** Worker tests: `npx vitest run --project worker <file>`. Shared, site and migration tests: `npx vitest run --project shared <file>`. Whole suite: `npm test`. Baseline before Task 1: 533 tests, all passing. The whole suite is green at the end of every task.
- **Argument order.** In every worker data function `workspaceId` is the argument right after `db`, and the function's first line is `wsId(workspaceId)` (Task 2).
- **Workspace source.** `user.workspaceId` from `requireUser`, never the request body, URL or token.
- **Statement rule.** Every SQL statement on a tenant table names `workspace_id`; each joined or sub-queried tenant table gets its own predicate. Tenant tables (16): `events, companies, people, event_people, event_companies, event_sources, icp_config, decisions, changes, search_runs, run_items, candidates, candidate_sources, rejections, settings, memory`. Not tenant: `users, workspaces, prefs, page_cache, signals, runs, calendar_tokens`.
- **Limits.** 50 D1 queries per request (scoping adds predicates, not queries). Memory adds at most one statement per request. `memory.detail` is at most 2048 bytes of valid JSON.
- **Values.** Workspace status is `pending`, `active` or `suspended`; at most 50 pending workspaces; decision choices are `attend`, `watch`, `skip`; memory kinds are `event.decision, candidate.approved, candidate.rejected, autoadd.undone, search.finished, icp.saved, sectors.saved, samples.loaded`.
- **Memory detail shapes** (shared by the backfill in Task 1 and the capture in Task 8; backfilled rows add `"backfilled": true`). Flat keys, no lead names, emails or profile links anywhere:
  - `event.decision`: `{ choice, reason, name, organiser, city, country, sectors, priority, icpVersion }`
  - `candidate.approved`, `candidate.rejected`: `{ name, organiser, city, country, startDate, sectors, sites, siteCount, inboxReason }`
  - `autoadd.undone`: same keys as above, without `inboxReason`
  - `search.finished`: `{ status, sectors, searches, spendUsd, pages, counts: { auto_added, inbox, tracked, filtered }, filteredBy: { <reason>: n }, productive: [domains], wasted: [domains], autoAdded: [names] }`
  - `icp.saved`: `{ version, changed: [config keys] }`; `sectors.saved`: `{ added: [ids], removed: [ids], edited: [ids], changed: [setting keys] }`; `samples.loaded`: `{ count }`
- **Interim rule.** Until Task 10, two workspaces in a test must use different event ids, company domains, person emails and cluster keys (global keys still exist). Task 10 lifts this.
- **Process (the user's standing instructions).** No commits unless the user asks: a checkpoint is a line in the ledger `.superpowers/sdd/2026-10-29-workspaces/progress.md`. No push. Nothing remote (migrations, deploy, exporting live data, secrets) without the user's go-ahead. Never handle secret values. No attribution lines in any commit or PR text. Leave `.serena/` alone. No subagents unless the user asks.

## Review Focus

1. A URL id that belongs to another workspace (`/api/events/:id`, `/api/search/:id`, inbox approve and reject, undo-auto-add) answers `404` and changes nothing. Pinned in Task 11.
2. A suspended or still-pending workspace's existing token is refused on the next request, not at expiry. Pinned in Task 2.
3. The `0005` rebuild keeps every row, leaves `foreign_key_check` empty, and refuses a child row that points into another workspace. Pinned in Task 10.
4. A failed memory write never fails the action; memory never contains a lead's name or email; a search step with ten new events stays within 50 queries. Pinned in Task 8.
5. One workspace's spend, caps, rejections, settings and ICP version never change another's (today's `daySpend` and `getActiveConfig` are global). Pinned in Tasks 4, 6 and 7.

## Plan rulings

- **R1. Two migrations instead of one.** Spec section 4 describes one `0004`. It is delivered as `0004` (additive: new tables, `workspace_id NOT NULL DEFAULT 1` columns, the unique indexes the new upserts target, memory backfill) and `0005` (rebuild: composite keys and foreign keys, no default). They are applied together live. Cost if wrong: none for users; the spec is amended in Task 14.
- **R2. Auto-added candidates are not backfilled** into memory: they are not human decisions, and future auto-adds appear inside `search.finished`.
- **R3. Workspace 1 is named "Main workspace"** (renameable later); the operator flag is set by SQL, never hardcoded in a migration.
- **R4. `requireUser` answers `401` for any non-active workspace.** The page then shows sign-in, where signing in again returns the precise `202` or `403` message.
- **R6. The waiting message lives in the sign-in overlay, and the workspace name goes on the sign-out button.** Spec section 8 describes a "Check again" button and an "account menu"; the app has neither. Signing in again is the check (a separate button would need a fresh Google credential anyway), and the rail's sign-out button gets the workspace name in its title and label. The spec is amended in Task 14.
- **R5. The final review is a self-review** against the spec and `superpowers:requesting-code-review`'s checklist, because the user does not use subagents unless asked.

## File map

| Area | Files |
|---|---|
| Migrations | Create `worker/migrations/0004_workspaces.sql`, `0005_workspaces_strict.sql` |
| Worker | Create `scope.js`, `memory.js`, `samples.js`, `routes/workspaces.js`; modify `auth.js`, `index.js`, `db.js`, `routes/{read,write,ask,discovery}.js`, `discovery/{store,run,settings,deps}.js` |
| Scripts | Modify `scripts/{import-lib.js,import-sheet.mjs,dev-seed.mjs,dev-token.mjs}` |
| Site | Create `js/workspace-state.js`, `js/first-run.js`, `js/views/workspaces.js`, `js/shared/memory.js`; modify `js/{auth,main}.js`, `js/views/{radar,events,find,icp}.js`, `index.html`, `css/components.css` |
| Tests | Create `tests/migration/*`, `tests/worker/{scope,workspace-signin,workspaces-operator,samples,read-scope,write-scope,store-scope,run-scope,memory,isolation,workspace-scan}.test.js`, `tests/shared/memory.test.js`, `tests/site/{workspace-state,first-run}.test.js`; modify `vitest.config.js`, `tests/worker/helpers.js` and the existing tests whose calls change |

---

### Task 1: Additive migration 0004 and the migration test harness

**Files:**
- Create: `worker/migrations/0004_workspaces.sql`, `tests/migration/harness.js`, `tests/migration/additive-0004.test.js`
- Modify: `vitest.config.js` (add `tests/migration/**/*.test.js` to the `shared` project's `include`), `tests/worker/schema.test.js`

**Interfaces:**
- Produces: tables `workspaces`, `memory`; columns `users.workspace_id`, `users.operator`, `workspace_id INTEGER NOT NULL DEFAULT 1` on the 15 tables of spec section 4; workspace row 1; harness `startDb(): Promise<{ db: D1Database, applyMigration(n: number): Promise<void>, close(): Promise<void> }>`.

- [ ] **Step 1: Write the harness.** `startDb` starts a `Miniflare` instance with one D1 binding and returns `getD1Database`. `applyMigration(n)` reads migrations with `readD1Migrations('worker/migrations')` (from `@cloudflare/vitest-plugin`; D1 `exec` treats each line as a statement, so use the plugin's parsed `queries`) and runs the queries of the file numbered `n` one by one. Check the Miniflare API against the installed 5.x types (`getD1Database` is declared); if it misbehaves, the fallback is `wrangler d1 execute --local --persist-to <tmp>` driven from the harness.
- [ ] **Step 2: Write the failing test** `additive-0004.test.js`. Apply 1 to 3, seed an event, a decision on it (choice `skip`, reason `Too small`), candidates with statuses `inbox`, `rejected`, `approved` and `auto_added`, an `icp_config` version 1 (`created_by` `system`) and version 2 (`created_by` `kk@example.test`), and a user. Apply 4. Tests:
  - `it('creates workspace 1 as active with shared keys on')`
  - `it('moves every existing user into workspace 1 with the operator flag off')`
  - `it('adds workspace_id, defaulting to 1, to each of the 15 tenant tables and fills existing rows with 1')`
  - `it('creates the unique indexes the scoped upserts target')`: `PRAGMA index_list` shows a unique index on each of `events(workspace_id,id)`, `companies(workspace_id,domain)`, `people(workspace_id,email)`, `people(workspace_id,linkedin_url)`, `icp_config(workspace_id,version)`, `settings(workspace_id,key)`, `rejections(workspace_id,name_key,start_date)`, `candidates(workspace_id,cluster_key)`, `event_people(workspace_id,event_id,person_id)`, `event_companies(workspace_id,event_id,company_id)`, `event_sources(workspace_id,event_id,url)`.
  - `it('backfills memory from decisions, human candidate outcomes and saved ICP versions')`: one `event.decision` with the Global shape and `backfilled: true`; one `candidate.rejected` and one `candidate.approved` (actor `unknown`); one `icp.saved` for version 2 only; nothing for the `auto_added` candidate or ICP version 1 (R2).
- [ ] **Step 3: Run it.** `npx vitest run --project shared tests/migration`. Expected: FAIL (no `0004` file).
- [ ] **Step 4: Write `0004_workspaces.sql`.** Statements, one concern each: create `workspaces` (spec section 4) and insert workspace 1 (`'Main workspace'`, `active`, `shared_keys 1`, `approved_at` now); add `users.workspace_id INTEGER REFERENCES workspaces (id)` and `users.operator INTEGER NOT NULL DEFAULT 0`, then `UPDATE users SET workspace_id = 1`; `ALTER TABLE ... ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1` on each of the 15 tables (no `REFERENCES`: SQLite forbids a non-NULL default with it); the eleven unique indexes above; `memory` (spec section 15) with `idx_memory_ws_kind_at (workspace_id, kind, at)`; three `INSERT ... SELECT` backfills using `json_object` and the Global detail shapes (`event.decision` joins `events`; candidates with status `rejected` or `approved` give `candidate.*` with actor `unknown`, `at = last_seen`, `sites` from `candidate_sources`; `icp_config` rows with `version > 1` give `icp.saved`, actor `created_by`, `changed` empty).
- [ ] **Step 5: Run the migration test.** Expected: PASS.
- [ ] **Step 6: Extend `schema.test.js`.** Add `workspaces` and `memory` to `TABLES`; add `it('has workspace 1 active with shared keys after migration')` against `env.DB`.
- [ ] **Step 7: Run the whole suite.** `npm test`. Expected: all pass (533 plus the new tests).
- [ ] **Step 8: Checkpoint.** Ledger line `Task 1: complete` with the command and result.

---

### Task 2: Workspace context and sign-in

**Files:**
- Create: `worker/src/scope.js`, `tests/worker/scope.test.js`, `tests/worker/workspace-signin.test.js`
- Modify: `worker/src/auth.js`, `worker/src/index.js`, `tests/worker/helpers.js`, `tests/worker/auth.test.js`

**Interfaces:**
- Consumes: Task 1 tables.
- Produces: `wsId(value: unknown): number` (returns the value when it is a positive integer, else throws `TypeError('workspaceId must be a positive integer')`); `requireUser(request, env): Promise<User>` with `User = { email, name, role, operator: boolean, workspaceId: number, workspaceName: string, sharedKeys: boolean }`; `export const ROUTES` in `index.js` (Task 11 reads it); helpers `addWorkspace({ name = 'Test workspace', status = 'active', shared_keys = 0 } = {}): Promise<number>`, `addUser({ ..., workspaceId = 1, operator = 0 })`, and a `workspaceId = 1` option on `addEvent, addCompany, addPerson, attend, attachCompany, addChange` that is written explicitly into the insert. `resetData()` also deletes `memory` first and `workspaces` with `id != 1` last, and restores workspace 1 to `active`, `shared_keys 1`.

- [ ] **Step 1: Write failing tests.** `scope.test.js`: `wsId` accepts `1` and `7`; rejects `0`, `-1`, `1.5`, `'1'`, `null`, `undefined`, `NaN`. `workspace-signin.test.js` (uses the existing `makeKeyPair`/`makeIdToken` helpers and `createHandler({ getJwks })`):
  - `it('signs in an active user of an active workspace with token, workspace and operator flag')` (body `data` has `token`, `user`, `workspace: { id, name }`, `operator`)
  - `it('answers 202 pending with no token when the workspace is pending')`
  - `it('answers 403 when the workspace is suspended')`, `it('answers 403 for an inactive user')`
  - `it('creates a pending workspace named after the person and an admin user for an unknown verified email, and answers 202')`
  - `it('creates nothing new when the same unknown email signs in again')`
  - `it('answers 503 and creates nothing when 50 workspaces are already pending')`
  - `it('refuses an existing token on the next request once its workspace is suspended')` (401)
  - `it('refuses a token whose workspace is pending')`, `it('refuses a user with no workspace')` (401)
- [ ] **Step 2: Run them.** `npx vitest run --project worker tests/worker/scope.test.js tests/worker/workspace-signin.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement `scope.js`.**
- [ ] **Step 4: Implement `requireUser`.** One query joining `users` to `workspaces` on `workspace_id`; `401` unless the user is active, has a workspace, and the workspace status is `active` (R4); returns the `User` shape.
- [ ] **Step 5: Implement the sign-in flow in `authGoogle`** per the spec section 5 table. A new person is created with one `db.batch`: insert the workspace (`pending`, named `"<Google name>'s workspace"`, cut to 60 characters), then the `admin` user with `workspace_id = last_insert_rowid()`. Count pending first (`MAX_PENDING_WORKSPACES = 50`). If the batch fails on the existing email (two first sign-ins at once), re-read the user and answer from that row. Responses: `200` via `json({ token, user, workspace, operator })`, `202` via `json({ status: 'pending' }, 202)`, `403` and `503` via `error(...)`.
- [ ] **Step 6: Pass `user` to handlers unchanged in shape** (`route()` already does) and export `ROUTES` from `index.js`.
- [ ] **Step 7: Update `helpers.js` and `auth.test.js`** for the new `addUser` options and the richer sign-in body; existing behaviour assertions stay.
- [ ] **Step 8: Run the whole suite.** `npm test`. Expected: all pass.
- [ ] **Step 9: Checkpoint.**

---

### Task 3: Operator routes and sample events

**Files:**
- Create: `worker/src/samples.js`, `worker/src/routes/workspaces.js`, `tests/worker/workspaces-operator.test.js`, `tests/worker/samples.test.js`
- Modify: `worker/src/index.js` (register routes), `scripts/dev-seed.mjs` (read the ten events from `samples.js`)

**Interfaces:**
- Consumes: `User` from Task 2.
- Produces: `SAMPLE_EVENTS` (the ten events now inline in `dev-seed.mjs`, as objects `{ id, name, organiser, url, city, country, startDate, endDate, sourceUrl, fit, publicNames, timing, distance }`); `loadSamples(db, workspaceId): Promise<{ added: number }>` (idempotent `INSERT OR IGNORE`, every event gets `sectors '["procurement"]'`, `origin 'import'`); routes `GET /api/operator/workspaces`, `POST /api/operator/workspaces/:id/approve`, `POST /api/operator/workspaces/:id/suspend`, `PUT /api/operator/workspaces/:id/shared-keys` (body `{ on: boolean }`), `POST /api/workspace/samples`.

- [ ] **Step 1: Capture the seed output before touching it.** `node scripts/dev-seed.mjs > <scratchpad>/seed-before.sql`.
- [ ] **Step 2: Write failing tests.** `workspaces-operator.test.js`:
  - `it('lists workspaces with owner email, status, shared keys and whether they hold data, pending first')`
  - `it('refuses every operator route to a non-operator with 403')`
  - `it('approves a pending workspace: status active and approved_at set; 404 for an unknown id')`
  - `it('suspends an active or pending workspace')`, `it('refuses to suspend the operator\'s own workspace with 409')`
  - `it('switches shared keys on and off, and rejects a non-boolean with 400')`

  `samples.test.js`: `it('loads the ten samples into the caller\'s workspace and answers how many were added')`, `it('adds nothing the second time')`, `it('refuses a member who is not an admin with 403')`, `it('tags the samples with the procurement sector')`.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement** `samples.js`, then `routes/workspaces.js` (a local `requireOperator(user)` throws `error(403, ...)`; the list is one query with sub-selects for owner (first `admin` by `rowid`) and `hasData`), then register the routes in `ROUTES`.
- [ ] **Step 5: Refactor `dev-seed.mjs`** to build its events CSV rows from `SAMPLE_EVENTS` in the same column order. Run it again to `seed-after.sql` and `diff` the two: they must be identical.
- [ ] **Step 6: Run the whole suite.** Expected: all pass.
- [ ] **Step 7: Checkpoint.**

---

### Task 4: Scope `db.js` and the read routes

**Files:**
- Modify: `worker/src/db.js`, `worker/src/routes/read.js`, `worker/src/routes/ask.js`, `worker/src/routes/write.js` (only the calls into `db.js`), the existing tests that call these functions
- Create: `tests/worker/read-scope.test.js`

**Interfaces — new signatures:** `getActiveConfig(db, workspaceId)`, `saveConfig(db, workspaceId, cfg, user)`, `getRankedEvents(db, workspaceId, now = Date.now())`, `getEventDetail(db, workspaceId, id, user = null, now = Date.now())`, `getFeed(db, workspaceId, limit = 50)`, `getGraph(db, workspaceId)`. `parseSectors`, `parseTime`, `freshnessFor` are unchanged.

- [ ] **Step 1: Write the failing test** `read-scope.test.js`: workspace 1 has event `a1` with a company and person; workspace 2 has `b1` with different ones. Tests: `it('radar, feed, graph and ask show only the caller\'s workspace')`; `it('event detail for another workspace\'s id is 404')`; `it('ICP versions are per workspace: saving in one leaves the other at version 1')`; `it('a workspace with no ICP row gets the default configuration without touching the other')`.
- [ ] **Step 2: Run it.** Expected: FAIL (leaks).
- [ ] **Step 3: Convert `db.js`.** Add the parameter and `wsId()` first line to each function; add `workspace_id = ?` to every statement, including each table inside `RADAR_SQL`, `LEADS_SQL` and the correlated sub-selects (`event_companies`, `companies`, `event_people`, `people`, `changes` each carry their own predicate). `getActiveConfig` inserts its default with `INSERT OR IGNORE INTO icp_config (workspace_id, version, json, created_by)`.
- [ ] **Step 4: Pass `user.workspaceId`** in `read.js`, `ask.js` and the `getRankedEvents`/`saveConfig` calls in `write.js`.
- [ ] **Step 5: Update existing tests** that call the changed functions directly (`schema.test.js`, `read.test.js`, `write.test.js`) to pass workspace `1`.
- [ ] **Step 6: Run the whole suite.** Expected: all pass.
- [ ] **Step 7: Checkpoint.**

---

### Task 5: Scope the write routes

**Files:**
- Modify: `worker/src/routes/write.js`, `tests/worker/write.test.js`
- Create: `tests/worker/write-scope.test.js`

**Interfaces:** `postDecision` inserts `decisions (workspace_id, event_id, user, ...)`; `putIcp` calls `saveConfig(env.DB, user.workspaceId, ...)`. `prefs` stay per user.

- [ ] **Step 1: Write failing tests:** `it('a decision on another workspace\'s event is 404 and writes nothing')`; `it('a decision is stamped with the caller\'s workspace')`; `it('an ICP save in one workspace does not change the other\'s active config')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole suite.** Expected: all pass.
- [ ] **Step 5: Checkpoint.**

---

### Task 6: Scope the candidate store

**Files:**
- Modify: `worker/src/discovery/store.js`, the existing `discovery-store` and `discovery-routes` tests
- Create: `tests/worker/store-scope.test.js`

**Interfaces — new signatures:** `loadContext(db, workspaceId)`, `saveGroup(db, workspaceId, group, now)`, `reevaluate(db, workspaceId, candidateId, now)`, `processGroups(db, workspaceId, groups, now)`, `addSourcesToEvent(db, workspaceId, eventId, observations, now)`, `approveCandidate(db, workspaceId, id, user, now)`, `rejectCandidate(db, workspaceId, id, user, now)`, `undoAutoAdd(db, workspaceId, eventId, user, now)`, `listInbox(db, workspaceId, now)`. The private helpers (`loadCandidate`, `loadSources`, `loadRows`, `claim`, `release`, `freeEventId`, `promote`, `refreshFields`, `rejectionRow`) take it too. Rejection upsert target becomes `ON CONFLICT (workspace_id, name_key, start_date)`.

- [ ] **Step 1: Write failing tests** in `store-scope.test.js`: `it('the same event found in two workspaces makes two candidates')` (`cluster_key` is global until Task 10, so give the second workspace a different start date); `it('a rejection in one workspace does not hide the event in another')`; `it('approving, rejecting or undoing with another workspace\'s id is 404 or 409 and changes nothing')`; `it('the inbox lists only the caller\'s candidates')`; `it('new event ids are chosen free within the workspace only')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Convert `store.js`:** add the parameter and `wsId()`, scope every statement (including `candidate_sources`, `event_sources`, `changes`, `decisions`, `event_people`, `event_companies` counts in `undoAutoAdd`), and write `workspace_id` in every insert (candidates, candidate_sources, events, event_sources, changes, rejections).
- [ ] **Step 4: Pass `user.workspaceId`** from the inbox, approve, reject and undo routes in `routes/discovery.js` (the other routes follow in Task 7).
- [ ] **Step 5: Update existing store tests** to pass workspace `1`. The statement-count budget tests stay as they are.
- [ ] **Step 6: Run the whole suite.** Expected: all pass.
- [ ] **Step 7: Checkpoint.**

---

### Task 7: Scope runs, settings and the discovery routes; gate shared keys

**Files:**
- Modify: `worker/src/discovery/run.js`, `settings.js`, `deps.js`, `worker/src/routes/discovery.js`, `worker/src/index.js`, the existing run, settings, routes and deps tests
- Create: `tests/worker/run-scope.test.js`

**Interfaces — new signatures:** `getRun(db, workspaceId, runId)`, `startRun(db, workspaceId, user, query, settings, now)`, `cancelRun(db, workspaceId, runId, user, role, now)`, `stepRun({ db, workspaceId, runId, deps, settings, now })`, `getSettings(db, workspaceId)`, `putSettings(db, workspaceId, patch)`, `daySpend(db, workspaceId, now)`, `defaultDeps(env, { sharedKeys })` (the Exa reader and the optional Claude reader exist only when `sharedKeys` is true and the secret is set; the Confs.tech feed is always on). `GET /api/discovery/settings` adds `sharedKeys: boolean`. `index.js` passes `discovery ?? defaultDeps(env, user)`. `page_cache` stays global. Settings upsert target becomes `ON CONFLICT (workspace_id, key)`.

- [ ] **Step 1: Write failing tests** in `run-scope.test.js`: `it('daySpend counts only the workspace\'s own runs')`; `it('a run in workspace 1 is not capped by $5 spent today in workspace 2')`; `it('get, step and cancel with another workspace\'s run id are 404')`; `it('settings written in one workspace do not change the other\'s')`; `it('one running search per person still holds')`; `it('defaultDeps without shared keys has no search or model reader but keeps the feed')`; `it('defaultDeps with shared keys and an EXA_API_KEY has a search reader')`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Convert `run.js` and `settings.js`:** scope every statement (`search_runs`, `run_items`, the abandoned-run update, `daySpend`), write `workspace_id` in the `search_runs` and `run_items` inserts, and thread `workspaceId` through `record`, `gather` and the store calls.
- [ ] **Step 4: Convert `routes/discovery.js`** to pass `user.workspaceId` everywhere and add `sharedKeys` to the settings response; update `deps.js` and `index.js`.
- [ ] **Step 5: Update existing tests** (run, settings, routes, deps) to the new signatures. The 50-query step test stays.
- [ ] **Step 6: Run the whole suite.** Expected: all pass.
- [ ] **Step 7: Checkpoint.**

---

### Task 8: Memory capture

**Files:**
- Create: `worker/src/memory.js`, `site/js/shared/memory.js`, `tests/worker/memory.test.js`, `tests/shared/memory.test.js`
- Modify: `worker/src/routes/write.js`, `worker/src/routes/discovery.js`, `worker/src/routes/workspaces.js`, `worker/src/discovery/run.js`, `worker/src/discovery/store.js` (return facts), `worker/src/index.js`

**Interfaces:**
- Produces: `remember(db, workspaceId, entries: Array<{ actor: string, kind: string, subject?: string | number | null, detail?: object }>): Promise<boolean>` (one multi-row `INSERT`; catches, logs and returns `false` on failure; never throws); `fitDetail(detail: object): object` (guarantees valid JSON of at most 2048 bytes: long arrays are cut and keep a `<key>More` count, long strings are cut to 200 characters); `listMemory(db, workspaceId, { limit = 20 }): Promise<{ total: number, items: Array<{ id, at, actor, kind, subject, detail }> }>` (newest first); `summariseRun({ run, items, query }): object` (the `search.finished` detail; `wasted` is the registrable domains, via `registrableDomain`, of filtered items that appear in no productive item); `GET /api/memory?limit=` (any member). Shared module: `MEMORY_KINDS` and `describeMemory(entry): string` (a plain sentence per kind; unknown kind gives `Recorded <kind>`). Store functions return facts: `approveCandidate` gives `{ eventId, facts }`, `rejectCandidate` and `undoAutoAdd` return `facts` (the Global candidate shape). The routes keep their response bodies (`{ eventId }` and `{}`); the facts go only to memory.
- Capture points: `postDecision` (`event.decision`, subject event id), `approveInbox`/`rejectInbox` (subject candidate id), `undoAutoAddRoute` (subject event id), `putIcp` (only the config keys whose value changed), `putDiscoverySettings` (sectors added, removed or edited by id; changed keys), `loadSamplesRoute` (only when `added > 0`), and run completion in `run.js` (`stepRun` when the run leaves `running` through `stop()`, the final batch or the failure path, and `cancelRun`): one `search.finished` per run, written once.

- [ ] **Step 1: Write failing tests.** `memory.test.js`:
  - `it('writes many entries in one statement')` (use `countingDb`: count is 1)
  - `it('returns false and does not throw when the write fails')`
  - `it('keeps detail under 2048 bytes and valid JSON for huge lists')`
  - `it('scopes entries and the list to the workspace')`
  - `it('records event.decision, candidate.approved, candidate.rejected, autoadd.undone, icp.saved, sectors.saved and samples.loaded through their routes with the Global shapes')`
  - `it('icp.saved lists only the keys that changed')`
  - `it('search.finished is written once when a run ends, with sectors, counts, spend, productive and wasted sources, and not while it is running')`
  - `it('a failed memory write does not fail the action')` (call a route with `env` whose `DB.prepare` throws for `INSERT INTO memory`)
  - `it('never puts a lead\'s name or email in any entry')` (decide on an event that has an attached person; the stored `detail` text contains neither)
  - `it('a search step that finds ten events writes no memory before the run ends and stays within 50 queries')`
  - `it('GET /api/memory returns the total and the newest entries of the caller\'s workspace only')`

  `tests/shared/memory.test.js`: `describeMemory` returns a non-empty sentence for each kind in `MEMORY_KINDS` (for example `Skipped Sibos: Too small` for an `event.decision`), and `Recorded <kind>` for an unknown one.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `memory.js`, then the shared `memory.js`, then the store facts, then each capture point, then `GET /api/memory` in `ROUTES`.
- [ ] **Step 4: Run the whole suite.** Expected: all pass.
- [ ] **Step 5: Checkpoint.**

---

### Task 9: Scripts take a workspace

**Files:**
- Modify: `scripts/import-lib.js`, `scripts/import-sheet.mjs`, `scripts/dev-seed.mjs`, `scripts/dev-token.mjs`, `tests/worker/import.test.js`

**Interfaces:** `buildImport(csvs, { today, workspaceId = 1 })`: every generated insert names `workspace_id`; every sub-select adds `workspace_id = <id>`; upsert targets become `ON CONFLICT (workspace_id, id)` (events), `(workspace_id, domain)` (companies), `(workspace_id, email)` and `(workspace_id, linkedin_url)` (people), `(workspace_id, event_id, person_id)` (event_people). `import-sheet.mjs --workspace <n>` (positive integer, default 1; otherwise print usage and exit 1). `dev-seed.mjs` also inserts workspace 2 (`'Second workspace'`, `active`) with admin `other@example.test` and no events, and the dev user with `workspace_id 1, operator 1`. `dev-token.mjs --workspace <n> --operator` prints `{ token, user, workspace: { id, name }, operator }`.

- [ ] **Step 1: Write failing tests** in `import.test.js`: `it('writes every row into the requested workspace and leaves workspace 1 untouched')` (use workspace 3 and distinct ids, per the interim rule); `it('is idempotent per workspace')`; existing tests keep passing with the default.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the four scripts.
- [ ] **Step 4: Run the whole suite.** Expected: all pass.
- [ ] **Step 5: Checkpoint.**

---

### Task 10: Strict migration 0005

**Files:**
- Create: `worker/migrations/0005_workspaces_strict.sql`, `tests/migration/rebuild-0005.test.js`
- Modify: `tests/worker/schema.test.js`, plus any straggler the full run exposes

**Interfaces:** rebuilds the 15 tables of spec section 4: every existing column and index kept; `workspace_id INTEGER NOT NULL REFERENCES workspaces (id)` with no default; keys per the section 4 table; child foreign keys composite: `event_people`, `event_companies`, `event_sources`, `decisions`, `changes` use `(workspace_id, event_id) REFERENCES events (workspace_id, id)`; `event_people (workspace_id, person_id)` references `people (workspace_id, id)`; `event_companies (workspace_id, company_id)` references `companies (workspace_id, id)`; `people (workspace_id, company_id)` references `companies (workspace_id, id)`; `candidate_sources (workspace_id, candidate_id)` references `candidates (workspace_id, id)`; `run_items (workspace_id, run_id)` references `search_runs (workspace_id, id)`. `companies`, `people`, `candidates` and `search_runs` gain `UNIQUE (workspace_id, id)`. `changes.event_id` and `people.company_id` stay nullable (a NULL column disables the composite check). `signals`' foreign key to `companies (id)` stays valid because `id` remains the primary key. The first statement is `PRAGMA defer_foreign_keys = on`; tables are rebuilt parents first (create `_new`, copy, drop, rename, recreate indexes). The partial unique index `idx_one_running_search_per_user` and the other existing indexes are recreated with `workspace_id` first where they filter by it.

- [ ] **Step 1: Write the failing test** `rebuild-0005.test.js` (harness): apply 1 to 3, seed rows in every one of the 15 tables (two workspaces after applying 4, so apply 4 first, then add workspace 2 and its rows), apply 5, then:
  - `it('keeps every row: counts per table are equal before and after')`
  - `it('leaves foreign_key_check empty')`
  - `it('makes workspace_id NOT NULL with no default on all 15 tables')`
  - `it('refuses an event_people row in workspace 2 that points at workspace 1\'s event')` (and the same for companies, people, candidate_sources, run_items)
  - `it('allows the same event id, company domain, person email, cluster key, settings key and ICP version in two workspaces, and refuses duplicates inside one')`
  - `it('leaves users, prefs, page_cache and memory untouched')`
- [ ] **Step 2: Run it.** `npx vitest run --project shared tests/migration/rebuild-0005.test.js`. Expected: FAIL.
- [ ] **Step 3: Write `0005_workspaces_strict.sql`.** If `defer_foreign_keys` does not hold inside the migration (spec section 13), stop and report: the fallback is to rebuild with foreign keys off in a rehearsal script and re-import, not to weaken the keys.
- [ ] **Step 4: Run the migration test.** Expected: PASS.
- [ ] **Step 5: Run the worker suite.** `npx vitest run --project worker`. Expected: failures wherever a statement or test helper still omits `workspace_id` (the NOT NULL now bites). Fix each at its source: helpers, tests, and any production statement Tasks 4 to 9 missed. Production misses are a finding to ledger.
- [ ] **Step 6: Add worker-level tests** to `schema.test.js`: `it('rejects two people with the same email in one workspace but allows it across workspaces')` and the same for companies, replacing the two global-uniqueness tests.
- [ ] **Step 7: Run the whole suite.** Expected: all pass.
- [ ] **Step 8: Checkpoint.**

---

### Task 11: Isolation sweep and source scan

**Files:**
- Create: `tests/worker/isolation.test.js`, `tests/worker/workspace-scan.test.js`

**Interfaces:** consumes the exported `ROUTES` (Task 2).

- [ ] **Step 1: Write the sweep.** Build workspaces A and B with the same event id, company domain, person email and cluster key, plus a marker string that exists only in B's data (event name, company name, candidate name, memory detail). Tests:
  - `it('every GET route returns nothing of B when called as A, and nothing of A as B')`
  - `it('every route that takes an id answers 404 for the other workspace\'s id')` (events, search get/step/cancel, inbox approve/reject, undo-auto-add)
  - `it('mutating routes called with the other workspace\'s ids change no row in the other workspace')` (row counts before and after)
  - `it('the sweep covers every entry of ROUTES')`: the test's own table is compared with `ROUTES` by method and pattern source, so a new route without sweep coverage fails.
  - `it('loads the samples into two workspaces independently')`
- [ ] **Step 2: Write the scan.** `import.meta.glob('../../worker/src/**/*.js', { query: '?raw', eager: true })` plus `../../scripts/*.js`. A statement is a string or template literal containing `SELECT`, `INSERT`, `UPDATE` or `DELETE`. For each tenant table it names after `FROM`, `JOIN`, `INTO`, `UPDATE` or `DELETE FROM`, it must contain at least as many `workspace_id` as tenant-table references. Tests: `it('flags a statement that omits workspace_id')` and `it('accepts a joined statement that scopes each table')` run on inline fixtures; `it('finds no unscoped statement in worker/src and scripts')`.
- [ ] **Step 3: Run them.** Expected: the fixtures pass; real findings, if any, fail the scan. Fix every real finding at its source and ledger it; a finding the sweep also shows is a production bug.
- [ ] **Step 4: Run the whole suite.** Expected: all pass.
- [ ] **Step 5: Checkpoint.**

---

### Task 12: Site — sign-in states, waiting message, operator screen

**Files:**
- Create: `site/js/workspace-state.js`, `site/js/views/workspaces.js`, `tests/site/workspace-state.test.js`
- Modify: `site/js/auth.js`, `site/js/main.js`, `site/index.html`, `site/css/components.css`

**Interfaces:** `signInOutcome(result): { kind: 'signed-in' | 'pending' | 'inactive' | 'closed' | 'unreachable' | 'failed', message: string | null }` where `result` is what `api.post` returns (`202` arrives as `{ ok: true, status: 202, data: { status: 'pending' } }`; `403` as `inactive`; `503` as `closed`; `stale` as `unreachable`). `createSession` gains `getWorkspace()` and `isOperator()`; the stored session is the whole sign-in body. `main.js` adds a `workspaces` route and a rail item only when `session.isOperator()`, and re-renders the rail on sign-in.

- [ ] **Step 1: Write failing tests** for `signInOutcome` (one per kind, with the exact messages: pending `Your workspace is waiting for approval. Sign in again later to check.`; inactive `This workspace is not active. Ask the operator.`; closed `Sign-ups are closed for now.`), and for `createSession` returning the workspace and operator flag from stored data.
- [ ] **Step 2: Run them.** `npx vitest run --project shared tests/site/workspace-state.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `workspace-state.js` and the `createSession` additions; use `signInOutcome` in `mountGoogleButton`'s callback, and call `onSignedIn` only for kind `signed-in` (a `202` has `ok: true` and must not start a session). The pending message appears in the existing `#signin-error` paragraph with a neutral style, and the Google button stays so the person can sign in again to check).
- [ ] **Step 4: Build `views/workspaces.js`** (`mount(root, ctx)`): table of workspaces from `GET /api/operator/workspaces` with Approve, Suspend and a shared-keys switch (`ctx.api.post` and `ctx.api.put`), pending first, empty and error states in the style of `events.js`.
- [ ] **Step 5: Wire `main.js`** (route, rail item for operators, and the workspace name in the sign-out button's `title` and `aria-label`, R6) and add the small CSS.
- [ ] **Step 6: Run the whole suite.** Expected: all pass.
- [ ] **Step 7: Verify in the browser.** Start the local Worker and site (`.wrangler/dev2`, as in earlier sessions), run Task 9's seed, sign in with `node scripts/dev-token.mjs --operator` stored in `sessionStorage['gtm-radar.session']`: the Workspaces item appears, approving a pending workspace changes its row, and a token without `--operator` shows no such item. Take a screenshot.
- [ ] **Step 8: Checkpoint.**

---

### Task 13: Site — first run, Find notice, Memory card

**Files:**
- Create: `site/js/first-run.js`, `tests/site/first-run.test.js`
- Modify: `site/js/views/radar.js`, `site/js/views/events.js`, `site/js/views/find.js`, `site/js/find-state.js`, `site/js/views/icp.js`, `site/css/components.css`

**Interfaces:** `firstRunCard(ctx, { onLoaded }): HTMLElement` with three steps (set sectors: link to `#/icp`; load sample events: `POST /api/workspace/samples`, then calls `onLoaded`; find events: link to `#/find`). `keysNotice(settings): string | null` in `find-state.js`: `null` when nothing is missing; when `missing` is non-empty and `sharedKeys` is false, `Search needs an Exa key for this workspace. Per-workspace keys arrive in the next update; the operator can switch on the shared key meanwhile.`; otherwise the existing "Add EXA_API_KEY to the Worker" text. The ICP view gets a **Memory** card: total count and the latest 20 entries as `describeMemory(entry)` sentences with relative times, read-only.

- [ ] **Step 1: Write failing tests:** `keysNotice` for the three cases; the first-run card's step list and that the load step posts to `/api/workspace/samples` and calls `onLoaded` on success and shows the error text on failure (inject a fake `ctx.api`).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `first-run.js` and `keysNotice`; use the card in the Radar and Events empty states (replacing the "Import the case-study Sheet" text); use `keysNotice` in Find's not-set-up panel and keep Search and Fill the map disabled as now; add the Memory card to the ICP view.
- [ ] **Step 4: Run the whole suite.** Expected: all pass.
- [ ] **Step 5: Verify in the browser** against the local Worker: an empty workspace shows the first-run card; loading samples fills Radar and Events; Find shows the new notice for a workspace without shared keys; the Memory card lists the `samples.loaded` entry and a decision made through the drawer. Take screenshots.
- [ ] **Step 6: Checkpoint.**

---

### Task 14: Documentation, final verification and rollout notes

**Files:**
- Modify: `DEPLOY.md`, `docs/superpowers/specs/2026-10-29-workspaces-design.md` (sections 4 and 11: R1), the memory file `project_krillium_deployment.md`

- [ ] **Step 1: Update `DEPLOY.md`.** A Workspaces section: signing in creates a pending workspace; approve it under Workspaces; set the operator once with `UPDATE users SET operator = 1 WHERE email = '<you>'`; shared keys per workspace; step 5 now adds `workspace_id`; `import-sheet.mjs --workspace`; Google consent screen status (spec section 13); the rollout order below.
- [ ] **Step 2: Amend the spec** for R1 (two migrations) and R6 (waiting message and workspace name placement in section 8).
- [ ] **Step 3: Run the whole suite** and read the result: all tests pass, none skipped.
- [ ] **Step 4: Self-review the whole change** against the spec section by section and the Review Focus list (R5). Ledger every finding; fix any Critical or Important one with a failing test first.
- [ ] **Step 5: Write the rollout checklist into the ledger** (each item waits for the user's go-ahead; none is run by this plan):
  1. Export the live database to the git-ignored `.wrangler` folder, load it locally, apply `0004` and `0005`, compare row counts, run `PRAGMA foreign_key_check`.
  2. Note the Time Travel restore point.
  3. Apply `0004` and `0005` to the live database, then deploy the Worker at once (the old Worker cannot write after `0005`).
  4. The user sets the operator flag with the SQL above.
  5. Push the site.
  6. The user decides on publishing the Google consent screen.
- [ ] **Step 6: Update the memory file** with the state: built, uncommitted, not deployed, and the rollout order.
- [ ] **Step 7: Checkpoint.** Report the Rulings made and the deferred minors to the user.
