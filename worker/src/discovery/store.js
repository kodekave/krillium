// Candidate store: saves what searches found, decides when an event may be added without review, and handles
// approve, reject and undo. Writes that change the event list are one db.batch, so a failure leaves nothing half-done.
// A candidate is claimed (status 'promoting') before it becomes an event, so two people or two runs cannot both
// create it, and a rejection and an auto-add cannot both win. Statements are few and wide (multi-row inserts) because
// the free plan allows 50 database queries per request.
import { AGGREGATOR_DOMAINS, buildGroup, decide, sameEdition, siteOf } from '../../../site/js/shared/discovery.js';
import { coordsForCity } from '../../../site/js/shared/cities.js';
import { nameKey, slugify } from '../../../site/js/shared/names.js';
import { suggestScore } from '../../../site/js/shared/suggest.js';
import { getActiveConfig } from '../db.js';

export class DiscoveryError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DiscoveryError';
    this.status = status;
  }
}

const MAX_QUOTE = 200;
const SOURCE_ROWS_PER_STATEMENT = 9; // 10 bound values per row; D1 allows 100 per statement
const EVENT_SOURCE_ROWS_PER_STATEMENT = 19; // 5 bound values per row

const iso = (ms) => new Date(ms).toISOString();
const quoteOf = (obs) => String(obs.quotes?.dates ?? obs.quotes?.name ?? '').slice(0, MAX_QUOTE) || null;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function loadContext(db) {
  const events = (await db.prepare('SELECT id, name, start_date, city, country FROM events').all()).results;
  const rejections = (await db.prepare('SELECT name_key, start_date FROM rejections').all()).results;
  return {
    existing: events.map((e) => ({ id: e.id, name: e.name, startDate: e.start_date, city: e.city, country: e.country })),
    rejected: new Set(rejections.map((r) => `${r.name_key}|${r.start_date}`)),
  };
}

const loadCandidate = (db, id) => db.prepare('SELECT * FROM candidates WHERE id = ?').bind(id).first();
const loadSources = async (db, id) => (await db.prepare('SELECT * FROM candidate_sources WHERE candidate_id = ? ORDER BY id').bind(id).all()).results;
const loadRows = async (db) => (await db.prepare('SELECT * FROM candidates').all()).results;

// Rebuilds the group from everything stored, so evidence gathered across runs counts together. A source that did
// not state a city stays without one rather than borrowing the candidate's.
function groupFromRows(candidate, sources) {
  return buildGroup(
    sources.map((s) => ({
      name: candidate.name, organiser: candidate.organiser, startDate: s.found_start ?? candidate.start_date, endDate: s.found_end,
      city: s.found_city, country: candidate.country, online: false, cancelled: false, url: s.url, sourceDomain: s.domain,
      adapter: s.adapter, title: s.title, quotes: { dates: s.quote }, topicHits: candidate.topic_hits,
    })),
  );
}

const asRef = (r) => ({ name: r.name, startDate: r.start_date, city: r.city, country: r.country });

// The candidate that already stands for this event, preferring one still waiting in the inbox.
function findMatch(rows, group) {
  const probe = { name: group.name, startDate: group.startDate, city: group.city, country: group.country };
  const matches = rows.filter((r) => sameEdition(probe, asRef(r)));
  return matches.find((r) => r.status === 'inbox') ?? matches[0];
}

async function upsertSources(db, candidateId, observations, stamp) {
  const seen = new Set();
  const unique = observations.filter((o) => o.url && !seen.has(o.url) && seen.add(o.url));
  for (const rows of chunks(unique, SOURCE_ROWS_PER_STATEMENT)) {
    await db
      .prepare(
        `INSERT INTO candidate_sources (candidate_id, domain, url, adapter, title, found_start, found_end, found_city, quote, fetched_at)
         VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT (candidate_id, url) DO UPDATE SET domain = excluded.domain, adapter = excluded.adapter, title = excluded.title,
           found_start = excluded.found_start, found_end = excluded.found_end, found_city = excluded.found_city,
           quote = excluded.quote, fetched_at = excluded.fetched_at`,
      )
      .bind(...rows.flatMap((o) => [candidateId, siteOf(o), o.url, o.adapter ?? 'unknown', o.title ?? null, o.startDate ?? null, o.endDate ?? null, o.city ?? null, quoteOf(o), stamp]))
      .run();
  }
}

