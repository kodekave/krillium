// Event discovery rules shared by the Worker and the page: which observations to drop, which ones describe the
// same event, whether sources agree, and whether an event may be added without review. Pure: no clock, no I/O.
//
// Observation: one site's statement about one event:
// { name, organiser?, startDate, endDate?, city?, country?, online, cancelled, url, sourceDomain, adapter,
//   title?, quotes?, topicHits }
import { fold } from './clean.js';
import { coordsForCity } from './cities.js';
import { nameKey, nameSimilarity, registrableDomain } from './names.js';

export const AGGREGATOR_DOMAINS = [
  '10times.com', 'allevents.in', 'eventbrite.com', 'eventbrite.co.uk', 'luma.com', 'lu.ma', 'confs.tech',
  'conferencealerts.com', 'eventseye.com', 'tradefairdates.com', 'meetup.com',
];

const DAY = 86400000;
const NAME_MATCH = 0.6;
const SAME_EDITION_DAYS = 60;
const TRACKED_DAYS = 7;
const AUTO_ADD_SITES = 3;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ENTERTAINMENT = /\b(concert|festival|tour|stand-up|comedy|marathon|football|soccer|nba|nfl)\b/;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY;
// A real calendar date in YYYY-MM-DD form: "2027-03" and "2027-02-31" are not dates.
const validDate = (s) => typeof s === 'string' && ISO_DATE.test(s) && isoDay(dayNumber(s) * DAY) === s;
const daysApart = (a, b) => Math.abs(dayNumber(a) - dayNumber(b));

export function filterReason(obs, now) {
  if (!validDate(obs.startDate)) return 'no_date';
  if (obs.cancelled) return 'cancelled';
  if (obs.online) return 'online_only';
  if (ENTERTAINMENT.test(fold(obs.name))) return 'entertainment';
  const last = validDate(obs.endDate) ? obs.endDate : obs.startDate;
  if (last < isoDay(now)) return 'past';
  return null;
}

export const rejectionKey = (name, startDate) => `${nameKey(name)}|${startDate}`;

// The city as a stable identity: coordinates when the city is known (München and Munich are one place), else its folded name.
function cityIdentity(x) {
  const folded = fold(x?.city).replace(/,.*$/, '').trim();
  if (!folded) return '';
  const [lat, lon] = coordsForCity(folded);
  return lat === null ? folded : `${lat},${lon}`;
}

// Two different stated cities are never one event: sibling events of one organiser in one country (Orlando and
// Chicago) would otherwise merge. A missing city or country never rules a match out.
export function locationCompatible(a, b) {
  const cityA = cityIdentity(a);
  const cityB = cityIdentity(b);
  if (cityA && cityB) return cityA === cityB;
  const countryA = a?.country || null;
  const countryB = b?.country || null;
  if (countryA && countryB) return countryA === countryB;
  return true;
}

const similarNames = (a, b) => nameSimilarity(a.name, b.name) >= NAME_MATCH;

export function sameEdition(a, b) {
  if (!validDate(a.startDate) || !validDate(b.startDate)) return false;
  return similarNames(a, b) && locationCompatible(a, b) && daysApart(a.startDate, b.startDate) <= SAME_EDITION_DAYS;
}

export function matchesTracked(candidate, event) {
  if (!similarNames(candidate, event) || !locationCompatible(candidate, event)) return false;
  return !validDate(event.startDate) || daysApart(candidate.startDate, event.startDate) <= TRACKED_DAYS;
}

function isRejected(obs, rejected) {
  const day = dayNumber(obs.startDate);
  return [-1, 0, 1].some((offset) => rejected.has(rejectionKey(obs.name, isoDay((day + offset) * DAY))));
}

// One organisation under several domains (eventbrite.com, .co.uk, .de; lu.ma and luma.com) is one site.
const BRAND_ALIASES = { lu: 'luma' };

export const siteOf = (obs) => registrableDomain(`https://${obs.sourceDomain ?? ''}`) ?? registrableDomain(obs.url) ?? obs.sourceDomain ?? null;

