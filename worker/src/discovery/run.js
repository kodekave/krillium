// Search runs, advanced one planned search at a time. A step makes at most 3 outside calls (1 search plus at most 2
// model calls), so the page can drive a run with repeated requests and each one stays inside the Worker's limits.
import { cluster, siteOf } from '../../../site/js/shared/discovery.js';
import { costUsd, extractBatch } from './extract.js';
import { planSearches } from './plan.js';
import { daySpend } from './settings.js';
import { DiscoveryError, addSourcesToEvent, loadContext, reevaluate, saveGroup } from './store.js';

const ABANDONED_AFTER_MS = 15 * 60 * 1000;
const PAGES_PER_STEP = 10;
const PAGES_PER_CALL = 5;

const iso = (ms) => new Date(ms).toISOString();

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const toRun = (row) => ({
  id: row.id, status: row.status, planned: row.planned, done: row.done, pages: row.pages, modelCalls: row.model_calls,
  spendUsd: row.model_spend, note: row.note, error: row.error,
});

const toItem = (row) => ({
  outcome: row.outcome, name: row.name, url: row.url, startDate: row.start_date, city: row.city, reason: row.reason,
  candidateId: row.candidate_id, eventId: row.event_id, domains: row.domains ? JSON.parse(row.domains) : [],
});

// The same event can be reported by several steps; the page shows its latest outcome once.
function itemKey(row) {
  if (row.candidate_id) return `c:${row.candidate_id}`;
  if (row.outcome === 'tracked') return `e:${row.event_id}`;
  return `f:${row.reason}:${row.name ?? row.url}:${row.start_date}`;
}

export async function getRun(db, runId) {
  const row = await db.prepare('SELECT * FROM search_runs WHERE id = ?').bind(runId).first();
  if (!row) return null;
  const rows = (await db.prepare('SELECT * FROM run_items WHERE run_id = ? ORDER BY id').bind(runId).all()).results;
  const latest = new Map();
  for (const r of rows) latest.set(itemKey(r), r);
  return { run: toRun(row), items: [...latest.values()].map(toItem) };
}

export async function startRun(db, user, query, settings, now) {
  if (settings.paused) throw new DiscoveryError(423, 'discovery is paused');
  // A tab closed mid-run would otherwise block its owner for good.
  await db
    .prepare("UPDATE search_runs SET status = 'failed', note = 'Stopped: no activity for 15 minutes.', finished = ? WHERE created_by = ? AND status = 'running' AND datetime(started) < datetime(?)")
    .bind(iso(now), user, iso(now - ABANDONED_AFTER_MS))
    .run();
  if (await db.prepare("SELECT 1 AS busy FROM search_runs WHERE created_by = ? AND status = 'running'").bind(user).first()) {
    throw new DiscoveryError(409, 'you already have a search running');
  }
  const plan = planSearches(query, settings);
  const result = await db
    .prepare('INSERT INTO search_runs (query_json, status, created_by, started, planned) VALUES (?, ?, ?, ?, ?)')
    .bind(JSON.stringify({ query, plan }), 'running', user, iso(now), plan.length)
    .run();
  return toRun(await db.prepare('SELECT * FROM search_runs WHERE id = ?').bind(result.meta.last_row_id).first());
}

// Runs one planned search and returns what it found. A failing source or model call is noted, never thrown.
async function gather({ db, search, deps, settings, now }) {
  const out = { observations: [], unverified: [], note: null, read: 0, modelCalls: 0, spend: 0 };
  const addNote = (text) => { out.note = out.note ? `${out.note} ${text}` : text; };
  try {
    if (search.adapter === 'confs') {
      if (!deps.feeds) throw new Error('the Confs.tech feed is not set up');
      out.observations.push(...(await deps.feeds.list(search)));
      return out;
    }
    if (!deps.pages) throw new Error('search is not set up');
    const pages = (await deps.pages.search(search)).slice(0, PAGES_PER_STEP);
    out.read = pages.length;

    const fresh = [];
    for (const page of pages) {
      const urlHash = await sha256(page.url);
      const textHash = await sha256(page.text);
      const hit = await db.prepare('SELECT text_hash, extracted_json FROM page_cache WHERE url_hash = ?').bind(urlHash).first();
      if (hit && hit.text_hash === textHash && hit.extracted_json !== null) out.observations.push(...JSON.parse(hit.extracted_json));
      else fresh.push({ page, urlHash, textHash });
    }

    for (let i = 0; i < fresh.length; i += PAGES_PER_CALL) {
      const batch = fresh.slice(i, i + PAGES_PER_CALL);
      try {
        if (!deps.model) throw new Error('the model is not set up');
        const result = await extractBatch(batch.map((b) => b.page), deps.model, { topics: settings.topics, now });
        out.modelCalls += 1;
        out.spend += costUsd(result.usage, settings);
        out.observations.push(...result.observations);
        out.unverified.push(...result.dropped.filter((d) => d.reason.startsWith('no verified')));
        await db.batch(
          batch.map(({ page, urlHash, textHash }) =>
            db
              .prepare(
                `INSERT INTO page_cache (url_hash, url, fetched_at, text_hash, extracted_json) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (url_hash) DO UPDATE SET fetched_at = excluded.fetched_at, text_hash = excluded.text_hash, extracted_json = excluded.extracted_json`,
              )
              .bind(urlHash, page.url, iso(now), textHash, JSON.stringify(result.observations.filter((o) => o.url === page.url))),
          ),
        );
      } catch (e) {
        addNote(`model failed: ${e.message}`);
      }
    }
  } catch (e) {
    addNote(`${search.adapter} failed: ${e.message}`);
  }
  return out;
}