// Creates the candidate for a new event. If another writer created it a moment earlier, the insert is ignored and
// that candidate is returned instead, so two runs finding the same event never fail on the unique key.
async function createCandidate(db, rows, group, stamp) {
  const [lat, lon] = coordsForCity(group.city);
  const topicHits = Math.max(0, ...group.observations.map((o) => o.topicHits ?? 0));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const used = new Set(rows.map((r) => r.cluster_key));
    let key = group.key;
    for (let n = 2; used.has(key); n += 1) key = `${group.key}|${n}`;
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO candidates (cluster_key, name, organiser, city, country, lat, lon, start_date, end_date, topic_hits, status, conflict, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?)`,
      )
      .bind(key, group.name, group.organiser, group.city, group.country, lat, lon, group.startDate, group.endDate, topicHits, group.conflict, stamp, stamp)
      .run();
    if (result.meta.changes === 1) {
      const row = {
        id: result.meta.last_row_id, cluster_key: key, name: group.name, organiser: group.organiser, city: group.city, country: group.country,
        lat, lon, start_date: group.startDate, end_date: group.endDate, topic_hits: topicHits, status: 'inbox', conflict: group.conflict, event_id: null,
      };
      rows.push(row);
      return { created: row };
    }
    rows.splice(0, rows.length, ...(await loadRows(db)));
    const hit = findMatch(rows, group);
    if (hit) return { existing: hit };
  }
  throw new Error('could not save the candidate');
}

// Puts a group with its candidate: an existing one gets the new sources, a new one is created. `rows` is the
// candidate list, loaded once by the caller and kept up to date here.
async function placeGroup(db, rows, group, stamp) {
  let row = findMatch(rows, group);
  let created = false;
  if (!row) {
    const made = await createCandidate(db, rows, group, stamp);
    created = Boolean(made.created);
    row = made.created ?? made.existing;
  }
  if (row.status !== 'inbox') return { row, created: false, terminal: true };
  if (!created) {
    const topicHits = Math.max(0, ...group.observations.map((o) => o.topicHits ?? 0));
    await db.prepare('UPDATE candidates SET topic_hits = MAX(topic_hits, ?), last_seen = ? WHERE id = ?').bind(topicHits, stamp, row.id).run();
    row.topic_hits = Math.max(row.topic_hits ?? 0, topicHits);
  }
  await upsertSources(db, row.id, group.observations, stamp);
  return { row, created, terminal: false };
}

export async function saveGroup(db, group, now) {
  const placed = await placeGroup(db, await loadRows(db), group, iso(now));
  return { candidateId: placed.row.id, status: placed.terminal ? placed.row.status : 'inbox' };
}

const claim = async (db, id) => (await db.prepare("UPDATE candidates SET status = 'promoting' WHERE id = ? AND status = 'inbox'").bind(id).run()).meta.changes === 1;
const release = (db, id) => db.prepare("UPDATE candidates SET status = 'inbox' WHERE id = ? AND status = 'promoting'").bind(id).run();

// Turns a claimed candidate into an event, in one batch. If the batch fails the claim is given back.
async function promote(db, candidate, group, { auto, user, now }) {
  const stamp = iso(now);
  const cfg = await getActiveConfig(db);
  const [lat, lon] = coordsForCity(group.city);
  const score = suggestScore({ topicHits: candidate.topic_hits, startDate: group.startDate, lat, lon }, { homeBases: cfg.homeBases, now });
  const id = await freeEventId(db, `${slugify(group.name)}-${group.startDate.slice(0, 7)}`);

  const seen = new Set();
  const sources = group.observations
    .filter((o) => o.url && !seen.has(o.url) && seen.add(o.url))
    .map((o) => ({ url: o.url, domain: siteOf(o), adapter: o.adapter ?? null }));
  const url = (sources.find((s) => !AGGREGATOR_DOMAINS.includes(s.domain)) ?? sources[0])?.url ?? null;
  const sites = group.domains.join(', ');
  const summary = auto ? `Found on ${group.domains.length} sites: ${sites}` : `Approved from the inbox by ${user}: ${sites}`;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO events (id, name, organiser, url, city, country, lat, lon, start_date, end_date, source_url, last_checked,
             fit, public_names, timing, distance, origin, auto_added)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'discovered', ?)`,
        )
        .bind(id, group.name, group.organiser, url, group.city, group.country, lat, lon, group.startDate, group.endDate, url, score.fit, score.public_names, score.timing, score.distance, auto ? 1 : 0),
      ...chunks(sources, EVENT_SOURCE_ROWS_PER_STATEMENT).map((rows) =>
        db
          .prepare(`INSERT OR IGNORE INTO event_sources (event_id, url, domain, adapter, added_at) VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
          .bind(...rows.flatMap((s) => [id, s.url, s.domain, s.adapter, stamp])),
      ),
      db.prepare("INSERT INTO changes (event_id, kind, summary, source_url, at) VALUES (?, 'new_event', ?, ?, ?)").bind(id, summary, url, stamp),
      db.prepare('UPDATE candidates SET status = ?, event_id = ?, last_seen = ? WHERE id = ?').bind(auto ? 'auto_added' : 'approved', id, stamp, candidate.id),
    ]);
  } catch (e) {
    await release(db, candidate.id);
    throw e;
  }
  return id;
}

async function freeEventId(db, base) {
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await db.prepare('SELECT 1 AS taken FROM events WHERE id = ?').bind(id).first())) return id;
  }
}

// Decides a group's candidate: the auto-add rule, and if it passes, claim then promote. Someone else may have
// handled the candidate in the meantime; then its current state is reported and nothing is created.
async function evaluate(db, candidate, group, now) {
  const verdict = decide(group, now);
  if (verdict.action !== 'auto_add') return { status: 'inbox', reason: verdict.reason, group };
  if (!(await claim(db, candidate.id))) {
    const current = await loadCandidate(db, candidate.id);
    return { status: current.status, eventId: current.event_id ?? undefined };
  }
  const eventId = await promote(db, candidate, group, { auto: true, user: 'discovery', now });
  return { status: 'auto_added', eventId, reason: verdict.reason, group };
}

async function refreshFields(db, candidateId, group, stamp) {
  const [lat, lon] = coordsForCity(group.city);
  await db
    .prepare('UPDATE candidates SET start_date = ?, end_date = ?, city = ?, country = ?, lat = ?, lon = ?, conflict = ?, last_seen = ? WHERE id = ?')
    .bind(group.startDate, group.endDate, group.city, group.country, lat, lon, group.conflict, stamp, candidateId)
    .run();
}

export async function reevaluate(db, candidateId, now) {
  const candidate = await loadCandidate(db, candidateId);
  if (!candidate) throw new DiscoveryError(404, 'candidate not found');
  if (candidate.status !== 'inbox') return { status: candidate.status, eventId: candidate.event_id ?? undefined };
  const group = groupFromRows(candidate, await loadSources(db, candidateId));
  await refreshFields(db, candidateId, group, iso(now));
  return evaluate(db, candidate, group, now);
}

// Saves every group a step found and decides each, with a handful of queries per group instead of a dozen.
export async function processGroups(db, groups, now) {
  const stamp = iso(now);
  const rows = await loadRows(db);
  const out = [];
  for (const group of groups) {
    const placed = await placeGroup(db, rows, group, stamp);
    const { row } = placed;
    if (placed.terminal) {
      out.push({ candidateId: row.id, status: row.status, eventId: row.event_id ?? undefined, reason: null, group });
      continue;
    }
    let shown = group;
    if (!placed.created) {
      shown = groupFromRows(row, await loadSources(db, row.id));
      await refreshFields(db, row.id, shown, stamp);
    }
    out.push({ candidateId: row.id, ...(await evaluate(db, row, shown, now)) });
  }
  return out;
}

// A tracked event keeps one event row; a newly found page only adds a source link. No change is logged:
// any change that is not an import would make the event read as "changed" for two weeks.
export async function addSourcesToEvent(db, eventId, observations, now) {
  const stamp = iso(now);
  const seen = new Set();
  const unique = observations.filter((o) => o.url && !seen.has(o.url) && seen.add(o.url));
  for (const rows of chunks(unique, EVENT_SOURCE_ROWS_PER_STATEMENT)) {
    await db
      .prepare(`INSERT OR IGNORE INTO event_sources (event_id, url, domain, adapter, added_at) VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...rows.flatMap((o) => [eventId, o.url, siteOf(o), o.adapter ?? null, stamp]))
      .run();
  }
}