function siteKey(obs) {
  const brand = (siteOf(obs) ?? '').split('.')[0];
  return BRAND_ALIASES[brand] ?? brand;
}

// The first domain seen for each distinct site, in order.
function distinctSites(observations) {
  const byKey = new Map();
  for (const obs of observations) {
    const key = siteKey(obs);
    const domain = siteOf(obs);
    if (key && domain && !byKey.has(key)) byKey.set(key, domain);
  }
  return [...byKey.values()];
}

function mostCommon(values, tieBreak = () => 0) {
  const counts = new Map();
  for (const v of values) if (v !== null && v !== undefined && v !== '') counts.set(v, (counts.get(v) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || tieBreak(a[0], b[0]));
  return ranked.length ? ranked[0][0] : null;
}

const earliest = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const longest = (a, b) => b.length - a.length;

export function buildGroup(observations) {
  const starts = observations.map((o) => o.startDate).filter(validDate).sort();
  const startDate = mostCommon(starts, earliest);
  const name = mostCommon(observations.map((o) => o.name), longest);
  const problems = [];
  if (starts.length > 1 && daysApart(starts[0], starts.at(-1)) > 1) {
    problems.push(`dates disagree: ${starts[0]} vs ${starts.at(-1)}`);
  }
  const cities = new Set(observations.map(cityIdentity).filter(Boolean));
  if (cities.size > 1) {
    problems.push('cities disagree');
  } else if (new Set(observations.map((o) => o.country).filter(Boolean)).size > 1) {
    problems.push('countries disagree');
  }
  return {
    key: rejectionKey(name ?? '', startDate ?? ''),
    name,
    organiser: mostCommon(observations.map((o) => o.organiser)),
    startDate,
    endDate: mostCommon(observations.map((o) => o.endDate).filter(validDate), earliest),
    city: mostCommon(observations.map((o) => o.city)),
    country: mostCommon(observations.map((o) => o.country)),
    observations,
    domains: distinctSites(observations),
    conflict: problems.length ? problems.join('; ') : null,
  };
}

// An event is outside the chosen dates when it ends before they begin or starts after they end.
const outsideWindow = (obs, window) =>
  Boolean(window) && ((window.from && (obs.endDate ?? obs.startDate) < window.from) || (window.to && obs.startDate > window.to));

export function cluster(observations, { existing = [], rejected = new Set(), now, window = null }) {
  const filtered = [];
  const tracked = new Map();
  const buckets = [];
  for (const obs of observations) {
    const reason = filterReason(obs, now) ?? (outsideWindow(obs, window) ? 'outside_dates' : null) ?? (isRejected(obs, rejected) ? 'rejected' : null);
    if (reason) {
      filtered.push({ observation: obs, reason });
      continue;
    }
    const hits = existing.filter((event) => matchesTracked(obs, event));
    if (hits.length) {
      const best = hits.reduce((top, event) => (nameSimilarity(obs.name, event.name) > nameSimilarity(obs.name, top.name) ? event : top));
      tracked.set(best.id, [...(tracked.get(best.id) ?? []), obs]);
      continue;
    }
    const bucket = buckets.find((members) => members.some((member) => sameEdition(member, obs)));
    if (bucket) bucket.push(obs);
    else buckets.push([obs]);
  }
  return {
    groups: buckets.map(buildGroup),
    tracked: [...tracked].map(([eventId, items]) => ({ eventId, observations: items })),
    filtered,
  };
}

export function decide(group, now) {
  if (group.conflict) return { action: 'inbox', reason: group.conflict };
  if (group.domains.length < AUTO_ADD_SITES) {
    return { action: 'inbox', reason: `${group.domains.length} of ${AUTO_ADD_SITES} sites` };
  }
  if (!validDate(group.startDate) || group.startDate <= isoDay(now)) {
    return { action: 'inbox', reason: 'start date is not in the future' };
  }
  if (coordsForCity(group.city)[0] === null) return { action: 'inbox', reason: 'location not found' };
  return { action: 'auto_add', reason: `${group.domains.length} sites agree` };
}
