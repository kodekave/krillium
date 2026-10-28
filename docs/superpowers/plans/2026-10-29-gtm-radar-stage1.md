# GTM Radar Stage 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the signed-in dashboard (world-map radar, events table, ICP brain, graph, feed, ask bar) on a Cloudflare Worker + D1 API, loaded with the General Mind case-study data.

**Architecture:** A static frontend (plain HTML, CSS, ES modules) calls a Cloudflare Worker that verifies Google sign-in and serves JSON from D1. One shared scoring module is imported by both the Worker and the page, so stored ranks and the live ICP preview always agree.

**Tech Stack:** Cloudflare Workers, D1, Vitest with `@cloudflare/vitest-pool-workers`, D1 migrations, vanilla ES modules, vendored d3-geo 3.1.1, d3-force 3.0.0, topojson-client 3.1.0, world-atlas 2.0.2.

**Spec:** `docs/superpowers/specs/2026-10-29-gtm-radar-design.md`

## Global Constraints

- Frontend has no build step: plain HTML, CSS and ES modules, served as static files.
- All asset and API URLs are relative or come from `site/config.js`, so the site works under any GitHub Pages subpath.
- No lead data in the repo or the static files. `data/` and `import.sql` are git-ignored.
- Production secrets (`GOOGLE_CLIENT_ID`, `SESSION_SECRET`) are set by the user with `wrangler secret put`. Executors never write, print or ask for them. Local `.dev.vars` holds generated throwaway values only.
- CORS allows only `ALLOWED_ORIGIN`. Session tokens are HS256, 8 hour life, sent as `Authorization: Bearer`, kept in memory and `sessionStorage`.
- Event priority = `0.4 x event_score_norm + 0.6 x icp_density_norm`. Status: must-attend at 70 or above, consider 45 to 69, watch below 45. Lead tiers: A from 75, B from 55.
- Lead score parts: fit 40 (set per lead), persona (economic buyer 30, champion 22, influencer 12), event role (speaker/keynote/panelist/moderator 20, exhibitor or sponsor rep 14, named attendee 12, company only 8), contactability (verified email 10, LinkedIn only 4, none 0).
- Type Geist and Geist Mono. Radii 6, 8, 12, 14, 20 and pill. Dark map by default, light/dark toggle. Respect `prefers-reduced-motion`. Works at 390px width.
- Stage 2 (live jobs, model calls) and stage 3 (calendar, alerts) are out of this plan.

## Review Focus

1. An event with no attached people or companies (density max of 0) ranks from its event score only: no NaN, no divide by zero. Tested in Task 2 and Task 6.
2. An event with no coordinates or no end date still appears in the table with a Needs check pill, and the map skips its pin without erroring. Tested in Tasks 6 and 10.
3. The site served under a subpath (`/radar/`) still loads every asset and calls the right API. Tested in Task 9.
4. The session token expiring mid-session returns to sign-in and keeps unsaved ICP edits in memory. Tested in Tasks 9 and 12.
5. German umlauts, "Prof. Dr." prefixes and the same person on two events behave: search and persona matching ignore accents, and one email gives one `people` row with two `event_people` rows. Tested in Tasks 3, 8 and 11.

---

## File Structure

```
package.json, wrangler.toml, vitest.workspace.js, .gitignore, DEPLOY.md
site/index.html, site/config.js, site/css/{tokens,layout,map,components}.css
site/js/{main,router,api,auth}.js
site/js/shared/{scoring,clean}.js            # imported by site and Worker
site/js/map-geometry.js, site/js/views/{radar,events,icp,graph,feed}.js, site/js/ask.js
site/vendor/                                  # pinned d3 libs, world-atlas
worker/src/{index,auth,db,cors}.js, worker/src/routes/{read,write,ask}.js
worker/migrations/0001_init.sql
scripts/{import-sheet,dev-token}.mjs
tests/{shared,worker,site,fixtures}/...
.github/workflows/pages.yml
```

---

### Task 1: Scaffold and test harness

**Files:** Create `package.json`, `wrangler.toml`, `vitest.workspace.js`, `.gitignore`, `tests/shared/smoke.test.js`, `tests/worker/smoke.test.js`.

