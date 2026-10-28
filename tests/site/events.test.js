import { describe, it, expect } from 'vitest';
import { filterEvents } from '../../site/js/filters.js';

const events = [
  { id: 'a', name: 'BME Symposium', organiser: 'BME', city: 'Berlin', country: 'DE', lon: 13.4, startDate: '2026-11-18', endDate: '2026-11-19', priority: 97, status: 'must-attend' },
  { id: 'b', name: 'Züricher Logistik Tag', organiser: 'SVC', city: 'Zürich', country: 'CH', lon: 8.5, startDate: '2027-02-02', endDate: '2027-02-03', priority: 52, status: 'consider' },
  { id: 'c', name: 'SSOW Orlando', organiser: 'SSON', city: 'Orlando', country: 'US', lon: -81.4, startDate: '2027-03-08', endDate: '2027-03-11', priority: 90, status: 'must-attend' },
  { id: 'd', name: 'Applied AI', organiser: 'DSG', city: 'Schaumburg', country: 'US', lon: -88.1, startDate: '2027-06-22', endDate: null, priority: 27, status: 'watch' },
  { id: 'e', name: 'Unannounced Event', organiser: null, city: null, country: null, lon: null, startDate: null, endDate: null, priority: 20, status: 'watch' },
];
const ids = (list) => list.map((e) => e.id);

describe('filterEvents', () => {
  it('returns everything when no filter is set', () => {
    expect(ids(filterEvents(events, {}))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('filters by minimum priority', () => {
    expect(ids(filterEvents(events, { minScore: 50 }))).toEqual(['a', 'b', 'c']);
  });

  it('filters by status', () => {
    expect(ids(filterEvents(events, { status: 'must-attend' }))).toEqual(['a', 'c']);
  });

  it('filters by date range using the start date when the end date is missing', () => {
    expect(ids(filterEvents(events, { from: '2027-06-01', to: '2027-06-30' }))).toEqual(['d', 'e']);
  });

  it('matches a search without regard to accents or case', () => {
    expect(ids(filterEvents(events, { query: 'Zurich' }))).toEqual(['b']);
    expect(ids(filterEvents(events, { query: 'berlin' }))).toEqual(['a']);
    expect(ids(filterEvents(events, { query: 'zürich' }))).toEqual(['b']);
  });

  it('matches the organiser and country too', () => {
    expect(ids(filterEvents(events, { query: 'sson' }))).toEqual(['c']);
  });

  it('filters by region from longitude and keeps unlocated events only under all', () => {
    expect(ids(filterEvents(events, { region: 'europe' }))).toEqual(['a', 'b']);
    expect(ids(filterEvents(events, { region: 'americas' }))).toEqual(['c', 'd']);
    expect(ids(filterEvents(events, { region: 'all' }))).toContain('e');
  });

  it('combines filters', () => {
    expect(ids(filterEvents(events, { region: 'americas', minScore: 50 }))).toEqual(['c']);
  });
});
