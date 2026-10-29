import { describe, it, expect } from 'vitest';
import {
  AGGREGATOR_DOMAINS, buildGroup, cluster, decide, filterReason, matchesTracked, rejectionKey, sameEdition,
} from '../../site/js/shared/discovery.js';
import { registrableDomain } from '../../site/js/shared/names.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');

const obs = (over = {}) => ({
  name: 'SSOW Orlando', organiser: 'SSON', startDate: '2027-03-08', endDate: '2027-03-11', city: 'Orlando', country: 'US',
  online: false, cancelled: false, url: 'https://ssonetwork.com/orlando', sourceDomain: 'ssonetwork.com', adapter: 'exa',
  topicHits: 1, ...over,
});

const three = (over = {}) => [
  obs({ sourceDomain: 'ssonetwork.com', ...over }),
  obs({ name: 'SSOW Orlando 2027', sourceDomain: 'luminik.io', url: 'https://luminik.io/x', ...over }),
  obs({ name: 'SSOW Orlando - 2027', sourceDomain: '10times.com', url: 'https://10times.com/x', ...over }),
];

const run = (observations, extra = {}) => cluster(observations, { existing: [], rejected: new Set(), now: NOW, ...extra });

describe('filterReason', () => {
  it('filters past, cancelled, online-only, entertainment and undated observations with a reason each', () => {
    expect(filterReason(obs({ startDate: '2026-09-01', endDate: '2026-09-03' }), NOW)).toBe('past');
    expect(filterReason(obs({ cancelled: true }), NOW)).toBe('cancelled');
    expect(filterReason(obs({ online: true }), NOW)).toBe('online_only');
    expect(filterReason(obs({ name: 'Summer Music Festival' }), NOW)).toBe('entertainment');
    expect(filterReason(obs({ startDate: null }), NOW)).toBe('no_date');
  });

  it('keeps a good observation and an event that is running today', () => {
    expect(filterReason(obs(), NOW)).toBeNull();
    expect(filterReason(obs({ startDate: '2026-10-28', endDate: '2026-10-30' }), NOW)).toBeNull();
  });

  it('month-only text never becomes a date', () => {
    expect(filterReason(obs({ startDate: '2027-03' }), NOW)).toBe('no_date');
    expect(filterReason(obs({ startDate: '2027-02-31' }), NOW)).toBe('no_date');
  });
});