**Interfaces:** Produces npm scripts `test`, `dev:worker` (`wrangler dev --local`), `dev:site` (`python3 -m http.server 8080 --directory site`); D1 binding `DB`; var `ALLOWED_ORIGIN`.

- [ ] **Step 1:** `git init`; write `.gitignore` (`node_modules`, `.dev.vars`, `data/`, `import.sql`, `.wrangler`). Create `package.json` with exact-pinned devDependencies `vitest`, `@cloudflare/vitest-pool-workers`, `wrangler`; `wrangler.toml` naming the Worker `gtm-radar-api`, main `worker/src/index.js`, D1 binding `DB` with migrations dir `worker/migrations`, empty `[triggers] crons = []`.
- [ ] **Step 2:** Write two smoke tests: the shared one asserts `1 + 1 === 2` under node; the worker one asserts `env.DB` is defined using the workers pool. Configure `vitest.workspace.js` with a `shared` project (node, `tests/shared`, `tests/site`) and a `worker` project (workers pool, `tests/worker`).
- [ ] **Step 3:** Run `npm test`. Expected: both smoke tests PASS.
- [ ] **Step 4:** Commit `chore: scaffold project and test harness`.

### Task 2: Scoring module

**Files:** Create `site/js/shared/scoring.js`, `tests/shared/scoring.test.js`.

**Interfaces:** Produces `DEFAULT_CONFIG`; `leadScore(input, cfg): number` where `input = {fit: number, persona: 'economic_buyer'|'champion'|'influencer'|null, eventRole: 'speaker'|'exhibitor'|'attendee'|'company_only', contact: 'verified_email'|'linkedin'|'none'}`; `tierFor(score, cfg): 'A'|'B'|'C'`; `icpDensity(counts: {tierA, tierB, accountOnly}, cfg): number`; `eventPriority(event: {eventScore20, counts}, maxDensity, cfg): number`; `statusFor(priority, cfg): 'must-attend'|'consider'|'watch'`; `rankEvents(events, cfg): Array<event & {priority, status}>` sorted by priority descending; `validateConfig(cfg): {ok: boolean, errors: string[]}`. Config shape: `{version, weights: {eventScoreShare: 0.4, icpDensityShare: 0.6}, density: {tierA: 3, tierB: 1, accountOnly: 0.5}, thresholds: {mustAttend: 70, consider: 45, tierA: 75, tierB: 55}, persona, eventRole, contact, homeBases: [{name, lat, lon}]}` with Berlin (52.52, 13.405) and New York (40.7128, -74.006).