export async function approveCandidate(db, id, user, now) {
  const candidate = await loadCandidate(db, id);
  if (!candidate) throw new DiscoveryError(404, 'candidate not found');
  if (candidate.status !== 'inbox') {
    throw new DiscoveryError(409, candidate.status === 'rejected' ? 'this event was rejected' : 'this event is already added');
  }
  if (!(await claim(db, id))) throw new DiscoveryError(409, 'someone else has just handled this event');
  const group = groupFromRows(candidate, await loadSources(db, id));
  if (!group.name || !group.startDate) {
    await release(db, id);
    throw new DiscoveryError(409, 'this candidate has no start date');
  }
  return { eventId: await promote(db, candidate, group, { auto: false, user, now }) };
}

const rejectionRow = (db, name, startDate, user, stamp) =>
  db
    .prepare(
      `INSERT INTO rejections (name_key, start_date, rejected_by, rejected_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (name_key, start_date) DO UPDATE SET rejected_by = excluded.rejected_by, rejected_at = excluded.rejected_at`,
    )
    .bind(nameKey(name), startDate ?? '', user, stamp);

export async function rejectCandidate(db, id, user, now) {
  const candidate = await loadCandidate(db, id);
  if (!candidate) throw new DiscoveryError(404, 'candidate not found');
  const stamp = iso(now);
  const result = await db.prepare("UPDATE candidates SET status = 'rejected', last_seen = ? WHERE id = ? AND status = 'inbox'").bind(stamp, id).run();
  if (result.meta.changes !== 1) throw new DiscoveryError(409, 'only a candidate waiting in the inbox can be rejected');
  await rejectionRow(db, candidate.name, candidate.start_date, user, stamp).run();
}

