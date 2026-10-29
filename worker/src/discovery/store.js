// Candidate store: saves what searches found, decides when an event may be added without review, and handles
// approve, reject and undo. Writes that change the event list are one db.batch, so a failure leaves nothing half-done.
// A candidate is claimed (status 'promoting') before it becomes an event, so two people or two runs cannot both
// create it, and a rejection and an auto-add cannot both win. Statements are few and wide (multi-row inserts) because
// the free plan allows 50 database queries per request.
// Every function takes the workspace id right after `db`; a candidate, event or rejection of another workspace is
// invisible here, so looking one up by id answers "not found".
import { AGGREGATOR_DOMAINS, buildGroup, decide, sameEdition, siteOf } from '../../../site/js/shared/discovery.js';
import { coordsForCity } from '../../../site/js/shared/cities.js';
import { nameKey, slugify } from '../../../site/js/shared/names.js';
import { suggestScore } from '../../../site/js/shared/suggest.js';
import { getActiveConfig, parseSectors } from '../db.js';
import { wsId } from '../scope.js';

export class DiscoveryError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DiscoveryError';
    this.status = status;
  }
}

const MAX_QUOTE = 200;
const SOURCE_ROWS_PER_STATEMENT = 9; // 11 bound values per row; D1 allows 100 per statement
const EVENT_SOURCE_ROWS_PER_STATEMENT = 16; // 6 bound values per row

const iso = (ms) => new Date(ms).toISOString();
const quoteOf = (obs) => String(obs.quotes?.dates ?? obs.quotes?.name ?? '').slice(0, MAX_QUOTE) || null;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function loadContext(db, workspaceId) {
  wsId(workspaceId);
  const events = (await db.prepare('SELECT id, name, start_date, city, country FROM events WHERE workspace_id = ?').bind(workspaceId).all()).results;
  const rejections = (await db.prepare('SELECT name_key, start_date FROM rejections WHERE workspace_id = ?').bind(workspaceId).all()).results;
  return {
    existing: events.map((e) => ({ id: e.id, name: e.name, startDate: e.start_date, city: e.city, country: e.country })),
    rejected: new Set(rejections.map((r) => `${r.name_key}|${r.start_date}`)),
  };
}