- [ ] **Step 1: Failing tests** for: `leadScore({fit:35, persona:'economic_buyer', eventRole:'speaker', contact:'verified_email'}, cfg) === 95` (the three pushed leads); `leadScore({fit:35, persona:'champion', eventRole:'speaker', contact:'verified_email'}) === 87` (Ioffe); `tierFor(75)==='A'`, `tierFor(74)==='B'`, `tierFor(55)==='B'`, `tierFor(54)==='C'`; `icpDensity({tierA:2,tierB:1,accountOnly:2}) === 8`; `eventPriority({eventScore20:15, counts:{tierA:2,tierB:1,accountOnly:2}}, 16) === 60`; `eventPriority({eventScore20:20, counts:{tierA:0,tierB:0,accountOnly:0}}, 0) === 40` and is finite (Review Focus 1); `statusFor(70)==='must-attend'`, `statusFor(69.9)==='consider'`, `statusFor(45)==='consider'`, `statusFor(44.9)==='watch'`; `rankEvents` sorts descending; `validateConfig` rejects shares not summing to 1 and `consider >= mustAttend`.
- [ ] **Step 2:** Run `npx vitest run tests/shared/scoring.test.js`. Expected: FAIL, module missing.
- [ ] **Step 3:** Implement the module above. `icpDensity` is pure arithmetic from `cfg.density`; guard `maxDensity === 0` so the density term is 0.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: shared scoring module`.

### Task 3: Cleaning module

**Files:** Create `site/js/shared/clean.js`, `tests/shared/clean.test.js`.

**Interfaces:** Produces `domainMatches(emailDomain: string, companyDomain: string, aliases: string[]): boolean`; `classifyPersona(title: string): 'economic_buyer'|'champion'|'influencer'|null` (null means "send to reviewer"); `normaliseCompanyName(name: string): string`.

- [ ] **Step 1: Failing tests:** `domainMatches('janssen.ie','jnj.com',[])` false; `('paloaltonetworks.com','johnsoncontrols.com',[])` false; `('cef.co.uk','cityelectricsupply.com',[])` false (the three domain-mismatch rejects from the case study; the other two failed the mailbox check, which is not this function's job); `('wesco.com','wesco.com',[])` true; `('mail.wesco.com','wesco.com',[])` true; `('EFFEM.com','mars.com',['effem.com'])` true. `classifyPersona`: `'CFO'`, `'Leiter Einkauf'`, `'GESCHÄFTSFÜHRER'` give `economic_buyer`; `'Head of Order to Cash'`, `'Leiter Supply Chain Management'` give `champion`; `'Global Process Owner'`, `'ERP Lead'` give `influencer`; `'Prof. Dr. Moritz Schularick, Präsident'` and `'Senior Intern'` give `null`. `normaliseCompanyName('Siemens AG') === normaliseCompanyName('SIEMENS')`; legal suffixes (AG, GmbH, SE, Inc, Corp, Ltd) and diacritics are stripped.
- [ ] **Step 2:** Run `npx vitest run tests/shared/clean.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. Persona uses an ordered rule list of accent-folded, lowercased patterns, first match wins; domain match accepts equality or a subdomain of the company domain or any alias.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: shared cleaning rules`.

### Task 4: D1 schema and config store

**Files:** Create `worker/migrations/0001_init.sql`, `worker/src/db.js`, `tests/worker/schema.test.js`.

**Interfaces:** Consumes `DEFAULT_CONFIG` (Task 2). Produces the 13 tables from spec section 6 (`events`, `companies`, `people`, `event_people`, `event_companies`, `signals`, `icp_config`, `decisions`, `users`, `prefs`, `runs`, `changes`, `calendar_tokens`) with the unique keys the spec names; `getActiveConfig(db): Promise<Config>` (inserts version 1 from `DEFAULT_CONFIG` if the table is empty); `saveConfig(db, cfg, user): Promise<number>` returns the new version.

- [ ] **Step 1: Failing tests:** all 13 table names exist; inserting two `people` rows with the same email fails; `getActiveConfig` on an empty DB equals `DEFAULT_CONFIG` with `version: 1` and a second call leaves exactly one row; `saveConfig` returns 2 and `getActiveConfig` then returns version 2.
- [ ] **Step 2:** Run `npx vitest run --project worker tests/worker/schema.test.js`. Expected: FAIL.
- [ ] **Step 3:** Write the migration and `db.js`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: D1 schema and config store`.

### Task 5: Auth

**Files:** Create `worker/src/auth.js`, `tests/worker/auth.test.js`.

**Interfaces:** Produces `verifyGoogleIdToken(idToken: string, env: {GOOGLE_CLIENT_ID: string}, getJwks?: () => Promise<{keys: JsonWebKey[]}>): Promise<{email: string, name: string}>` (throws `AuthError`); `signSession(payload: {email, name, role}, secret: string, now?: number): Promise<string>`; `verifySession(token: string, secret: string, now?: number): Promise<{email, name, role} | null>`; `requireUser(request: Request, env): Promise<{email, name, role}>` (throws a 401 `Response`).

- [ ] **Step 1: Failing tests** (generate a throwaway RSA key pair in the test and inject a `getJwks` for it): valid token returns email and name; expired token, wrong audience and `email_verified: false` each throw `AuthError`; `verifySession` returns null for a tampered token and for one 8 hours and 1 second old; `requireUser` throws 401 with no header.
- [ ] **Step 2:** Run `npx vitest run --project worker tests/worker/auth.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement with Web Crypto only (RS256 verify against JWKS, HS256 for sessions, 8 hour life). Default `getJwks` fetches Google's public key set.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: Google sign-in verification and sessions`.

### Task 6: Router, CORS and read endpoints

**Files:** Create `worker/src/index.js`, `cors.js`, `routes/read.js`, `tests/worker/read.test.js`.

