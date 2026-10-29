# Private workspaces — design

Status: draft for review, 2026-10-29. Sub-project 1 of 7 in the GTM-agent roadmap (section 2). Builds on `2026-10-29-gtm-radar-design.md` (stage 1) and `2026-10-29-event-discovery-design.md`.

## 1. Goal

Today everyone who can sign in sees one shared dataset, and the search keys are single Worker secrets. This sub-project gives each person or company that signs in a private workspace: their own events, companies, people, ICP (ideal customer profile), sectors, search runs and budgets. Nobody can read or change another workspace's data. The operator (you) approves each new workspace before it can be used.

It is the foundation for per-workspace API keys (sub-project 2) and for putting real lead data in the app (sub-projects 4 and 5): those must not ship onto a shared dataset.

It also starts each workspace's **memory** on its first day (section 15). Everything a workspace decides is recorded as it happens, so the later features that make smarter decisions have a history to learn from. History that was never recorded cannot be recovered.

## 2. Roadmap

Each item gets its own spec, plan and build. Only the first is designed here; section 15 fixes what the third may rely on.

1. **Workspaces and memory capture** (this spec): isolation, sign-up with operator approval, and an append-only memory log that records from day one.
2. **Connections vault**: each workspace stores its own Exa, Anthropic and HubSpot keys, encrypted, with a Test button.
3. **Memory and judgment**: the workspace's history becomes explained, reversible decisions: learned preferences, ranking nudges, smarter search planning, suggested ICP and sector changes. Designed once real history exists.
4. **Lead cleaning**: dedupe, normalise, email-status rules, ICP scoring on lead data; self-serve import.
5. **HubSpot push**: preview, confirm, match by email and domain, never overwrite filled fields, log every push.
6. **Signals**: hiring, funding and news beyond events, scored against the ICP.
7. **Campaign builder**: drafts of copy and sequences from the ICP and signals. Drafts only; nothing is sent.

## 3. Decisions

Made with the user:

- Each sign-in gets a **private workspace**. Not a shared team dataset.
- New workspaces **wait for the operator's approval**. Opening sign-up is a later switch.
- **Memory is a core feature, built from the start.** The system records what a workspace does and decides, and later makes smarter decisions on top of that record.

Made while designing (any of these can be vetoed in review):

- **One database, scoped.** Every tenant table carries `workspace_id` and the database itself refuses a row that points into another workspace (composite foreign keys, section 4). A database per workspace is ruled out: Cloudflare's free plan cannot create bindings on the fly.
- **A workspace is created per sign-in, but may hold several users.** The creator is its admin. The current team stays together in workspace 1. There is no invite screen yet; until there is, the operator adds a teammate with SQL as `DEPLOY.md` step 5 does, now with a workspace id.
- **The operator is a flag on a user** (`users.operator`), separate from the workspace role (`admin` or `member`). Only the operator sees the Workspaces screen.
- **Worker-secret keys are used only by workspaces flagged `shared_keys`.** Workspace 1 has it on; new workspaces have it off. Without it, a new workspace cannot spend your Exa or Anthropic key. The operator can switch it on per workspace until sub-project 2 ships.
- **Pending sign-ups are capped at 50.** Beyond that, sign-up says it is closed and creates nothing.
- **No deletion in this sub-project.** Operators approve or suspend. Workspace deletion and data export are out of scope (section 13).
- **New workspaces start empty.** They get the default ICP and the five starter sectors automatically (as an empty table behaves today). A button loads the ten sample events.
- **All existing data moves into workspace 1**, owned by the current admin.
- **Memory is an append-only log of facts per workspace**, written at the existing decision points from day one. Reading it to decide things is sub-project 3.
- **Memory holds no personal data about leads** (no names, emails or profile links), only event, company, sector and rule-level facts.

## 4. Data model (migrations `0004_workspaces.sql` and `0005_workspaces_strict.sql`)

*Amendment, built 2026-10-29:* the change ships as two migrations applied together. `0004` is additive (the new tables, `workspace_id NOT NULL DEFAULT 1` columns, the unique indexes the scoped upserts name, and the memory backfill), so the code could be converted module by module while the whole suite stayed green. `0005` rebuilds the 15 tables as described below, with no default, so any statement that still omits `workspace_id` fails loudly. Everything below describes the end state after `0005`.