const loadCandidate = (db, workspaceId, id) => db.prepare('SELECT * FROM candidates WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first();
const loadSources = async (db, workspaceId, id) =>
  (await db.prepare('SELECT * FROM candidate_sources WHERE workspace_id = ? AND candidate_id = ? ORDER BY id').bind(workspaceId, id).all()).results;
const loadRows = async (db, workspaceId) => (await db.prepare('SELECT * FROM candidates WHERE workspace_id = ?').bind(workspaceId).all()).results;

// Rebuilds the group from everything stored, so evidence gathered across runs counts together. A source that did
// not state a city stays without one rather than borrowing the candidate's.
function groupFromRows(candidate, sources) {
  return buildGroup(
    sources.map((s) => ({
      name: candidate.name, organiser: candidate.organiser, startDate: s.found_start ?? candidate.start_date, endDate: s.found_end,
      city: s.found_city, country: candidate.country, online: false, cancelled: false, url: s.url, sourceDomain: s.domain,
      adapter: s.adapter, title: s.title, quotes: { dates: s.quote }, topicHits: candidate.topic_hits, sectors: parseSectors(candidate.sectors),
    })),
  );
}

const asRef = (r) => ({ name: r.name, startDate: r.start_date, city: r.city, country: r.country });

// The facts of a candidate at the moment someone decides on it, for the workspace's memory. No people or companies.
const candidateFacts = (group, now) => ({
  name: group.name, organiser: group.organiser, city: group.city, country: group.country, startDate: group.startDate,
  sectors: group.sectors, sites: group.domains, siteCount: group.domains.length, inboxReason: decide(group, now).reason,
});

// The candidate that already stands for this event, preferring one still waiting in the inbox.
function findMatch(rows, group) {
  const probe = { name: group.name, startDate: group.startDate, city: group.city, country: group.country };
  const matches = rows.filter((r) => sameEdition(probe, asRef(r)));
  return matches.find((r) => r.status === 'inbox') ?? matches[0];
}

async function upsertSources(db, workspaceId, candidateId, observations, stamp) {
  const seen = new Set();
  const unique = observations.filter((o) => o.url && !seen.has(o.url) && seen.add(o.url));
  for (const rows of chunks(unique, SOURCE_ROWS_PER_STATEMENT)) {
    await db
      .prepare(
        `INSERT INTO candidate_sources (workspace_id, candidate_id, domain, url, adapter, title, found_start, found_end, found_city, quote, fetched_at)
         VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT (candidate_id, url) DO UPDATE SET domain = excluded.domain, adapter = excluded.adapter, title = excluded.title,
           found_start = excluded.found_start, found_end = excluded.found_end, found_city = excluded.found_city,
           quote = excluded.quote, fetched_at = excluded.fetched_at`,
      )
      .bind(...rows.flatMap((o) => [workspaceId, candidateId, siteOf(o), o.url, o.adapter ?? 'unknown', o.title ?? null, o.startDate ?? null, o.endDate ?? null, o.city ?? null, quoteOf(o), stamp]))
      .run();
  }
}

// Creates the candidate for a new event. If another writer created it a moment earlier, the insert is ignored and
// that candidate is returned instead, so two runs finding the same event never fail on the unique key.
async function createCandidate(db, workspaceId, rows, group, stamp) {
  const [lat, lon] = coordsForCity(group.city);
  const topicHits = Math.max(0, ...group.observations.map((o) => o.topicHits ?? 0));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const used = new Set(rows.map((r) => r.cluster_key));
    let key = group.key;
    for (let n = 2; used.has(key); n += 1) key = `${group.key}|${n}`;
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO candidates (workspace_id, cluster_key, name, organiser, city, country, lat, lon, start_date, end_date, topic_hits, sectors, status, conflict, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?)`,
      )
      .bind(workspaceId, key, group.name, group.organiser, group.city, group.country, lat, lon, group.startDate, group.endDate, topicHits, JSON.stringify(group.sectors), group.conflict, stamp, stamp)
      .run();
    if (result.meta.changes === 1) {
      const row = {
        id: result.meta.last_row_id, cluster_key: key, name: group.name, organiser: group.organiser, city: group.city, country: group.country,
        lat, lon, start_date: group.startDate, end_date: group.endDate, topic_hits: topicHits, sectors: JSON.stringify(group.sectors), status: 'inbox', conflict: group.conflict, event_id: null,
      };
      rows.push(row);
      return { created: row };
    }
    rows.splice(0, rows.length, ...(await loadRows(db, workspaceId)));
    const hit = findMatch(rows, group);
    if (hit) return { existing: hit };
  }
  throw new Error('could not save the candidate');
}

// Puts a group with its candidate: an existing one gets the new sources, a new one is created. `rows` is the
// candidate list, loaded once by the caller and kept up to date here.
async function placeGroup(db, workspaceId, rows, group, stamp) {
  let row = findMatch(rows, group);
  let created = false;
  if (!row) {
    const made = await createCandidate(db, workspaceId, rows, group, stamp);
    created = Boolean(made.created);
    row = made.created ?? made.existing;
  }
  if (row.status !== 'inbox') return { row, created: false, terminal: true };
  if (!created) {
    const topicHits = Math.max(0, ...group.observations.map((o) => o.topicHits ?? 0));
    const sectors = JSON.stringify([...new Set([...parseSectors(row.sectors), ...group.sectors])].sort());
    await db
      .prepare('UPDATE candidates SET topic_hits = MAX(topic_hits, ?), sectors = ?, last_seen = ? WHERE workspace_id = ? AND id = ?')
      .bind(topicHits, sectors, stamp, workspaceId, row.id)
      .run();
    row.topic_hits = Math.max(row.topic_hits ?? 0, topicHits);
    row.sectors = sectors;
  }
  await upsertSources(db, workspaceId, row.id, group.observations, stamp);
  return { row, created, terminal: false };
}

export async function saveGroup(db, workspaceId, group, now) {
  wsId(workspaceId);
  const placed = await placeGroup(db, workspaceId, await loadRows(db, workspaceId), group, iso(now));
  return { candidateId: placed.row.id, status: placed.terminal ? placed.row.status : 'inbox' };
}

const claim = async (db, workspaceId, id) =>
  (await db.prepare("UPDATE candidates SET status = 'promoting' WHERE workspace_id = ? AND id = ? AND status = 'inbox'").bind(workspaceId, id).run()).meta.changes === 1;
const release = (db, workspaceId, id) =>
  db.prepare("UPDATE candidates SET status = 'inbox' WHERE workspace_id = ? AND id = ? AND status = 'promoting'").bind(workspaceId, id).run();

// Turns a claimed candidate into an event, in one batch. If the batch fails the claim is given back.
async function promote(db, workspaceId, candidate, group, { auto, user, now }) {
  const stamp = iso(now);
  const cfg = await getActiveConfig(db, workspaceId);
  const [lat, lon] = coordsForCity(group.city);
  const score = suggestScore({ topicHits: candidate.topic_hits, startDate: group.startDate, lat, lon }, { homeBases: cfg.homeBases, now });
  const id = await freeEventId(db, workspaceId, `${slugify(group.name)}-${group.startDate.slice(0, 7)}`);

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
          `INSERT INTO events (workspace_id, id, name, organiser, url, city, country, lat, lon, start_date, end_date, source_url, last_checked,
             fit, public_names, timing, distance, origin, auto_added, sectors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'discovered', ?, ?)`,
        )
        .bind(workspaceId, id, group.name, group.organiser, url, group.city, group.country, lat, lon, group.startDate, group.endDate, url, score.fit, score.public_names, score.timing, score.distance, auto ? 1 : 0, JSON.stringify(group.sectors)),
      ...chunks(sources, EVENT_SOURCE_ROWS_PER_STATEMENT).map((rows) =>
        db
          .prepare(`INSERT OR IGNORE INTO event_sources (workspace_id, event_id, url, domain, adapter, added_at) VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`)
          .bind(...rows.flatMap((s) => [workspaceId, id, s.url, s.domain, s.adapter, stamp])),
      ),
      db.prepare("INSERT INTO changes (workspace_id, event_id, kind, summary, source_url, at) VALUES (?, ?, 'new_event', ?, ?, ?)").bind(workspaceId, id, summary, url, stamp),
      db.prepare('UPDATE candidates SET status = ?, event_id = ?, last_seen = ? WHERE workspace_id = ? AND id = ?').bind(auto ? 'auto_added' : 'approved', id, stamp, workspaceId, candidate.id),
    ]);
  } catch (e) {
    await release(db, workspaceId, candidate.id);
    throw e;
  }
  return id;
}

async function freeEventId(db, workspaceId, base) {
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!(await db.prepare('SELECT 1 AS taken FROM events WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).first())) return id;
  }
}

// Decides a group's candidate: the auto-add rule, and if it passes, claim then promote. Someone else may have
// handled the candidate in the meantime; then its current state is reported and nothing is created.
async function evaluate(db, workspaceId, candidate, group, now) {
  const verdict = decide(group, now);
  if (verdict.action !== 'auto_add') return { status: 'inbox', reason: verdict.reason, group };
  if (!(await claim(db, workspaceId, candidate.id))) {
    const current = await loadCandidate(db, workspaceId, candidate.id);
    return { status: current.status, eventId: current.event_id ?? undefined };
  }
  const eventId = await promote(db, workspaceId, candidate, group, { auto: true, user: 'discovery', now });
  return { status: 'auto_added', eventId, reason: verdict.reason, group };
}

async function refreshFields(db, workspaceId, candidateId, group, stamp) {
  const [lat, lon] = coordsForCity(group.city);
  await db
    .prepare('UPDATE candidates SET start_date = ?, end_date = ?, city = ?, country = ?, lat = ?, lon = ?, conflict = ?, last_seen = ? WHERE workspace_id = ? AND id = ?')
    .bind(group.startDate, group.endDate, group.city, group.country, lat, lon, group.conflict, stamp, workspaceId, candidateId)
    .run();
}

export async function reevaluate(db, workspaceId, candidateId, now) {
  wsId(workspaceId);
  const candidate = await loadCandidate(db, workspaceId, candidateId);
  if (!candidate) throw new DiscoveryError(404, 'candidate not found');
  if (candidate.status !== 'inbox') return { status: candidate.status, eventId: candidate.event_id ?? undefined };
  const group = groupFromRows(candidate, await loadSources(db, workspaceId, candidateId));
  await refreshFields(db, workspaceId, candidateId, group, iso(now));
  return evaluate(db, workspaceId, candidate, group, now);
}

// Saves every group a step found and decides each, with a handful of queries per group instead of a dozen.
export async function processGroups(db, workspaceId, groups, now) {
  wsId(workspaceId);
  const stamp = iso(now);
  const rows = await loadRows(db, workspaceId);
  const out = [];
  for (const group of groups) {
    const placed = await placeGroup(db, workspaceId, rows, group, stamp);
    const { row } = placed;
    if (placed.terminal) {
      out.push({ candidateId: row.id, status: row.status, eventId: row.event_id ?? undefined, reason: null, group });
      continue;
    }
    let shown = group;
    if (!placed.created) {
      shown = groupFromRows(row, await loadSources(db, workspaceId, row.id));
      await refreshFields(db, workspaceId, row.id, shown, stamp);
    }
    out.push({ candidateId: row.id, ...(await evaluate(db, workspaceId, row, shown, now)) });
  }
  return out;
}

// A tracked event keeps one event row; a newly found page only adds a source link. No change is logged:
// any change that is not an import would make the event read as "changed" for two weeks.
export async function addSourcesToEvent(db, workspaceId, eventId, observations, now) {
  wsId(workspaceId);
  const stamp = iso(now);
  const seen = new Set();
  const unique = observations.filter((o) => o.url && !seen.has(o.url) && seen.add(o.url));
  for (const rows of chunks(unique, EVENT_SOURCE_ROWS_PER_STATEMENT)) {
    await db
      .prepare(`INSERT OR IGNORE INTO event_sources (workspace_id, event_id, url, domain, adapter, added_at) VALUES ${rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`)
      .bind(...rows.flatMap((o) => [workspaceId, eventId, o.url, siteOf(o), o.adapter ?? null, stamp]))
      .run();
  }
}

export async function approveCandidate(db, workspaceId, id, user, now) {
  wsId(workspaceId);
  const candidate = await loadCandidate(db, workspaceId, id);
  if (!candidate) throw new DiscoveryError(404, 'candidate not found');
  if (candidate.status !== 'inbox') {
    throw new DiscoveryError(409, candidate.status === 'rejected' ? 'this event was rejected' : 'this event is already added');
  }
  if (!(await claim(db, workspaceId, id))) throw new DiscoveryError(409, 'someone else has just handled this event');
  const group = groupFromRows(candidate, await loadSources(db, workspaceId, id));
  if (!group.name || !group.startDate) {
    await release(db, workspaceId, id);
    throw new DiscoveryError(409, 'this candidate has no start date');
  }
  const eventId = await promote(db, workspaceId, candidate, group, { auto: false, user, now });
  return { eventId, facts: candidateFacts(group, now) };
}

const rejectionRow = (db, workspaceId, name, startDate, user, stamp) =>
  db
    .prepare(
      `INSERT INTO rejections (workspace_id, name_key, start_date, rejected_by, rejected_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, name_key, start_date) DO UPDATE SET rejected_by = excluded.rejected_by, rejected_at = excluded.rejected_at`,
    )
    .bind(workspaceId, nameKey(name), startDate ?? '', user, stamp);

export async function rejectCandidate(db, workspaceId, id, user, now) {
  wsId(workspaceId);
  const candidate = await loadCandidate(db, workspaceId, id);
  if (!candidate) throw new DiscoveryError(404, 'candidate not found');
  const stamp = iso(now);
  const result = await db
    .prepare("UPDATE candidates SET status = 'rejected', last_seen = ? WHERE workspace_id = ? AND id = ? AND status = 'inbox'")
    .bind(stamp, workspaceId, id)
    .run();
  if (result.meta.changes !== 1) throw new DiscoveryError(409, 'only a candidate waiting in the inbox can be rejected');
  await rejectionRow(db, workspaceId, candidate.name, candidate.start_date, user, stamp).run();
  return candidateFacts(groupFromRows(candidate, await loadSources(db, workspaceId, id)), now);
}

const COUNT_SQL = {
  decisions: 'SELECT COUNT(*) AS n FROM decisions WHERE workspace_id = ? AND event_id = ?',
  event_people: 'SELECT COUNT(*) AS n FROM event_people WHERE workspace_id = ? AND event_id = ?',
  event_companies: 'SELECT COUNT(*) AS n FROM event_companies WHERE workspace_id = ? AND event_id = ?',
};

export async function undoAutoAdd(db, workspaceId, eventId, user, now) {
  wsId(workspaceId);
  const event = await db
    .prepare('SELECT id, name, organiser, city, country, start_date, sectors, auto_added FROM events WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, eventId)
    .first();
  if (!event) throw new DiscoveryError(404, 'event not found');
  if (!event.auto_added) throw new DiscoveryError(409, 'this event was not added automatically');
  const count = async (table) => (await db.prepare(COUNT_SQL[table]).bind(workspaceId, eventId).first()).n;
  if ((await count('decisions')) > 0) throw new DiscoveryError(409, 'someone has already decided on this event');
  if ((await count('event_people')) > 0 || (await count('event_companies')) > 0) {
    throw new DiscoveryError(409, 'people or companies are attached to this event');
  }
  // What the event stood on, kept for the workspace's memory before its sources are deleted.
  const sites = (await db.prepare('SELECT DISTINCT domain FROM event_sources WHERE workspace_id = ? AND event_id = ? ORDER BY domain').bind(workspaceId, eventId).all())
    .results.map((r) => r.domain);
  const stamp = iso(now);
  await db.batch([
    db.prepare('DELETE FROM changes WHERE workspace_id = ? AND event_id = ?').bind(workspaceId, eventId),
    db.prepare('DELETE FROM event_sources WHERE workspace_id = ? AND event_id = ?').bind(workspaceId, eventId),
    db.prepare("UPDATE candidates SET status = 'rejected', event_id = NULL, last_seen = ? WHERE workspace_id = ? AND event_id = ?").bind(stamp, workspaceId, eventId),
    db.prepare('DELETE FROM events WHERE workspace_id = ? AND id = ?').bind(workspaceId, eventId),
    rejectionRow(db, workspaceId, event.name, event.start_date, user, stamp),
    db.prepare("INSERT INTO changes (workspace_id, event_id, kind, summary, at) VALUES (?, NULL, 'removed', ?, ?)").bind(workspaceId, `Removed auto-added ${event.name} (${user})`, stamp),
  ]);
  return {
    name: event.name, organiser: event.organiser, city: event.city, country: event.country, startDate: event.start_date,
    sectors: parseSectors(event.sectors), sites, siteCount: sites.length,
  };
}

export async function listInbox(db, workspaceId, now) {
  wsId(workspaceId);
  const cfg = await getActiveConfig(db, workspaceId);
  const candidates = (await db.prepare("SELECT * FROM candidates WHERE workspace_id = ? AND status = 'inbox' ORDER BY first_seen, id").bind(workspaceId).all()).results;
  const rows = (
    await db
      .prepare("SELECT * FROM candidate_sources WHERE workspace_id = ? AND candidate_id IN (SELECT id FROM candidates WHERE workspace_id = ? AND status = 'inbox') ORDER BY id")
      .bind(workspaceId, workspaceId)
      .all()
  ).results;
  const byCandidate = new Map();
  for (const row of rows) byCandidate.set(row.candidate_id, [...(byCandidate.get(row.candidate_id) ?? []), row]);

  return candidates
    .map((c) => {
      const sources = byCandidate.get(c.id) ?? [];
      const group = groupFromRows(c, sources);
      const [lat, lon] = coordsForCity(group.city);
      return {
        id: c.id, name: c.name, organiser: c.organiser, startDate: group.startDate, endDate: group.endDate, city: group.city,
        country: group.country, conflict: group.conflict, sectors: group.sectors, reason: decide(group, now).reason,
        sources: sources.map(({ domain, url, adapter, quote }) => ({ domain, url, adapter, quote })),
        suggested: suggestScore({ topicHits: c.topic_hits, startDate: group.startDate, lat, lon }, { homeBases: cfg.homeBases, now }),
        firstSeen: c.first_seen,
      };
    })
    .sort((a, b) => b.sources.length - a.sources.length || String(a.startDate).localeCompare(String(b.startDate)));
}
