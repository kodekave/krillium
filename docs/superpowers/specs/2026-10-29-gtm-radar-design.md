# GTM Radar: design spec

Working title. Date: 2026-10-29. Status: awaiting user review.

## 1. Purpose

A dashboard for GTM engineers that decides which events to attend and why. It ranks events by how many ICP-matching people and companies are publicly attached to each one, keeps itself current with live checks of public event pages, and tells the team what changed.

The first dataset is the General Mind case study (see `Lead generation system for General Mind` PDF): 10 events, 89 named leads, 23 account-only companies and 48 watchlist vendors, scored with the ICP weights in that document.

**Success criteria**

- A signed-in team member opens the page and sees a world map of events with a clear must-attend / consider / watch ranking and a one-line reason for each.
- Changing an ICP weight re-ranks events instantly in the browser, before saving.
- A scheduled job detects a changed event page and the change appears in the feed with the source link.
- The public page and repo contain no lead data.
- The page looks polished and animated, at desktop and phone width.

## 2. Decisions made with the user

| Topic | Decision |
|---|---|
| Hosting, frontend | GitHub Pages, as a subpage of the user's site |
| Backend | Cloudflare Workers + D1 + Cron Triggers (user already deploys on Cloudflare) |
| Users | Small team, Google sign-in with an email allow-list (not Cloudflare Access: its cookie is third-party from `github.io`) |
| Design reference | Oxygen (oxygen-agent.com): restraint, frosted-glass panels, pills, Geist type, icon rail. Own identity, not a clone. |
| Out of scope | Sequencer, email sending, billing, a CRM, the lead-review queue (the existing cockpit keeps that job) |
| Model use | Rules first. A Haiku-class model only for ambiguous extraction, capped per run. |

## 3. Architecture

```
GitHub Pages (public, no data)        Cloudflare Worker (private)
UI: map, ranking, table, graph,  --->  API + Google token check
ICP editor, feed, ask bar        <---  Cron: refresh + clean + score
                                       D1 database
```

- The page is plain HTML, CSS and ES modules with no build step.
- The scoring function is one shared ES module, imported by the Worker and by the page, so stored scores and the live ICP preview agree.
- The Worker serves JSON only to requests carrying a valid session token.

### Event ranking

Each event gets a priority score from 0 to 100 and a status derived from it. This is the first set of weights, chosen from the case study's own scoring and open to tuning in the ICP brain, like the lead weights in the PDF.

- `priority = 0.4 x event_score_norm + 0.6 x icp_density_norm`
- `event_score_norm` is the PDF's event score out of 20, scaled to 0 to 100.
- `icp_density_norm` is `3 x (Tier A people) + 1 x (Tier B people)` attached to the event, scaled so the highest event is 100. Account-only companies count as half a Tier B person each.
- Status: **must-attend** at 70 or above, **consider** from 45 to 69, **watch** below 45. Both cut-offs live in `icp_config`.
- Each event's "why attend" line is built from stored facts only (counts, roles, source links), never from model guesses.

### Sign-in

1. The page shows a sign-in screen, using Google Identity Services.
2. `POST /auth/google` sends the Google ID token. The Worker verifies it, checks the email against `users`, and returns a session token (HS256 signed with Web Crypto, 8 hour life).
3. The page keeps the token in memory and `sessionStorage`, and sends it as `Authorization: Bearer`.

## 4. Screens

Left icon rail. Each icon opens one screen.

1. **Radar (home).** Full-screen dotted world map drawn with D3 and a public world-outline file (no tile service, no API key). Pins are sized by ICP score and coloured by status. Must-attend pins pulse, changed events flash once. Faint arcs run from the two home bases (Berlin, New York) to each pin, matching the distance scoring. A bottom timeline scrubber filters by date range. Hover shows a card (name, dates, score). Click opens a drawer with ICP buyer count, vendor share, a one-line "why attend" with source links, accounts at the event, the calendar action and the user's decision.
2. **Events table.** Ranked list with freshness pills (Verified: page read in the last 35 days and lineup matches stored data; Needs check: not read recently or lineup not yet published; Changed: page content changed since the user last opened the event), filters by region, date, score and source, and search.
3. **ICP brain.** Editable industries, personas, weights, tier cut-offs and home bases. Changing a value re-ranks events immediately. Saving writes a new `icp_config` version.
4. **Graph.** Event, company and persona links, 2D force layout.
5. **Feed.** What changed, new events found, upcoming deadlines.
6. **Ask bar (Cmd+K).** Stage 1 answers a fixed set of intents by database query (for example "events in a date range with the most Tier A buyers", "what changed this week"). Free-text understanding with a model is stage 2.

The event drawer links to the existing lead cockpit for per-lead review. Decisions in this dashboard are event-level: attend, watch or skip, with a reason.