**Interfaces:** Consumes Tasks 2, 4, 5. Produces `POST /auth/google` (body `{idToken}`; 403 if the email is not an active `users` row; else `{data: {token, user}}`); `GET /api/radar` returning `{data: RadarEvent[], generatedAt}` where `RadarEvent = {id, name, city, country, lat: number|null, lon: number|null, startDate, endDate: string|null, eventScore20, counts: {tierA, tierB, accountOnly}, priority, status, freshness: 'verified'|'needs-check'|'changed', sourceUrl, lastChecked}`; `GET /api/events/:id` (adds `reasons`, `accounts`, `sources`, `history`); `GET /api/feed` (50 newest `changes`); `GET /api/icp`. Errors are `{error: string}` with the right status.

- [ ] **Step 1: Failing tests:** no token gives 401; `OPTIONS` from `ALLOWED_ORIGIN` gives 204 with that exact `Access-Control-Allow-Origin`, from another origin gives no such header; `/auth/google` with a non-allow-listed email gives 403; `/api/radar` with seeded rows returns events sorted by priority with status; an event with zero attached people has finite priority equal to `0.4 x eventScore20/20 x 100`; an event with null `lat`, `lon` and `endDate` is still returned with `freshness: 'needs-check'`; page read 36 days ago gives `needs-check`, 10 days ago with matching lineup gives `verified`; `/api/events/unknown` gives 404; `/api/feed` is newest first and capped at 50.
- [ ] **Step 2:** Run `npx vitest run --project worker tests/worker/read.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement routing and handlers. Counts come from D1 joins; priority and status come from the shared module with `getActiveConfig`.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: API read endpoints with CORS lock`.

### Task 7: Write endpoints and ask intents

**Files:** Create `worker/src/routes/write.js`, `routes/ask.js`, `tests/worker/write.test.js`.

**Interfaces:** Produces `PUT /api/icp` (validates with `validateConfig`, 400 with `{error, errors}` when invalid, else saves and returns the new version); `POST /api/decisions` body `{eventId, choice: 'attend'|'watch'|'skip', reason?: string, note?: string}`, stores the current score as `score_snapshot` and the active `config_version`, 400 for other choices or a `skip` without a reason; `GET /api/ask?intent=top_events_in_range&from=&to=` | `intent=changed_this_week` | `intent=tier_a_by_event`, anything else 400; `GET /api/prefs` and `PUT /api/prefs` body `{key: string, value: string}` for the signed-in user's saved view (theme, last filters), values capped at 4 KB. The `role` is stored and returned but not enforced in stage 1.

- [ ] **Step 1: Failing tests:** a pref saved by one user is not returned to another; a value over 4 KB gives 400; invalid config (shares summing to 1.2, `consider >= mustAttend`) gives 400 and saves nothing; valid config bumps the version; decision stores snapshot and version; `skip` without reason gives 400; `top_events_in_range` returns only events inside the range, ordered by priority; unknown intent gives 400.
- [ ] **Step 2:** Run `npx vitest run --project worker tests/worker/write.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: ICP, decisions and ask endpoints`.

### Task 8: Sheet import script

**Files:** Create `scripts/import-sheet.mjs`, `tests/fixtures/{events,leads,vendors}.csv`, `tests/worker/import.test.js`.

**Interfaces:** Consumes `classifyPersona`, `normaliseCompanyName`, `domainMatches`. Produces `buildImportSql({eventsCsv, leadsCsv, vendorsCsv}: string): string` and CLI `node scripts/import-sheet.mjs --events a.csv --leads b.csv --vendors c.csv --out import.sql`.

- [ ] **Step 1: Failing tests** (small fixtures with made-up names): the SQL runs twice on a fresh D1 and the second run changes no counts (idempotent); two leads with the same email at two events give one `people` row and two `event_people` rows; "Siemens AG" and "Siemens" resolve to one company; a vendor-watchlist company is imported with `vendor = 1` and never counted in event density; a name with umlauts and "Prof. Dr." survives intact; a lead whose email domain does not match its company is imported with `email = NULL`; the first import writes one `changes` row of kind `imported` per event and a rerun writes none (so the feed has content on day one).
- [ ] **Step 2:** Run `npx vitest run --project worker tests/worker/import.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement with a small CSV parser (quoted fields, embedded commas). Output uses `INSERT ... ON CONFLICT DO UPDATE`. Add a nullable `vendor` column in migration 0001 if Task 4 left it out.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: sheet CSV import`.

### Task 9: Frontend shell, auth and API client