const itemRow = (partial) => ({ name: null, url: null, startDate: null, city: null, reason: null, candidateId: null, eventId: null, domains: [], ...partial });

// Clusters what a step found, saves it, and describes every outcome, including what was filtered out and why.
async function record({ db, observations, unverified, now }) {
  const context = await loadContext(db);
  const { groups, tracked, filtered } = cluster(observations, { existing: context.existing, rejected: context.rejected, now });
  const items = [];

  for (const group of groups) {
    const saved = await saveGroup(db, group, now);
    if (saved.status === 'rejected') {
      items.push(itemRow({ outcome: 'filtered', name: group.name, url: group.observations[0]?.url, startDate: group.startDate, city: group.city, reason: 'rejected', candidateId: saved.candidateId }));
      continue;
    }
    const result = await reevaluate(db, saved.candidateId, now);
    const shown = result.group ?? group;
    items.push(itemRow({
      outcome: result.status === 'auto_added' ? 'auto_added' : result.status === 'inbox' ? 'inbox' : 'tracked',
      name: shown.name, url: shown.observations[0]?.url, startDate: shown.startDate, city: shown.city,
      reason: result.status === 'inbox' ? result.reason : null, candidateId: saved.candidateId, eventId: result.eventId ?? null, domains: shown.domains,
    }));
  }
  for (const entry of tracked) {
    await addSourcesToEvent(db, entry.eventId, entry.observations, now);
    const first = entry.observations[0];
    items.push(itemRow({ outcome: 'tracked', name: first.name, url: first.url, startDate: first.startDate, city: first.city, eventId: entry.eventId, domains: [...new Set(entry.observations.map(siteOf))] }));
  }
  for (const { observation, reason } of filtered) {
    items.push(itemRow({ outcome: 'filtered', name: observation.name, url: observation.url, startDate: observation.startDate, city: observation.city, reason }));
  }
  for (const dropped of unverified) items.push(itemRow({ outcome: 'filtered', url: dropped.url, reason: 'unverified' }));
  return items;
}

export async function stepRun({ db, runId, deps, settings, now }) {
  const row = await db.prepare('SELECT * FROM search_runs WHERE id = ?').bind(runId).first();
  if (!row) return null;
  if (row.status !== 'running') return getRun(db, runId);

  const stop = async (status, text) => {
    const note = [row.note, text].filter(Boolean).join(' ') || null;
    await db.prepare("UPDATE search_runs SET status = ?, note = ?, finished = ? WHERE id = ? AND status = 'running'").bind(status, note, iso(now), runId).run();
    return getRun(db, runId);
  };
  if (settings.paused) return stop('paused', 'Discovery is paused.');
  if (row.done >= row.planned) return stop('done', null);

  let cap = null;
  if (row.model_spend >= settings.runCapUsd) cap = 'run budget';
  else if ((await daySpend(db, now)) >= settings.dayCapUsd) cap = 'daily budget';
  else if (row.pages >= settings.maxPages) cap = 'page limit';
  if (cap) return stop('capped', `Budget reached: ${cap}.`);

  // Only one caller can claim a given step; the other returns the run as it stands.
  const claim = await db.prepare("UPDATE search_runs SET done = done + 1 WHERE id = ? AND done = ? AND status = 'running'").bind(runId, row.done).run();
  if (claim.meta.changes !== 1) return getRun(db, runId);

  try {
    const search = JSON.parse(row.query_json).plan[row.done];
    const out = await gather({ db, search, deps, settings, now });
    const items = await record({ db, observations: out.observations, unverified: out.unverified, now });
    const statements = items.map((i) =>
      db
        .prepare('INSERT INTO run_items (run_id, outcome, candidate_id, event_id, name, url, start_date, city, reason, domains) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(runId, i.outcome, i.candidateId, i.eventId, i.name, i.url, i.startDate, i.city, i.reason, JSON.stringify(i.domains)),
    );
    statements.push(
      db
        .prepare(
          `UPDATE search_runs SET pages = pages + ?, model_calls = model_calls + ?, model_spend = model_spend + ?,
             note = CASE WHEN ? IS NULL THEN note WHEN note IS NULL THEN ? ELSE note || ' ' || ? END,
             finished = CASE WHEN status = 'running' AND done >= planned THEN ? ELSE finished END,
             status = CASE WHEN status = 'running' AND done >= planned THEN 'done' ELSE status END
           WHERE id = ?`,
        )
        .bind(out.read, out.modelCalls, out.spend, out.note, out.note, out.note, iso(now), runId),
    );
    await db.batch(statements);
  } catch (e) {
    console.error(e);
    await db.prepare("UPDATE search_runs SET status = 'failed', error = ?, finished = ? WHERE id = ? AND status = 'running'").bind(String(e?.message ?? e).slice(0, 300), iso(now), runId).run();
  }
  return getRun(db, runId);
}
