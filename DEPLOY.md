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

```bash
npx wrangler d1 execute gtm-radar --remote --command "INSERT INTO users (email, name, role) VALUES ('you@yourcompany.com', 'Your Name', 'admin')"
```

Repeat for each teammate. Only these Google accounts can sign in (email matching ignores case). To remove someone, set `active` to 0: it blocks their existing sessions on their next request, not after eight hours.

## 6. Load the case-study data (you)

Export the Sheet tabs as CSV with these headers (lower case, any column order):

- events: `id,name,organiser,url,city,country,lat,lon,start_date,end_date,source_url,fit,public_names,timing,distance` (lat/lon may be blank for known cities; `last_checked` optional)
- leads: `event_id,name,title,company,domain,email,email_status,linkedin_url,role,fit,source_url` (a row with no `name` is an account-only company; a row with no `company` is skipped with a warning). `email_status` counts as verified only when it is exactly `Verified` or `valid` (any case); anything else, including `Unverified`, counts as not verified.
- Dates must be `YYYY-MM-DD`. Any other format (for example `11/18/2026`) is left blank with a warning, so check the warnings the import prints.
- vendors: `name,domain,event_id`

```bash
node scripts/import-sheet.mjs --events events.csv --leads leads.csv --vendors vendors.csv --out import.sql
npx wrangler d1 execute gtm-radar --remote --file import.sql
```

Running the import again with the same files changes nothing. If you correct the Sheet and re-import (for example adding a missing company domain or email), look at the Events drawers for a duplicated company afterwards: rows removed from the Sheet are never deleted, and a company first imported without a domain can appear twice. `/data/` and `import.sql` are git-ignored: keep lead data out of the repo.

## 7. Publish the site (you)

Push this repo to GitHub and set Settings, Pages, Source to GitHub Actions; `.github/workflows/pages.yml` publishes `site/`. All URLs are relative, so it works at `https://you.github.io/<repo>/`. To host it as a folder inside an existing Pages site instead, copy `site/` into that repo under the folder you want (for example `radar/`).

## 8. Event discovery (you)

The Find events screen searches the web and open event lists, cross-checks every match across sites, adds events listed on three or more agreeing sites, and puts the rest in a review inbox. It needs two keys. Both are Worker secrets: never put them in a file or in chat.

```bash
npx wrangler d1 migrations apply gtm-radar --remote
npx wrangler deploy
npx wrangler secret put EXA_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

- **Exa** is the search service. Create an account and an API key at exa.ai. Its public price for search with page text is about $7 per 1,000 searches, and the free tier adds $10 of credit a month. Check their pricing page.
- **Anthropic** reads the pages (`claude-haiku-5-5`, a small model). Create an API key in the Anthropic console with billing switched on.
- Until both secrets exist, Find events says "Search is not set up yet" and nothing else breaks.
- **Budgets.** A search stops at $0.50 of model spend and the team at $2 a day of model spend. Exa is billed separately and these caps do not count it: what limits Exa is "Searches per run" (12 by default, roughly 8 cents). An admin changes the caps, the topics and the model prices under Find events, Budget and topics. The model prices there are assumptions: confirm them against Anthropic's current pricing before relying on the caps. "Pause all searches" stops every search at once, and "Stop" on the search screen ends your own search on the server.
- **What it never does.** It adds nothing from a single site, nothing whose sites disagree on dates or city, and nothing it cannot quote from the page. Auto-added events can be undone from the search results until someone has decided on them.
- Cloudflare's free plan allows 10 ms of CPU and 50 database queries per request. The tests hold a search step to at most 50 queries even when it finds 10 new events, but real pages may differ. If searches fail with "Worker exceeded resource limits" or a query-limit error, the fix is the Workers Paid plan, $5 a month, which lifts both. Read per-request CPU time in the Cloudflare dashboard (Workers, `gtm-radar-api`, Metrics) after the first real search.

## Local development

```bash
cp /dev/null .dev.vars   # then add SESSION_SECRET, GOOGLE_CLIENT_ID (any value) and ALLOWED_ORIGIN=http://localhost:8080
npx wrangler d1 migrations apply gtm-radar --local   # run again after pulling: new migrations add tables
node scripts/dev-seed.mjs > .wrangler/dev-seed.sql && npx wrangler d1 execute gtm-radar --local --file .wrangler/dev-seed.sql
npm run dev:worker     # http://localhost:8787
npm run dev:site       # http://localhost:8080
node scripts/dev-token.mjs --email dev@example.test   # session for browser checks without Google
npm test
```

The dev seed uses the ten real public events with made-up people. Never import real leads into the local database you share.

## Brand files

The mark, favicon set, app icons and manifest are generated from one geometry file (`site/js/brand.js`). After changing it, run `node scripts/gen-brand.mjs` and commit the files in `site/assets/`. The product is named Krillium everywhere you can see; the folder, `package.json` and the Worker keep the working name `gtm-radar` so existing deploy names do not change.

## What is not in stage 1

Live page checks, model-assisted extraction, calendar feed and alerts arrive in stages 2 and 3 (see `docs/superpowers/specs/`).