New table:

```
workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  shared_keys INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT
)
```

`users` gains `workspace_id INTEGER REFERENCES workspaces (id)` and `operator INTEGER NOT NULL DEFAULT 0`. SQLite cannot add a NOT NULL column without a default, so `workspace_id` is nullable in the schema; the code treats a user with no workspace as having no access, and a test pins that.

The new `memory` table (section 15) is created with `workspace_id` as well. Tables that gain `workspace_id INTEGER NOT NULL` (15): `events`, `companies`, `people`, `event_people`, `event_companies`, `event_sources`, `icp_config`, `decisions`, `changes`, `search_runs`, `run_items`, `candidates`, `candidate_sources`, `rejections`, `settings`.

Tables left alone:

- `users` (above) and `prefs` (keyed by user email; a user belongs to one workspace).
- `page_cache`: it holds the facts of public web pages, nothing about a workspace, and sharing it saves money.
- `signals`, `runs`, `calendar_tokens`: no code reads or writes them yet. They get `workspace_id` in the sub-project that first uses them.

**Rebuilds.** All 15 tables are rebuilt the SQLite way (create the new table, copy, drop, rename), because SQLite cannot add a NOT NULL column without a default or change a key or foreign key in place. The keys that change meaning:

| Table | Before | After |
|---|---|---|
| `events` | PK `(id)` | PK `(workspace_id, id)` |
| `companies` | `UNIQUE (domain)` | `UNIQUE (workspace_id, domain)`, `UNIQUE (workspace_id, id)` |
| `people` | `UNIQUE (email)`, `UNIQUE (linkedin_url)` | each with `workspace_id`; `UNIQUE (workspace_id, id)` |
| `icp_config` | PK `(version)` | PK `(workspace_id, version)` |
| `settings` | PK `(key)` | PK `(workspace_id, key)` |
| `rejections` | PK `(name_key, start_date)` | PK `(workspace_id, name_key, start_date)` |
| `candidates` | `UNIQUE (cluster_key)` | `UNIQUE (workspace_id, cluster_key)`, `UNIQUE (workspace_id, id)` |
| `search_runs` | PK `(id)` | adds `UNIQUE (workspace_id, id)` |

Child tables use composite foreign keys, for example `event_people (workspace_id, event_id) REFERENCES events (workspace_id, id)` and `(workspace_id, person_id) REFERENCES people (workspace_id, id)`. A child row in workspace A that points at workspace B's event is rejected by the database, so even a code mistake cannot link across workspaces. Autoincrement ids stay globally unique. Every existing index gets `workspace_id` as its first column (for example `idx_candidates_status` becomes `(workspace_id, status)`).

Backfill: insert workspace 1 (`status 'active'`, `shared_keys 1`), set every existing user's `workspace_id` to 1, and give every copied row `workspace_id = 1`. The operator flag is set afterwards by the operator with one SQL statement (section 11); the migration does not hardcode an email.

## 5. Sign-in and approval

`POST /auth/google` verifies the Google token as today (a verified email is required), then:

| Situation | Response | What the person sees |
|---|---|---|
| User exists, active, workspace active | `200` with token, user, workspace, operator flag | The app |
| User exists, workspace `pending` | `202 { status: "pending" }`, no token | "Waiting for approval" |
| User inactive or workspace `suspended` | `403` | "This workspace is not active" |
| Email unknown, fewer than 50 pending | Creates a `pending` workspace (named after the Google name, for example "Priya Shah's workspace") and an `admin` user in it; `202 pending` | "Waiting for approval" |
| Email unknown, 50 or more pending | `503`, nothing created | "Sign-ups are closed for now" |

Sessions are stateless, so `requireUser` already looks the user up on every request. It now joins the workspace and rejects anything but an `active` workspace: suspending a workspace takes effect on the next request. The token format does not change, so existing sessions keep working. The workspace id always comes from that lookup. It is never read from the request body, the URL or the token.

Operator actions (all require `users.operator = 1`, else `403`):

- `GET /api/operator/workspaces`: every workspace with owner email, status, created and approved times, `shared_keys`, and whether it has data.
- `POST /api/operator/workspaces/:id/approve`: `pending` or `suspended` to `active`, sets `approved_at`.
- `POST /api/operator/workspaces/:id/suspend`: `pending` or `active` to `suspended`. An operator cannot suspend the workspace they belong to.
- `PUT /api/operator/workspaces/:id/shared-keys` with `{ on: boolean }`.