describe('cluster', () => {
  it('clusters one event named two ways and counts distinct domains', () => {
    const { groups, filtered, tracked } = run(three());
    expect(groups).toHaveLength(1);
    expect(groups[0].domains).toEqual(['ssonetwork.com', 'luminik.io', '10times.com']);
    expect(groups[0].observations).toHaveLength(3);
    expect(filtered).toEqual([]);
    expect(tracked).toEqual([]);
  });

  it('counts two subdomains of one site once', () => {
    const { groups } = run([
      obs({ sourceDomain: 'events.ssonetwork.com' }),
      obs({ sourceDomain: 'www.ssonetwork.com', url: 'https://www.ssonetwork.com/b' }),
    ]);
    expect(groups[0].domains).toEqual(['ssonetwork.com']);
  });

  it('does not merge sibling events from one organiser', () => {
    const { groups } = run([
      obs({ name: 'SSOW Orlando' }),
      obs({ name: 'SSOW Europe', city: 'Estoril', country: 'PT', startDate: '2027-03-08' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('does not merge two editions of a recurring event more than 60 days apart', () => {
    const { groups } = run([
      obs({ name: 'BME Symposium Procurement and Logistics', city: 'Berlin', country: 'DE', startDate: '2026-11-18' }),
      obs({ name: 'BME Symposium Procurement and Logistics 2027', city: 'Berlin', country: 'DE', startDate: '2027-11-17' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('sets a conflict when dates inside one cluster differ by more than a day', () => {
    const { groups } = run([
      obs(), obs({ sourceDomain: 'a.com' }), obs({ sourceDomain: 'b.com', startDate: '2027-03-15' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].conflict).toMatch(/dates disagree: 2027-03-08 vs 2027-03-15/);
  });

  it('a one-day difference is not a conflict', () => {
    const { groups } = run([obs(), obs({ sourceDomain: 'a.com', startDate: '2027-03-09' })]);
    expect(groups[0].conflict).toBeNull();
  });

  it('counts one site under several domains once', () => {
    const sites = (...domains) => domains.map((d) => obs({ sourceDomain: d, url: `https://${d}/x` }));
    const eventbrite = run(sites('eventbrite.com', 'eventbrite.co.uk', 'eventbrite.de')).groups[0];
    expect(eventbrite.domains).toHaveLength(1);
    expect(decide(eventbrite, NOW)).toEqual({ action: 'inbox', reason: '1 of 3 sites' });
    expect(run(sites('lu.ma', 'luma.com', 'ssonetwork.com')).groups[0].domains).toHaveLength(2);
    expect(run(sites('bme.de', 'bme.com', 'ssonetwork.com', 'luminik.io')).groups[0].domains).toHaveLength(3);
  });

  it('keeps sibling events in one country apart even when their names are alike', () => {
    const orlando = obs({ name: 'Shared Services and Outsourcing Week Orlando', city: 'Orlando', startDate: '2027-03-08' });
    const chicago = obs({ name: 'Shared Services and Outsourcing Week Chicago', city: 'Chicago', startDate: '2027-04-20', sourceDomain: 'a.com' });
    expect(run([orlando, chicago]).groups).toHaveLength(2);
    expect(matchesTracked(chicago, { name: orlando.name, startDate: '2027-03-08', city: 'Orlando', country: 'US' })).toBe(false);
  });

  it('events outside the chosen dates are filtered, and events that overlap them are kept', () => {
    const window = { from: '2027-04-01', to: '2027-06-30' };
    const early = obs({ name: 'Early Forum', startDate: '2027-03-08', endDate: '2027-03-11' });
    const overlaps = obs({ name: 'Overlap Congress', startDate: '2027-03-30', endDate: '2027-04-02' });
    const inside = obs({ name: 'Inside Expo', startDate: '2027-05-10', endDate: null });
    const late = obs({ name: 'Late Symposium', startDate: '2027-07-01', endDate: null });
    const result = run([early, overlaps, inside, late], { window });
    expect(result.groups.map((g) => g.name).sort()).toEqual(['Inside Expo', 'Overlap Congress']);
    expect(result.filtered.map((f) => [f.observation.name, f.reason])).toEqual([['Early Forum', 'outside_dates'], ['Late Symposium', 'outside_dates']]);
  });

  it('two different stated cities in one country are separate groups, a missing city still joins', () => {
    const base = { name: 'Procurement Summit', country: 'DE' };
    const missing = run([obs({ ...base, city: 'Berlin' }), obs({ ...base, city: null, sourceDomain: 'a.com' })]);
    expect(missing.groups[0].conflict).toBeNull();
    const different = run([obs({ ...base, city: 'Berlin' }), obs({ ...base, city: 'Munich', sourceDomain: 'a.com' })]);
    expect(different.groups).toHaveLength(2);
    expect(different.groups.every((g) => g.conflict === null)).toBe(true);
  });

  it('buildGroup still flags stored sources that name different cities', () => {
    const g = buildGroup([obs({ city: 'Berlin', country: 'DE' }), obs({ city: 'Munich', country: 'DE', sourceDomain: 'a.com' })]);
    expect(g.conflict).toMatch(/cities disagree/);
  });

  it('the same city written two ways is not a conflict', () => {
    const { groups } = run([
      obs({ city: 'München', country: 'DE' }), obs({ city: 'Munich', country: 'DE', sourceDomain: 'a.com' }),
    ]);
    expect(groups[0].conflict).toBeNull();
  });

  it('different cities in different countries stay separate groups', () => {
    const { groups } = run([
      obs({ name: 'Procurement Summit', city: 'Berlin', country: 'DE' }),
      obs({ name: 'Procurement Summit', city: 'Orlando', country: 'US', sourceDomain: 'a.com' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('a candidate matching a tracked event is returned as tracked and creates no group', () => {
    const existing = [{ id: 'ssow-orl', name: 'SSOW Orlando', startDate: '2027-03-08', city: 'Orlando', country: 'US' }];
    const { groups, tracked } = run([obs({ name: 'SSOW Orlando 2027', startDate: '2027-03-09' })], { existing });
    expect(groups).toEqual([]);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].eventId).toBe('ssow-orl');
    expect(tracked[0].observations).toHaveLength(1);
  });

  it('a rejected key is filtered with reason rejected, even one day off', () => {
    const rejected = new Set([rejectionKey('SSOW Orlando', '2027-03-08')]);
    const result = run([obs(), obs({ startDate: '2027-03-09', sourceDomain: 'a.com' })], { rejected });
    expect(result.groups).toEqual([]);
    expect(result.filtered.map((f) => f.reason)).toEqual(['rejected', 'rejected']);
  });

  it('filtered observations never reach a group', () => {
    const result = run([obs({ cancelled: true }), obs({ startDate: null }), obs()]);
    expect(result.groups).toHaveLength(1);
    expect(result.filtered.map((f) => f.reason)).toEqual(['cancelled', 'no_date']);
  });
});

describe('AGGREGATOR_DOMAINS', () => {
  it('lists each site once, as a plain lowercase registrable domain', () => {
    expect(new Set(AGGREGATOR_DOMAINS).size).toBe(AGGREGATOR_DOMAINS.length);
    for (const domain of AGGREGATOR_DOMAINS) {
      expect(domain).toBe(domain.toLowerCase());
      expect(registrableDomain(`https://${domain}/`), domain).toBe(domain);
    }
  });

  it('keeps the original sites and adds the directories and ticketing sites checked on 2026-10-29', () => {
    expect(AGGREGATOR_DOMAINS).toEqual(expect.arrayContaining(['10times.com', 'allevents.in', 'eventbrite.com', 'luma.com', 'confs.tech', 'eventseye.com', 'tradefairdates.com', 'meetup.com']));
    expect(AGGREGATOR_DOMAINS).toEqual(expect.arrayContaining(['tsnn.com', 'auma.de', 'eventzilla.net', 'townscript.com']));
  });
});

describe('matching rules', () => {
  it('sameEdition needs a similar name, a compatible place and dates within 60 days', () => {
    expect(sameEdition(obs(), obs({ name: 'SSOW Orlando 2027', startDate: '2027-04-20' }))).toBe(true);
    expect(sameEdition(obs(), obs({ startDate: '2027-06-01' }))).toBe(false);
    expect(sameEdition(obs(), obs({ name: 'SSOW Europe' }))).toBe(false);
  });

  it('matchesTracked tolerates 7 days against an existing event, not more', () => {
    const ev = { name: 'SSOW Orlando', startDate: '2027-03-08', city: 'Orlando', country: 'US' };
    expect(matchesTracked(obs({ startDate: '2027-03-15' }), ev)).toBe(true);
    expect(matchesTracked(obs({ startDate: '2027-03-16' }), ev)).toBe(false);
  });
});

describe('buildGroup', () => {
  it('collects the sectors of every observation, sorted and without repeats', () => {
    const g = buildGroup([
      obs({ sectors: ['pharma'] }),
      obs({ url: 'https://b.example/x', sourceDomain: 'b.example', sectors: ['banking', 'pharma'] }),
      obs({ url: 'https://c.example/x', sourceDomain: 'c.example' }),
    ]);
    expect(g.sectors).toEqual(['banking', 'pharma']);
    expect(buildGroup([obs()]).sectors).toEqual([]);
  });

  it('uses the most common values and breaks date ties with the earliest', () => {
    const g = buildGroup([
      obs({ startDate: '2027-03-09', city: 'Orlando' }), obs({ startDate: '2027-03-08', sourceDomain: 'a.com' }),
      obs({ startDate: '2027-03-08', sourceDomain: 'b.com' }),
    ]);
    expect(g.startDate).toBe('2027-03-08');
    expect(g.city).toBe('Orlando');
    expect(g.key).toBe(rejectionKey('SSOW Orlando', '2027-03-08'));
  });

  it('breaks a date tie with the earliest date', () => {
    const g = buildGroup([obs({ startDate: '2027-03-09' }), obs({ startDate: '2027-03-08', sourceDomain: 'a.com' })]);
    expect(g.startDate).toBe('2027-03-08');
  });
});

describe('decide', () => {
  it('auto-adds at exactly 3 distinct domains with agreement and stays in the inbox at 2', () => {
    const three = buildGroup([
      obs(), obs({ sourceDomain: 'luminik.io' }), obs({ sourceDomain: '10times.com' }),
    ]);
    expect(decide(three, NOW).action).toBe('auto_add');
    const two = buildGroup([obs(), obs({ sourceDomain: 'luminik.io' })]);
    expect(decide(two, NOW)).toEqual({ action: 'inbox', reason: '2 of 3 sites' });
  });

  it('a conflict never auto-adds', () => {
    const g = buildGroup([
      obs(), obs({ sourceDomain: 'a.com' }), obs({ sourceDomain: 'b.com', startDate: '2027-03-15' }),
    ]);
    const verdict = decide(g, NOW);
    expect(verdict.action).toBe('inbox');
    expect(verdict.reason).toMatch(/dates disagree/);
  });

  it('a future start date is required to auto-add', () => {
    for (const startDate of ['2026-10-29', '2026-10-20']) {
      const g = buildGroup(['a.com', 'b.com', 'c.com'].map((sourceDomain) => obs({ sourceDomain, startDate })));
      expect(decide(g, NOW).action, startDate).toBe('inbox');
    }
  });

  it('an unresolvable or missing city goes to the inbox with reason location not found', () => {
    for (const city of ['Nowhereville', null]) {
      const g = buildGroup(['a.com', 'b.com', 'c.com'].map((sourceDomain) => obs({ sourceDomain, city })));
      expect(decide(g, NOW)).toEqual({ action: 'inbox', reason: 'location not found' });
    }
  });
});
