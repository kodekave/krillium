# Deploying Krillium (stage 1)

The site is static files in `site/` (GitHub Pages). The data lives behind a Cloudflare Worker with a D1 database. Steps marked **you** involve your accounts or secrets: I do not run them, and secrets never go in files or chat.

## 1. Cloudflare Worker and database (you)

```bash
npx wrangler login
npx wrangler d1 create gtm-radar
```

Paste the printed `database_id` into `wrangler.toml` (replace `local-dev-placeholder`), then:

```bash
npx wrangler d1 migrations apply gtm-radar --remote
```

## 2. Google sign-in (you)

In Google Cloud Console, create a project, then APIs & Services, Credentials, Create credentials, OAuth client ID, type Web application. Under Authorised JavaScript origins add your Pages origin (for example `https://yourname.github.io`, no path) and `http://localhost:8080` for local work. Basic sign-in scopes need no Google verification. Copy the client ID (it is public).

## 3. Secrets and origin (you)

```bash
openssl rand -hex 32          # copy the output for SESSION_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put SESSION_SECRET
```

Wrangler prompts for each value; paste it there. In `wrangler.toml` set `ALLOWED_ORIGIN` to your exact Pages origin (scheme and host, no path, no trailing slash). Then:

```bash
npx wrangler deploy
```

## 4. Point the site at the Worker (you)

Edit `site/config.js`: set `apiBase` to the Worker URL printed by `wrangler deploy` and `googleClientId` to the client ID. Optionally set `cockpitUrl` to your lead cockpit link (it is shown in the event drawer). These are public values.

## 5. Add your team (you)

Everyone belongs to one workspace. Strangers who sign in ask for a workspace of their own and wait for your approval (section 9). To put a teammate into an existing workspace yourself, name its id (`1` is the first workspace, made by the migration):

```bash
npx wrangler d1 execute gtm-radar --remote --command "INSERT INTO users (email, name, role, workspace_id) VALUES ('you@yourcompany.com', 'Your Name', 'admin', 1)"
```

Repeat for each teammate. Email matching ignores case. To remove someone, set `active` to 0: it blocks their existing sessions on their next request, not after eight hours.

## 6. Load the case-study data (you)

Export the Sheet tabs as CSV with these headers (lower case, any column order):

- events: `id,name,organiser,url,city,country,lat,lon,start_date,end_date,source_url,fit,public_names,timing,distance` (lat/lon may be blank for known cities; `last_checked` optional)
- leads: `event_id,name,title,company,domain,email,email_status,linkedin_url,role,fit,source_url` (a row with no `name` is an account-only company; a row with no `company` is skipped with a warning). `email_status` counts as verified only when it is exactly `Verified` or `valid` (any case); anything else, including `Unverified`, counts as not verified.
- Dates must be `YYYY-MM-DD`. Any other format (for example `11/18/2026`) is left blank with a warning, so check the warnings the import prints.
- vendors: `name,domain,event_id`

```bash
node scripts/import-sheet.mjs --events events.csv --leads leads.csv --vendors vendors.csv --workspace 1 --out import.sql
npx wrangler d1 execute gtm-radar --remote --file import.sql
```

`--workspace` is the id of the workspace that should own the rows (default 1); the import never touches another workspace's data.

Running the import again with the same files changes nothing. If you correct the Sheet and re-import (for example adding a missing company domain or email), look at the Events drawers for a duplicated company afterwards: rows removed from the Sheet are never deleted, and a company first imported without a domain can appear twice. `/data/` and `import.sql` are git-ignored: keep lead data out of the repo.

## 7. Publish the site (you)

Push this repo to GitHub and set Settings, Pages, Source to GitHub Actions; `.github/workflows/pages.yml` publishes `site/`. All URLs are relative, so it works at `https://you.github.io/<repo>/`. To host it as a folder inside an existing Pages site instead, copy `site/` into that repo under the folder you want (for example `radar/`).

## 8. Event discovery (you)

The Find events screen searches the web and open event lists, cross-checks every match across sites, adds events listed on three or more agreeing sites, and puts the rest in a review inbox. One key switches it on and a second is an optional upgrade. Both are Worker secrets: never put them in a file or in chat.