There is no email or other notification of a new request: the operator opens the Workspaces screen, which shows pending ones first.

## 6. Isolation rules

1. Every handler that touches tenant data receives `workspaceId` from `user.workspaceId` and passes it down; every function in `db.js`, `discovery/store.js`, `discovery/run.js` and `discovery/settings.js` takes it as an explicit argument and throws if it is not a positive integer.
2. Every SQL statement on a tenant table names `workspace_id`. Ids that arrive in a URL (`/api/events/:id`, `/api/search/:id`, `/api/inbox/:id`) are looked up by `(workspace_id, id)`. A miss is `404`, never `403`, so existence does not leak.
3. The composite foreign keys of section 4.
4. Things that are global today and would leak if left alone:
   - `daySpend` sums every search run of the day. It becomes per workspace, so one workspace cannot spend another's daily cap.
   - `getActiveConfig` creates version 1 of the ICP when none exists. It creates it for the calling workspace only.
   - `rejections`: a rejected name is remembered per workspace; one workspace's "no" must not hide the event from another.
   - `search_runs`: "one running search per person" stays keyed by user, which is already inside one workspace.
   - `page_cache` stays shared on purpose (rule above).

Two tests enforce this beyond review (section 12): a source scan that fails when a statement on a tenant table lacks `workspace_id`, and a two-workspace sweep over every route.

## 7. API changes

- `POST /auth/google`: see section 5. The `200` body adds `workspace: { id, name }` and `operator: boolean`.
- Operator routes: section 5.
- `POST /api/workspace/samples`: loads the ten sample events into the caller's workspace. Idempotent (running it twice adds nothing). Admin only.
- All existing routes keep their paths and shapes; only their data is scoped. `GET/PUT /api/discovery/settings` and the budget caps are per workspace.

## 8. Screens

- **Waiting for approval.** Shown on `202 pending` in the sign-in card, in a calm colour rather than the error colour: "Your workspace is waiting for approval. Sign in again later to check." *Amended:* there is no separate Check again button, because checking needs a fresh Google credential anyway, so the Google button stays and signing in again is the check.
- **Workspaces** (operator only, in the navigation): table of workspaces with Approve, Suspend and a shared-keys switch. Pending first.
- **First run.** Radar and Events on an empty workspace show one card with three steps: set your sectors (ICP brain), load the sample events, find events. This replaces the current "Import the case-study Sheet" empty text.
- **Find events** when the workspace is not flagged `shared_keys`: "Search needs an Exa key for this workspace. Per-workspace keys arrive in the next update; the operator can switch on the shared key meanwhile." The Search and Fill the map buttons stay disabled, as they are now when keys are missing.
- The workspace name appears on the sign-out button ("Sign out of Priya Shah's workspace"). *Amended:* the app has no account menu. The name is someone's Google display name, so it is set through DOM attributes and text nodes, never as HTML.
- **Memory** card on the ICP brain: how many things the workspace has remembered, and the latest 20 in plain words ("Rejected BME Symposium from the inbox, 2 of 3 sites"). Read-only in this sub-project, so people can see it building; Forget controls come with sub-project 3.

## 9. Discovery per workspace

`defaultDeps(env, workspace)` builds the Exa reader and the optional Claude reader only when `workspace.shared_keys` is on; otherwise `missingSecrets` reports the key as missing. Caps (`runCapUsd`, `dayCapUsd`), `paused`, sectors and spend are per workspace because `settings` and `search_runs` are scoped. Suspending a workspace stops its searches at the next step because `requireUser` refuses it. A global "pause everything" for the operator is out of scope.

## 10. Scripts

- `scripts/import-sheet.mjs` and `import-lib.js` take `--workspace <id>` (default `1`) and write `workspace_id` on every row, so the operator can still load a workspace's leads before self-serve import exists.
- `scripts/dev-seed.mjs` seeds workspace 1 and a second, empty workspace so local checks can see isolation. The ten sample events move to `worker/src/samples.js`, shared by the seed script and the samples route.
- `scripts/dev-token.mjs` accepts `--workspace` and `--operator`.

## 11. Migration and rollout