**Files:** Create `site/index.html`, `site/config.js`, `site/css/{tokens,layout,components}.css`, `site/js/{main,router,api,auth}.js`, `scripts/dev-token.mjs`, `tests/site/api.test.js`.

**Interfaces:** Produces `api.get(path)`, `api.put(path, body)`, `api.post(path, body)` each returning `{ok: boolean, data?, stale?: boolean, status?: number}`; `api.onUnauthorised(cb)`; router `navigate(hash)` and view contract `mount(root: HTMLElement, ctx: {api, config}) => () => void` for hashes `#/radar`, `#/events`, `#/icp`, `#/graph`, `#/feed`; `site/config.js` exports `{apiBase, googleClientId}` (public values only).

- [ ] **Step 1: Failing tests** with a mocked `fetch`: sends `Authorization: Bearer <token>`; a network failure returns `{ok:false, stale:true}`; a 401 calls the `onUnauthorised` callback once; URLs resolve from `config.apiBase`, and loading `index.html` under a `/radar/` base path produces no absolute-path asset URLs (Review Focus 3).
- [ ] **Step 2:** Run `npx vitest run tests/site/api.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement. The shell has the icon rail (bottom bar under 600px), tokens from the spec's look-and-feel, Google sign-in screen, stale-data banner and theme toggle. `dev-token.mjs --email` prints a session token signed with the `.dev.vars` secret, for browser checks without Google.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then run `npm run dev:worker` and `npm run dev:site`, paste a dev token into `sessionStorage` in the browser, and confirm the shell renders, the rail navigates and a forced 401 returns to sign-in.
- [ ] **Step 5:** Commit `feat: frontend shell, auth and API client`.

### Task 10: Map geometry and Radar view

**Files:** Create `site/js/map-geometry.js`, `site/js/views/radar.js`, `site/css/map.css`, `site/vendor/*`, `tests/site/map-geometry.test.js`.

**Interfaces:** Consumes `rankEvents`, `api`. Produces `project(lat, lon, size): [x, y] | null` (null for non-finite input), `arcPath(a: [x,y], b: [x,y]): string` (SVG path, curved), `pinRadius(priority: number): number`, `dateWindow(events, fromIso, toIso): RadarEvent[]`.

- [ ] **Step 1: Failing tests:** `project(52.52, 13.405, {width:1000, height:500})` returns finite numbers inside the box; `project(null, null)` returns null (Review Focus 2); `pinRadius` is increasing and bounded; `arcPath` starts and ends at its two points; `dateWindow` excludes events outside the range and keeps events with a null end date by start date.
- [ ] **Step 2:** Run `npx vitest run tests/site/map-geometry.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the geometry, then the view: dotted world map from vendored world-atlas, pins by priority and status, pulse on must-attend, arcs from both home bases, timeline scrubber, hover card, click opens the drawer slot used in Task 11.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then in the browser confirm pins render for the seeded events, a null-coordinate event is skipped without a console error, and screenshot desktop and 390px widths.
- [ ] **Step 5:** Commit `feat: radar map view`.

### Task 11: Events table, drawer and decisions

**Files:** Create `site/js/views/events.js`, `site/js/drawer.js`, `tests/site/events.test.js`.

**Interfaces:** Consumes `RadarEvent`, `api`. Produces `filterEvents(events, {region?, from?, to?, minScore?, query?}): RadarEvent[]` and `mountDrawer(root, ctx): {open(eventId), close()}` used by Radar and Events.

- [ ] **Step 1: Failing tests:** `filterEvents` by `minScore`, by date range, and by `query` where `'Zurich'` matches `'Zürich'` and `'berlin'` matches `'Berlin'` (accent and case folding, Review Focus 5); an event with a null end date passes a date filter on its start date.
- [ ] **Step 2:** Run `npx vitest run tests/site/events.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the table (freshness pills, sorted by priority), filter bar, and the drawer (buyer counts, vendor share, why-attend line from stored facts, source links, accounts, link to the lead cockpit, attend/watch/skip with reason). Decisions post to `/api/decisions`. The last-used filters and theme are saved and restored through `/api/prefs`, which is the dashboard's memory.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then in the browser record a decision on a seeded event and confirm it appears in the database.
- [ ] **Step 5:** Commit `feat: events table, drawer and decisions`.

### Task 12: ICP brain

**Files:** Create `site/js/views/icp.js`, `tests/site/icp.test.js`.

**Interfaces:** Consumes `rankEvents`, `validateConfig`, `api`. Produces `draftConfig` helper `applyEdit(cfg, path: string, value: number): Config` (returns a new object, never mutates).

- [ ] **Step 1: Failing tests:** `applyEdit` returns a new object and leaves the original untouched; raising `weights.icpDensityShare` (with the share rebalanced) changes the order of a two-event fixture; an invalid draft disables Save and lists the errors; after a 401 the draft is still in memory when the user signs in again (Review Focus 4).
- [ ] **Step 2:** Run `npx vitest run tests/site/icp.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement sliders and number inputs for weights, thresholds, persona points and home bases, with an instant re-ranked preview list and Save via `PUT /api/icp`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then in the browser move a weight and confirm the preview reorders before saving.
- [ ] **Step 5:** Commit `feat: ICP brain with live re-rank`.

### Task 13: Graph, Feed and Ask bar

**Files:** Create `site/js/views/graph.js`, `site/js/views/feed.js`, `site/js/ask.js`, `tests/site/graph.test.js`.

**Interfaces:** Produces `buildGraph(events, accountsByEvent): {nodes: Array<{id, kind: 'event'|'company'|'persona'}>, links: Array<{source, target}>}`; `parseAsk(text: string): {intent, params} | null` for the three fixed intents.

- [ ] **Step 1: Failing tests:** `buildGraph` creates one node per event, company and persona with no duplicate ids and links only between existing nodes; `parseAsk('which events in march have the most tier a buyers')` returns `tier_a_by_event`; `parseAsk('what changed this week')` returns `changed_this_week`; unrecognised text returns null.
- [ ] **Step 2:** Run `npx vitest run tests/site/graph.test.js`. Expected: FAIL.
- [ ] **Step 3:** Implement the 2D d3-force graph, the feed list (newest first, source link per item) and the Cmd+K ask bar calling `/api/ask`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then in the browser open each view and the ask bar and check for console errors.
- [ ] **Step 5:** Commit `feat: graph, feed and ask bar`.

### Task 14: Motion, themes and responsive polish

**Files:** Modify `site/css/*.css`, `site/js/views/radar.js`; Create `tests/site/motion.test.js`.

**Interfaces:** Produces `prefersReducedMotion(): boolean` in `site/js/main.js`, consumed by all animation code.

- [ ] **Step 1: Failing test:** with `matchMedia('(prefers-reduced-motion: reduce)')` mocked true, `prefersReducedMotion()` is true and the radar view starts no animation frame loop.
- [ ] **Step 2:** Run `npx vitest run tests/site/motion.test.js`. Expected: FAIL.
- [ ] **Step 3:** Add pin pulse, arc draw-in, panel transitions and number count-ups, all gated on `prefersReducedMotion()`. Finish light/dark themes and the phone layout (bottom bar, sheet drawer).
- [ ] **Step 4:** Run the same command. Expected: PASS. Then screenshot every view at 1440px and 390px in dark and light, with reduced motion on and off, and fix any overflow or clipped text.
- [ ] **Step 5:** Commit `feat: motion, themes and responsive layout`.

### Task 15: Deploy workflow and hand-off

**Files:** Create `.github/workflows/pages.yml`, `DEPLOY.md`.

**Interfaces:** Consumes everything. Produces a Pages workflow that publishes `site/` and a `DEPLOY.md` with the user steps below.

- [ ] **Step 1:** Write the workflow (publish `site/` on push to the default branch) and `DEPLOY.md`: create the D1 database and run `wrangler d1 migrations apply`; the user runs `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put SESSION_SECRET` and sets `ALLOWED_ORIGIN`; insert the team emails into `users`; run the import script on the user's CSV exports; set `apiBase` and `googleClientId` in `site/config.js`.
- [ ] **Step 2:** Run `npm test`. Expected: all projects PASS.
- [ ] **Step 3:** Stop and hand off. Do not deploy, create a GitHub repo, or enter any secret. Tell the user which `DEPLOY.md` steps are theirs.
- [ ] **Step 4:** Commit `docs: deploy guide and Pages workflow`.
