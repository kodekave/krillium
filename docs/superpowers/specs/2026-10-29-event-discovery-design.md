# Krillium event discovery: design

Status: approved in conversation on 2026-10-29, awaiting written-spec review. Extends stage 2 of `2026-10-29-gtm-radar-design.md` (section 8, "new-event discovery").

## 1. Goal

Let a signed-in teammate search for B2B events from inside Krillium. The Worker queries several sources, reads the matching pages, cross-checks them against each other and against the events already tracked, filters out noise, and adds the events that pass. No manual export and import.

What the user asked for: "search events within this console, and all the data gets imported from [many] aggregators that can cross-check and filter out."

## 2. What the research changed

No large B2B aggregator offers a free search API. Eventbrite closed public event search in 2019; 10times has no official API; Luma has no official discovery API; Ticketmaster Discovery has a free key but covers concerts and sport; PredictHQ's free plan covers 2 saved locations. "Connect 20 to 50 aggregators, each by API" is therefore not buildable. The design reaches the same breadth through a search API that returns page text, plus structured feeds where they exist.

## 3. Decisions made with the user

| Topic | Decision |
|---|---|
| Source kinds in v1 | Search discovery with model extraction, and structured feeds. Scraper vendors are out. |
| Import rule | Auto-add when 3 or more distinct sites list the event and agree on dates and city. Everything else goes to a review inbox. |
| Organiser-site requirement | Rejected by the user. Any 3 agreeing sites count. |
| Search API | Exa (search with page text). |
| Structured feed | Confs.tech open data. PredictHQ is deferred. |
| Extraction model | A Haiku-class model, capped per run and per day. |
| Execution | Client-driven stepping, so no queue or paid plan is needed to start. |

## 4. Flow