```bash
npx wrangler d1 migrations apply gtm-radar --remote
npx wrangler deploy
npx wrangler secret put EXA_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY   # optional
```

- **Exa** (required) searches the web and, by default, also reads each page and returns the event's facts, so one key is enough. Create an account and an API key at exa.ai. Its public prices are about $7 per 1,000 searches plus $1 per 1,000 pages for page text and $1 per 1,000 pages for summaries, so about 3 cents for a search of 10 pages, and new accounts get $10 of credit. Check their pricing page.
- **Anthropic** (optional) makes Claude (`claude-haiku-5-5`, a small model) read the pages instead of Exa. The checks on what it says are the same either way. Entering the key switches over: Exa is then no longer asked for summaries, which saves part of its price, and Claude's cost is added. Removing the secret goes back to Exa alone. Create an API key in the Anthropic console with billing switched on.
- Until the Exa secret exists, Find events says "Search is not set up yet" and nothing else breaks. An Anthropic key without an Exa key does not switch search on, because Claude cannot search the web. Find events shows which of the two is reading the pages under Budget.
- **Sectors.** What it searches for is a list of sectors (procurement, finance operations, pharma, manufacturing and banking to start), each with a few topic phrases. An admin edits them in the ICP brain, in the Sectors card, which has its own Save. Search ticks every sector by default; "Fill the map" runs one search per ticked sector in turn, so each gets the full search budget (about 32 cents with Exa alone, so five sectors come to about $1.60 of the $2 daily cap). An event is tagged with the sectors whose topics its page mentions, plus the sector of a one-sector search, and the Radar and Events screens can filter by sector. Migration 0003 adds the sector columns and files the imported case-study events under procurement.
- **Budgets.** A search stops at $0.50 of spend and the team at $2 a day. Spend is the cost Exa reports for each search, plus Claude's cost when an Anthropic key is set; "Searches per run" (12 by default, roughly 32 cents with Exa alone) limits how many searches a run makes. An admin changes the caps and the Claude prices under Find events, Budget. The Claude prices there are assumptions: confirm them against Anthropic's current pricing before relying on the caps. "Pause all searches" stops every search at once, and "Stop" on the search screen ends your own search on the server.
- **What it never does.** It adds nothing from a single site, nothing whose sites disagree on dates or city, and nothing it cannot quote from the page. Auto-added events can be undone from the search results until someone has decided on them.
- Cloudflare's free plan allows 10 ms of CPU and 50 database queries per request. The tests hold a search step to at most 50 queries even when it finds 10 new events, but real pages may differ. If searches fail with "Worker exceeded resource limits" or a query-limit error, the fix is the Workers Paid plan, $5 a month, which lifts both. Read per-request CPU time in the Cloudflare dashboard (Workers, `gtm-radar-api`, Metrics) after the first real search.

## 9. Workspaces (you)

Every person who signs in belongs to a private workspace: their own events, companies, people, ICP (ideal customer profile), sectors, search runs, budgets and memory. Nobody can read or change another workspace's data, and the database itself refuses a row that points into another workspace. Memory is an append-only log of what a workspace decides and does (events chosen or skipped, inbox approvals and rejections, ICP and sector saves, finished searches); it starts on the workspace's first day, holds no names or emails of leads, and is shown on the ICP brain screen.