Unlike migrations 0002 and 0003, this one rebuilds tables, so the old Worker code cannot write after it is applied (its inserts have no `workspace_id`). Reads keep working. With one user and a few rows this is a short window if both steps run back to back. Nothing here touches the live database without the user's go-ahead.

1. **Rehearse on a copy.** Export the live database (`wrangler d1 export`, into the git-ignored `.wrangler` folder), load it locally, apply 0004 and 0005, and compare row counts table by table. Run `PRAGMA foreign_key_check`.
2. **Bookmark.** Note the Time Travel restore point before applying.
3. **Apply 0004 and 0005 remotely, then deploy the Worker immediately.**
4. **Set the operator**: `UPDATE users SET operator = 1 WHERE email = '<you>'`, run by the user.
5. **Push the site** (the Pages build with the waiting screen and Workspaces screen).
6. **Google consent screen**: see section 13.

## 12. Testing

- **Migration**: build a database at the 0003 schema with data in every table (ten events, companies, people, links, candidates, runs, settings, ICP versions), apply 0004, then assert equal row counts, `workspace_id = 1` everywhere, `foreign_key_check` clean, the same domain allowed in two workspaces and refused twice in one, and a child row pointing across workspaces refused.
- **Sign-in**: every row of the section 5 table, the 50-pending cap, repeat sign-in creating nothing new, a suspended workspace refusing an existing token on its next request, a user with no workspace refused.
- **Operator routes**: `403` for a non-operator; approve, suspend and the shared-keys switch; an operator cannot suspend their own workspace.
- **Isolation sweep**: two workspaces each with events, companies, people, decisions, candidates, search runs, settings and ICP versions. For every route in the route table, call it as each workspace, assert no row of the other appears, and call each id-taking route with the other workspace's ids and expect `404`.
- **Source scan**: fails when a SQL statement in `worker/src` or `scripts` names a tenant table fewer times than it names `workspace_id` (joins need one per table). It is a heuristic that the plan defines exactly; the sweep test below is the proof, the scan is the cheap early warning.
- **Discovery**: `daySpend` and caps separate per workspace; a workspace without `shared_keys` reports the Exa key as missing; the one-running-search rule is unchanged.
- **Site**: the waiting screen, the closed message, the operator navigation entry only for operators, the first-run card, and the samples route idempotent.
- **Scripts**: import with `--workspace 2` leaves workspace 1 untouched.
- **Memory**: each capture point of section 15 writes one entry with the facts of that moment; a search step with ten new events still stays within the 50-query budget; entries are scoped to their workspace (the sweep covers them); no lead name, email or profile link ever appears in `detail`; a failed memory write is logged and does not fail the action; the migration backfill creates entries from workspace 1's existing decisions, rejections, candidate outcomes and ICP versions.
- The full suite stays green. The per-step query budget (50 D1 queries) is unchanged, because scoping adds predicates, not queries; the existing test that holds a search step to that budget stays.

## 13. Risks and open items

- **Google sign-in for strangers.** The consent screen in project `krillium` is in Testing, so only listed Google test users (at most 100) can sign in at all. For people to request access on their own, the consent screen must be published to production. The sign-in uses only the basic scopes (openid, email, profile), which I believe need no Google verification review, but I have not confirmed that, and Google may ask for a homepage and a privacy-policy link. Until published, the operator adds each requester as a Google test user first, then approves them in the app. This is the user's action in Google Cloud and is not part of the build. A privacy page will be needed before publishing; its wording needs the user's review and is a separate small task.
- **Table rebuilds on D1.** *Amended:* `0005` does not defer foreign keys. Deferring is fragile when a referenced parent is dropped and rebuilt (SQLite's deferred-violation counter stays raised even after the data is back, and the children's old single-column references would mismatch the new composite parent key). Instead every new table is created under a `_v2` name pointing at the other `_v2` tables, parents are copied before children, the old tables are dropped children first, and each `_v2` table is renamed (SQLite rewrites the references in its children). No reference ever dangles, and it runs as one atomic batch. It passed 15 data-bearing tests in Miniflare and wrangler's own runner on the seeded local database, which is the same SQLite engine but not the live D1 service: the rehearsal in section 11 is the real check. Fallback if it misbehaves on D1: the live tables hold a few dozen rows, so export, rebuild locally and re-import is acceptable with the restore point in hand.
- **A missed `WHERE`** is the main isolation risk. The composite keys, the source scan and the sweep test exist because review alone is not enough; the final review focuses on it.
- **Free-plan limits.** Sign-up is gated, but each approved workspace adds Worker requests and D1 reads. Watch the request counts in the Cloudflare dashboard; Workers Paid ($5 a month) lifts them.
- **Personal data.** Workspaces will hold lead data (names, emails). Before real customers use it, workspace deletion and data export are needed. Neither is in this sub-project.