export async function undoAutoAdd(db, eventId, user, now) {
  const event = await db.prepare('SELECT id, name, start_date, auto_added FROM events WHERE id = ?').bind(eventId).first();
  if (!event) throw new DiscoveryError(404, 'event not found');
  if (!event.auto_added) throw new DiscoveryError(409, 'this event was not added automatically');
  const count = async (table) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ?`).bind(eventId).first()).n;
  if ((await count('decisions')) > 0) throw new DiscoveryError(409, 'someone has already decided on this event');
  if ((await count('event_people')) > 0 || (await count('event_companies')) > 0) {
    throw new DiscoveryError(409, 'people or companies are attached to this event');
  }
  const stamp = iso(now);
  await db.batch([
    db.prepare('DELETE FROM changes WHERE event_id = ?').bind(eventId),
    db.prepare('DELETE FROM event_sources WHERE event_id = ?').bind(eventId),
    db.prepare("UPDATE candidates SET status = 'rejected', event_id = NULL, last_seen = ? WHERE event_id = ?").bind(stamp, eventId),
    db.prepare('DELETE FROM events WHERE id = ?').bind(eventId),
    rejectionRow(db, event.name, event.start_date, user, stamp),
    db.prepare("INSERT INTO changes (event_id, kind, summary, at) VALUES (NULL, 'removed', ?, ?)").bind(`Removed auto-added ${event.name} (${user})`, stamp),
  ]);
}

export async function listInbox(db, now) {
  const cfg = await getActiveConfig(db);
  const candidates = (await db.prepare("SELECT * FROM candidates WHERE status = 'inbox' ORDER BY first_seen, id").all()).results;
  const rows = (await db.prepare("SELECT * FROM candidate_sources WHERE candidate_id IN (SELECT id FROM candidates WHERE status = 'inbox') ORDER BY id").all()).results;
  const byCandidate = new Map();
  for (const row of rows) byCandidate.set(row.candidate_id, [...(byCandidate.get(row.candidate_id) ?? []), row]);

  return candidates
    .map((c) => {
      const sources = byCandidate.get(c.id) ?? [];
      const group = groupFromRows(c, sources);
      const [lat, lon] = coordsForCity(group.city);
      return {
        id: c.id, name: c.name, organiser: c.organiser, startDate: group.startDate, endDate: group.endDate, city: group.city,
        country: group.country, conflict: group.conflict, reason: decide(group, now).reason,
        sources: sources.map(({ domain, url, adapter, quote }) => ({ domain, url, adapter, quote })),
        suggested: suggestScore({ topicHits: c.topic_hits, startDate: group.startDate, lat, lon }, { homeBases: cfg.homeBases, now }),
        firstSeen: c.first_seen,
      };
    })
    .sort((a, b) => b.sources.length - a.sources.length || String(a.startDate).localeCompare(String(b.startDate)));
}