- **You are the operator.** Set it once, for your own account, by SQL (nothing is hardcoded):

  ```bash
  npx wrangler d1 execute gtm-radar --remote --command "UPDATE users SET operator = 1 WHERE email = 'you@yourcompany.com'"
  ```

  The operator gets a **Workspaces** item in the navigation. Strangers who sign in with Google create a workspace that waits there; **Approve** lets them in, **Decline** or **Suspend** switches a workspace off (it takes effect on that person's next request, not after eight hours). There is no email when someone asks: open the screen. At most 50 requests can wait at once; beyond that, sign-up says it is closed.
- **Shared keys.** The Exa and Anthropic secrets from section 8 are yours. A workspace may use them only if you tick **Shared keys** on its row; workspace 1 has it on. Without it, Find events tells that workspace it needs its own key (per-workspace keys are the next piece of work).
- **Google sign-in for strangers.** While the consent screen in Google Cloud is in Testing, only the Google accounts listed there (up to 100) can sign in at all, so a stranger cannot even ask for a workspace. Either add each person as a test user first, then approve them here, or publish the consent screen. The sign-in uses only the basic scopes (openid, email, profile); I believe Google needs no verification review for those but have not confirmed it, and it may ask for a homepage and a privacy-policy page, which would need your review.
- **Sample events.** A new workspace is empty. Its first screen offers to set sectors, load the ten public sample events, or find events.

### Putting workspaces on the live database

The change is two migrations, `0004` (adds the workspace tables and columns) and `0005` (rebuilds the tables with composite keys). Apply them together and deploy the Worker straight after: the Worker from before this change cannot write once `0005` is applied (it reads fine). Nothing here has been run against the live database yet. In this order:

1. **Rehearse on a copy of the live data.** `npx wrangler d1 export gtm-radar --remote --output .wrangler/live-export.sql` (this is real data: the file stays in the git-ignored `.wrangler` folder), load it into a scratch local database (`npx wrangler d1 execute gtm-radar --local --persist-to .wrangler/rehearsal --file .wrangler/live-export.sql`), apply the migrations there (`npx wrangler d1 migrations apply gtm-radar --local --persist-to .wrangler/rehearsal`), and compare row counts table by table. The two migrations ran cleanly through wrangler's own runner on the seeded local development database (data intact, `foreign_key_check` empty), but that is the same SQLite engine, not the live D1 service, and the export-and-reload path above has not been tried: this step is the real check.
2. **Note the restore point:** `npx wrangler d1 time-travel info gtm-radar`. Keep the bookmark it prints.
3. **Apply both migrations:** `npx wrangler d1 migrations apply gtm-radar --remote`, then `npx wrangler deploy` at once.
4. **Set yourself as operator** (SQL above).
5. **Push the site** (`git push origin main` publishes the Pages build with the waiting message and the Workspaces screen). Between steps 3 and 5 an existing person signs in as before; a stranger would see a confusing screen, so do not leave a gap.
6. **Decide on the Google consent screen** (above).

To go back, restore the bookmark from step 2 (`npx wrangler d1 time-travel restore gtm-radar --bookmark <the bookmark>`) and redeploy the previous Worker.

## Local development

```bash
cp /dev/null .dev.vars   # then add SESSION_SECRET, GOOGLE_CLIENT_ID (any value) and ALLOWED_ORIGIN=http://localhost:8080
npx wrangler d1 migrations apply gtm-radar --local   # run again after pulling: new migrations add tables
node scripts/dev-seed.mjs > .wrangler/dev-seed.sql && npx wrangler d1 execute gtm-radar --local --file .wrangler/dev-seed.sql
npx wrangler d1 execute gtm-radar --local --command "UPDATE users SET operator = 1 WHERE email = 'dev@example.test'"   # the seed's INSERT leaves an existing dev user as it was
npm run dev:worker     # http://localhost:8787
npm run dev:site       # http://localhost:8080
node scripts/dev-token.mjs --email dev@example.test --operator   # session for browser checks without Google (see the Workspaces screen)
node scripts/dev-token.mjs --email other@example.test --workspace 2   # the second workspace's admin: no Workspaces item
npm test
```

The dev seed uses the ten real public events with made-up people in workspace 1, a dev user who is the operator, and an empty second workspace with its own admin (`other@example.test`), so local checks can see one workspace never showing another's data. Never import real leads into the local database you share.

## Brand files

The mark, favicon set, app icons and manifest are generated from one geometry file (`site/js/brand.js`). After changing it, run `node scripts/gen-brand.mjs` and commit the files in `site/assets/`. The product is named Krillium everywhere you can see; the folder, `package.json` and the Worker keep the working name `gtm-radar` so existing deploy names do not change.

## What is not in stage 1

Live page checks, model-assisted extraction, calendar feed and alerts arrive in stages 2 and 3 (see `docs/superpowers/specs/`).