## 14. Out of scope

Per-workspace API keys and the HubSpot connection (sub-projects 2 and 5); reading memory to decide anything, and the Forget controls (sub-project 3); invite screens and per-member roles beyond admin and member; self-serve lead import; workspace rename, delete and export; operator email notifications; a global pause switch; billing.

## 15. Memory from day one

**Why.** The product should get better at a workspace's judgement the longer it is used. That needs the history, so capture ships with workspaces and not later: whatever happens before a memory feature exists cannot be recovered afterwards.

**What it is.** An append-only log per workspace of facts about what the workspace decided or did, written by the Worker at the points where a person or the system makes a call.

```
memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces (id),
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor TEXT NOT NULL,                 -- a user's email, or 'system'
  kind TEXT NOT NULL,                  -- from the list below
  subject TEXT,                        -- event, candidate, run or sector id, when there is one
  detail TEXT NOT NULL DEFAULT '{}'    -- JSON snapshot of the facts, at most 2 KB
)
INDEX (workspace_id, kind, at)
```

**Recorded from day one**, each at an existing write path:

| Kind | Where | Facts kept |
|---|---|---|
| `event.decision` | `postDecision` | choice, reason, event name, organiser, city, country, sectors, priority score and ICP version at the time |
| `candidate.approved`, `candidate.rejected` | `approveInbox`, `rejectInbox` | name, organiser, city, country, sectors, number and names of agreeing sites, why it was in the inbox |
| `autoadd.undone` | `undoAutoAddRoute` | the same facts |
| `search.finished` | run completion | sectors searched, counts by outcome (auto-added, inbox, filtered by reason), spend, which sources produced new events and which only produced rejects, names of auto-added events. One entry per run, however many events it found |
| `icp.saved` | `putIcp` | the new version and which fields changed |
| `sectors.saved` | `putDiscoverySettings` | sectors added, removed or edited; caps changed |
| `samples.loaded` | samples route | that the ten samples were loaded |

Read later, these answer: which organisers, places, sectors and sources this workspace values or rejects, and which searches waste money.

**Rules.**

- **Facts, not references.** Each entry snapshots what mattered at that moment, so an event removed by "undo" is still remembered as rejected.
- **Append-only** from application code. This sub-project has no update or delete route for memory.
- **No personal data about leads.** Names, emails and profile links never go in `detail`. Lead-level feedback in later sub-projects is kept as rules and counts.
- **One statement per request.** Entries from one request are written in a single multi-row `INSERT`, so the 50-query step budget holds. A search step that finds ten events writes nothing per event; the run writes one `search.finished` entry when it ends.
- **Bounded.** `detail` stays under 2 KB: long lists are shortened and keep a count of what was left out.
- **Never blocks the action.** A failed memory write is logged and does not fail what the person asked for.
- **Private.** Memory is a tenant table scoped like the rest. Nothing is pooled or shared across workspaces; learning across workspaces would need an explicit opt-in and is out of scope.
- **Backfill.** Migration 0004 seeds workspace 1's memory from its existing `decisions`, `rejections`, candidate outcomes and `icp_config` versions, so its history is not lost.

**What sub-project 3 (Memory and judgment) may rely on** (its design comes later):

- **Learnings from counting first.** Each learning is a sentence, its evidence (entries and counts), a confidence and a status: suggested, accepted or dismissed. Example: "You rejected 8 of 9 events from this organiser."
- **Where accepted learnings act:** ranking events (with the reason shown), planning searches (dropping queries and sources that waste budget), and suggesting ICP and sector changes the person accepts or dismisses.
- **Guardrails.** Learnings are visible, editable and reversible. Nothing loosens the verification rules (three agreeing sites, quotes from the page) or raises spend on its own. Every smart decision can say why it was taken.
- **Model-written summaries are optional**, use the workspace's own key, and are not needed for the counting to work.