## 5. Look and feel

- Geist and Geist Mono type, tight headline letter-spacing, radii 6, 8, 12, 14, 20 and pill.
- Deep ink-green map canvas, warm amber reserved for must-attend. Frosted-glass panels. Light/dark toggle, dark map by default.
- Animation by CSS and `requestAnimationFrame`: pin pulse, arc draw-in, panel transitions, number count-ups. Respect `prefers-reduced-motion`.
- Layout works at phone width: the rail becomes a bottom bar and the drawer becomes a sheet.

## 6. Data model (D1)

| Table | Columns (key ones) |
|---|---|
| `events` | id, name, organiser, url, city, country, lat, lon, start_date, end_date, status, source_url, content_hash, last_checked, last_changed, fit, public_names, timing, distance |
| `companies` | id, domain (unique), name, aliases, industry, size, region, erp, listed |
| `people` | id, email (unique, nullable), linkedin_url (unique, nullable), company_id, name, title, persona, source_url, date_found, lawful_basis |
| `event_people` | event_id, person_id, role |
| `event_companies` | event_id, company_id, source_url |
| `signals` | id, company_id, type, weight, date, quote, source_url |
| `icp_config` | version, json, created_by, created_at |
| `decisions` | id, event_id, user, choice, reason, note, score_snapshot, config_version, at |
| `users` | email, name, role, active |
| `prefs` | user, key, value |
| `runs` | id, job, started, finished, status, model_spend, error |
| `changes` | id, event_id, kind, summary, source_url, at |
| `calendar_tokens` | user, token_hash, created_at, revoked_at |

The first import loads CSV exports of the existing Sheet tabs (Events, Leads, Vendors_Watchlist) with a one-off script.

## 7. API

| Endpoint | Purpose |
|---|---|
| `POST /auth/google` | Verify Google token and allow-list, return session token |
| `GET /api/radar` | Map payload: events with scores, status and counts |
| `GET /api/events/:id` | Drawer detail: reasons, accounts, sources, history |
| `GET /api/feed` | Change feed |
| `GET /api/icp`, `PUT /api/icp` | Read config, write a new version |
| `POST /api/decisions` | Record attend / watch / skip with reason |
| `GET /api/ask?intent=...` | Fixed-intent queries for the ask bar |
| `GET /calendar/:token.ics` | Stage 3. Per-user secret feed of must-attend events, revocable. |

## 8. Live radar jobs (stage 2)

- Daily cron: fetch each public event page, hash the content. If the hash changed, extract with rules first, then the model only for what rules cannot read. Write a `changes` row, update the event, re-score.
- Monthly: look for new events from the organiser and association list.
- On-demand event search across aggregators and open feeds, with cross-checking and auto-add: see `2026-10-29-event-discovery-design.md`.
- Each job writes a `runs` row with model spend. A per-run model cap applies. Two consecutive failures raise an alert.
- Public pages only, `robots.txt` respected, fetches rate-limited, nothing behind a login.

## 9. Security and compliance

- CORS allows only the user's GitHub Pages origin.
- Secrets (Google client ID, session signing key, model key) are set with `wrangler secret put` by the user. They are never written to files or chat.
- No lead data in the repo or the static files.
- Every person row carries source URL, date found and lawful basis. The case study's rules carry over: no cold email to German contacts until counsel confirms the basis.
- Calendar feed tokens are stored hashed and can be revoked.

## 10. Failure behaviour

If the API is unreachable the page shows a stale-data banner with the last-checked time. It keeps no lead data on disk. A failed refresh job never overwrites good data; it logs a `runs` error and leaves the previous event row untouched.

## 11. Testing

- Unit tests for scoring and cleaning against known results from the case study: BME Symposium scores 20 of 20; the three pushed leads score 95; the five domain-mismatch emails are rejected.
- Parser tests on saved copies of event pages.
- Worker and D1 tests using a local D1.
- UI verified in a browser at desktop and phone widths, including the reduced-motion setting.

## 12. Build stages

1. **Dashboard and data.** Worker, D1, Google sign-in, one-off import, Radar, Events table, ICP brain, Graph, Feed (showing imported data), Ask bar with fixed intents.
2. **Live radar.** Cron refresh, change detection, rules plus model extraction, new-event discovery, model-assisted ask bar.
3. **Calendar and alerts.** `.ics` subscription feed, email alerts (free-tier provider), in-page alerts, optional Google Calendar add.

## 13. Inputs needed from the user before deploy

- The GitHub repo and Pages path for the subpage.
- A Google Cloud OAuth client (basic sign-in scopes, no verification needed) and the team's email list.
- Use of the existing Cloudflare account, with secrets pasted by the user.
- CSV exports of the Sheet tabs for the import.
