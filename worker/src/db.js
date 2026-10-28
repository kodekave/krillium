import { DEFAULT_CONFIG, rankEvents } from '../../site/js/shared/scoring.js';

export async function getActiveConfig(db) {
  const read = () =>
    db.prepare('SELECT version, json FROM icp_config ORDER BY version DESC LIMIT 1').first();
  let row = await read();
  if (!row) {
    await db
      .prepare('INSERT OR IGNORE INTO icp_config (version, json, created_by) VALUES (1, ?, ?)')
      .bind(JSON.stringify({ ...DEFAULT_CONFIG, version: 1 }), 'system')
      .run();
    row = await read();
  }
  return { ...JSON.parse(row.json), version: row.version };
}

export async function saveConfig(db, cfg, user) {
  const current = await getActiveConfig(db);
  const version = current.version + 1;
  await db
    .prepare('INSERT INTO icp_config (version, json, created_by) VALUES (?, ?, ?)')
    .bind(version, JSON.stringify({ ...cfg, version }), user)
    .run();
  return version;
}

const DAY = 86400000;
const CHANGED_WINDOW_DAYS = 14;
const VERIFIED_WINDOW_DAYS = 35;

export function parseTime(value) {
  if (!value) return NaN;
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return Date.parse(`${value}T00:00:00Z`);
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

export function freshnessFor(lastChecked, lastRealChange, now) {
  const changed = parseTime(lastRealChange);
  if (Number.isFinite(changed) && now - changed <= CHANGED_WINDOW_DAYS * DAY) return 'changed';
  const checked = parseTime(lastChecked);
  if (Number.isFinite(checked) && now - checked <= VERIFIED_WINDOW_DAYS * DAY) return 'verified';
  return 'needs-check';
}

const RADAR_SQL = `
  SELECT e.id, e.name, e.organiser, e.city, e.country, e.lat, e.lon, e.start_date, e.end_date,
    e.source_url, e.last_checked,
    COALESCE(e.fit, 0) + COALESCE(e.public_names, 0) + COALESCE(e.timing, 0) + COALESCE(e.distance, 0) AS event_score,
    (SELECT COUNT(*) FROM event_people ep JOIN people p ON p.id = ep.person_id
       LEFT JOIN companies c ON c.id = p.company_id
       WHERE ep.event_id = e.id AND ep.tier = 'A' AND COALESCE(c.vendor, 0) = 0) AS tier_a,
    (SELECT COUNT(*) FROM event_people ep JOIN people p ON p.id = ep.person_id
       LEFT JOIN companies c ON c.id = p.company_id
       WHERE ep.event_id = e.id AND ep.tier = 'B' AND COALESCE(c.vendor, 0) = 0) AS tier_b,
    (SELECT COUNT(*) FROM event_companies ec JOIN companies c ON c.id = ec.company_id
       WHERE ec.event_id = e.id AND c.vendor = 0) AS account_only,
    (SELECT MAX(ch.at) FROM changes ch WHERE ch.event_id = e.id AND ch.kind != 'imported') AS last_real_change
  FROM events e`;

export async function getRankedEvents(db, now = Date.now()) {
  const cfg = await getActiveConfig(db);
  const { results } = await db.prepare(RADAR_SQL).all();
  const events = results.map((r) => ({
    id: r.id,
    name: r.name,
    organiser: r.organiser,
    city: r.city,
    country: r.country,
    lat: r.lat,
    lon: r.lon,
    startDate: r.start_date,
    endDate: r.end_date,
    eventScore20: r.event_score,
    counts: { tierA: r.tier_a, tierB: r.tier_b, accountOnly: r.account_only },
    sourceUrl: r.source_url,
    lastChecked: r.last_checked,
    freshness: freshnessFor(r.last_checked, r.last_real_change, now),
  }));
  return { cfg, events: rankEvents(events, cfg) };
}

export async function getEventDetail(db, id, now = Date.now()) {
  const { events } = await getRankedEvents(db, now);
  const event = events.find((e) => e.id === id);
  if (!event) return null;

  const people = (
    await db
      .prepare(
        `SELECT c.name AS company, c.domain, p.name AS person, p.title, p.persona, ep.tier, ep.role, p.source_url
         FROM event_people ep JOIN people p ON p.id = ep.person_id
         LEFT JOIN companies c ON c.id = p.company_id
         WHERE ep.event_id = ? AND COALESCE(c.vendor, 0) = 0
         ORDER BY ep.score DESC, p.name`,
      )
      .bind(id)
      .all()
  ).results;
  const soloCompanies = (
    await db
      .prepare(
        `SELECT c.name AS company, c.domain, ec.source_url
         FROM event_companies ec JOIN companies c ON c.id = ec.company_id
         WHERE ec.event_id = ? AND c.vendor = 0 ORDER BY c.name`,
      )
      .bind(id)
      .all()
  ).results;
  const vendor = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM event_companies ec JOIN companies c ON c.id = ec.company_id
       WHERE ec.event_id = ? AND c.vendor = 1`,
    )
    .bind(id)
    .first();
  const history = (
    await db
      .prepare('SELECT at, kind, summary, source_url FROM changes WHERE event_id = ? ORDER BY at DESC, id DESC LIMIT 20')
      .bind(id)
      .all()
  ).results.map((h) => ({ at: h.at, kind: h.kind, summary: h.summary, sourceUrl: h.source_url }));

  const accounts = [
    ...people.map((p) => ({
      company: p.company ?? '', domain: p.domain, person: p.person, title: p.title,
      persona: p.persona, tier: p.tier, role: p.role,
    })),
    ...soloCompanies.map((c) => ({
      company: c.company, domain: c.domain, person: null, title: null, persona: null, tier: null, role: 'company_only',
    })),
  ];

  const urls = [event.sourceUrl, ...people.map((p) => p.source_url), ...soloCompanies.map((c) => c.source_url)];
  const sources = [...new Set(urls.filter(Boolean))].slice(0, 11).map((url, i) => ({
    label: i === 0 && url === event.sourceUrl ? 'Organiser page' : 'Public source',
    url,
  }));

  const { tierA, tierB, accountOnly } = event.counts;
  const reasons = [];
  if (tierA || tierB) reasons.push(`${tierA} Tier A and ${tierB} Tier B people are publicly attached`);
  if (accountOnly) reasons.push(`${accountOnly} account-only companies are on the attendee list`);
  reasons.push(`Event score ${event.eventScore20} of 20`);
  if (!tierA && !tierB && !accountOnly) reasons.push('No ICP-matching people are public yet');

  const vendorCount = vendor?.n ?? 0;
  const companyCount = new Set(accounts.map((a) => a.company)).size;
  const vendorShare = vendorCount + companyCount > 0 ? vendorCount / (vendorCount + companyCount) : null;

  return { ...event, reasons, accounts, sources, history, vendorCount, vendorShare };
}

export async function getFeed(db, limit = 50) {
  const { results } = await db
    .prepare(
      `SELECT ch.id, ch.event_id, e.name AS event_name, ch.kind, ch.summary, ch.source_url, ch.at
       FROM changes ch LEFT JOIN events e ON e.id = ch.event_id
       ORDER BY ch.at DESC, ch.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results.map((r) => ({
    id: r.id, eventId: r.event_id, eventName: r.event_name, kind: r.kind,
    summary: r.summary, sourceUrl: r.source_url, at: r.at,
  }));
}