1. The user opens "Find events" (or Cmd+K) and enters a query with filters: date range (default next 12 months), region, topics (default: the ICP's topics).
2. `POST /api/search` creates a `search_runs` row and plans a handful of searches per source.
3. The page calls `POST /api/search/:id/step` repeatedly. Each step does a small slice (at most 3 outside calls) and returns progress.
4. For each search result: extract a candidate (section 7), normalise, cluster (section 5), filter, decide.
5. The run ends when all planned searches are done or a cap is hit. The page shows the grouped results.

## 5. Cross-check and decision rules

- **Cluster key:** normalised name tokens (lower case, accents folded, years and common words such as "annual" and "summit" removed), start date within 1 day, and city or country. Names match when their token sets have a Jaccard overlap of at least 0.6 after normalisation, not on exact equality.
- **Existing events first:** a candidate that matches a tracked event adds a source to that event and creates nothing new.
- **Distinct sites:** counted by registrable domain, so two subdomains of one site count once.
- **Agreement:** all sources in a cluster must agree on start date (within 1 day) and on city or, failing that, country. A disagreement sets `conflict` and forces the inbox. A source that does not state a field (for example no city) does not disagree, but at least one source in the cluster must state a start date and a city or country for the cluster to be auto-added.
- **Auto-add:** 3 or more distinct domains, no conflict, a start date in the future, and a resolvable location. Otherwise the cluster is a candidate with status `inbox`.
- **Filters:** drop past events, events marked cancelled, online-only events, and consumer entertainment (concerts, sport, festivals). Dropped items are kept in the run result with a reason so nothing disappears silently.
- **Rejections:** a rejected cluster is stored by name key and start date and never returns to the inbox or auto-add.
- **Suggested score** for a promoted event, on the existing 0 to 5 scales: fit from topic match against the ICP, public_names 0 until a lineup is read, timing from days until the event, distance from the nearest home base. The UI marks these as suggested.
- **Auto-added events** carry `origin = 'discovered'`, `auto_added = 1`, a `changes` row listing the sources, and a one-click undo that removes the event and records a rejection.

## 6. Data model (migration `0002_discovery.sql`)

| Table | Columns |
|---|---|
| `search_runs` | id, query_json, status, created_by, started, finished, planned, done, pages, model_calls, model_spend, note, error |
| `candidates` | id, cluster_key, name, organiser, city, country, lat, lon, start_date, end_date, topic_score, status (`inbox`, `auto_added`, `approved`, `rejected`), conflict, event_id, first_seen, last_seen |
| `candidate_sources` | id, candidate_id, domain, url, adapter, title, found_start, found_end, found_city, quote, fetched_at; unique on (candidate_id, url) |
| `rejections` | name_key, start_date, by, at; primary key on (name_key, start_date) |
| `page_cache` | url_hash (primary key), url, fetched_at, text_hash, extracted_json. Holds no page text. |
| `event_sources` | event_id, url, domain, adapter, added_at |
| `events` (altered) | adds `origin TEXT DEFAULT 'import'` and `auto_added INTEGER DEFAULT 0` |
| `settings` | key, value. Holds `discovery_paused`, `run_cap_usd`, `day_cap_usd`, `max_searches`, `max_pages`. |

Writes that promote a candidate to an event run as one D1 batch, so a failed step never leaves a half-created event.

## 7. Sources and extraction

- **Adapter interface:** `search(query, filters) -> [{url, title, text, publishedAt?}]` for page sources, `list(filters) -> [candidate]` for structured feeds. Adapters live in `worker/src/discovery/adapters/`.
- **Exa adapter:** one call per planned search, with contents, date filters and the aggregator and organiser domains as hints. Its text is the extraction input, so there is no third-party page fetching.
- **Confs.tech adapter:** reads the open dataset and returns candidates directly. Counts as one source like any other.
- **Extraction:** a Haiku-class model, given the first 3,000 characters of a page, returns strict JSON: name, organiser, start and end dates, city, country, online-only flag, cancelled flag, and for each of name, dates and city a short supporting quote.
- **Verification:** each quote must appear in the page text (case and whitespace folded) and the field must be consistent with it. A field that fails is dropped. A candidate missing name or start date is dropped. URLs come only from search results, never from model output.
- **Data kept:** facts and quotes of at most 200 characters. No page copies are stored.
- **People are out of scope.** This feature extracts events only. Speaker and attendee extraction stays in the stage 2 live-page job.

## 8. API (all require a signed-in team member)

| Route | Purpose |
|---|---|
| `POST /api/search` | Start a run. One active run per user. |
| `GET /api/search/:id` | Progress and grouped results. |
| `POST /api/search/:id/step` | Do the next slice. Safe to repeat: candidates and sources upsert on their unique keys. |
| `GET /api/inbox` | Candidates with status `inbox`, with sources and conflicts. |
| `POST /api/inbox/:id/approve` | Promote to an event (suggested score), status `approved`. |
| `POST /api/inbox/:id/reject` | Mark rejected and record the rejection. |
| `POST /api/events/:id/undo-auto-add` | Remove an auto-added event and record a rejection. |
| `GET` and `PUT /api/discovery/settings` | Caps and the pause switch. Admin only for `PUT`. |

## 9. Screens

- **Find events panel:** query box, date, region and topic filters, live progress ("14 pages read, 6 matches").
- **Results groups:** Auto-added (with undo), Needs review, Already tracked (new source chips), Filtered out (collapsed, with a reason per item).
- **Inbox:** a nav item with a count badge. Each card shows name, dates, city, source chips that link out, the conflict flag, the suggested score breakdown, and Approve and Reject.
- **Map:** discovered events get a distinct ring until approved or confirmed by a later live check.
- **Ask bar:** a "find events about X in Y" intent that opens the panel with the query filled in.
- Empty, loading, error and budget-reached states are designed, in the existing brand style.

## 10. Cost, caps and secrets

- **Default caps:** 12 searches, 120 pages and $0.50 per run; $2 per day across the team. Editable by an admin. Reaching a cap ends the run with a "budget reached" note and keeps what it found.
- **Spend** is recorded per run. An admin pause switch stops all discovery immediately.
- **Secrets:** `EXA_API_KEY` and `ANTHROPIC_API_KEY`, set by the user with `wrangler secret put`. They never appear in files or chat. If a key is missing, the panel says discovery is not set up, and nothing else breaks.
- **Privacy:** Exa receives only the search query. The model receives only public page text. No lead or contact data is sent to either.

## 11. Platform limits

Cloudflare's free plan allows 50 outside calls and 10 ms of CPU per request. Stepping keeps requests small. If measurement during the build shows clustering and parsing exceeding 10 ms, the fix is the Workers Paid plan ($5 a month), with no design change.

## 12. Error handling

- A search source failing marks that search failed and the run continues with the rest; the run note says which source failed.
- A model failure or malformed model answer skips that page and counts it.
- A repeated or out-of-order step never duplicates data.
- A failed run never changes existing events.
- Stale-data and sign-in expiry behave as in stage 1.

## 13. Testing

Shared pure modules (`site/js/shared/discovery.js`: name normalisation, cluster key, agreement check, decision, filters) get unit tests. Worker tests use a fake Exa and a fake model passed in through the handler. Guard tests:

1. A cluster with disagreeing dates or cities never auto-adds.
2. Exactly 2 distinct domains stays in the inbox; 3 distinct domains with agreement auto-adds; two subdomains of one site count once.
3. A rejected event never returns, from search or from a feed.
4. A model answer whose quote is not in the page text is dropped.
5. Past, cancelled, online-only and entertainment candidates are filtered, with a reason.
6. A candidate matching a tracked event adds a source and creates no duplicate.
7. Reaching the run cap or the day cap stops the run and keeps earlier results.
8. The pause switch stops steps.
9. Repeating a step creates no duplicate candidates or sources.
10. Every route returns 401 without a session, and settings writes return 403 for non-admins.
11. Auto-add and undo are atomic and leave a `changes` row.

## 14. Build order

1. Migration, shared matching logic, inbox, approve, reject and undo API.
2. Exa and Confs.tech adapters, extraction with verification, and the stepping search endpoint.
3. Find events panel, Inbox screen, map styling, ask-bar intent.

## 15. Out of scope

Scheduled and saved searches and alerts (stage 3), speaker and attendee extraction (stage 2 live checks), scraper vendors, PredictHQ, and any change to how lead scores are computed.
