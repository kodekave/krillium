import { describe, it, expect } from 'vitest';
import { suggestScore } from '../../site/js/shared/suggest.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const BASES = [{ name: 'Berlin', lat: 52.52, lon: 13.405 }, { name: 'New York', lat: 40.7128, lon: -74.006 }];
const EQUATOR = [{ name: 'Origin', lat: 0, lon: 0 }];

const inDays = (n) => new Date(Date.UTC(2026, 9, 29 + n)).toISOString().slice(0, 10);
const score = (over = {}, bases = BASES) =>
  suggestScore({ topicHits: 1, startDate: inDays(100), lat: 52.52, lon: 13.405, ...over }, { homeBases: bases, now: NOW });

describe('suggestScore', () => {
  it('maps topic hits to fit from 1 to 5', () => {
    const fits = [0, 1, 2, 3, 4, 9].map((topicHits) => score({ topicHits }).fit);
    expect(fits).toEqual([1, 2, 3, 4, 5, 5]);
    expect(score({ topicHits: -2 }).fit).toBe(1);
    expect(score({ topicHits: Number.NaN }).fit).toBe(1);
  });

  it('never claims public names before a lineup is read', () => {
    expect(score({ topicHits: 9 }).public_names).toBe(0);
  });

  it('scores timing by days until the start, at every band edge', () => {
    const at = (n) => score({ startDate: inDays(n) }).timing;
    expect([-3, 13].map(at)).toEqual([1, 1]);
    expect([14, 29].map(at)).toEqual([2, 2]);
    expect([30, 59].map(at)).toEqual([3, 3]);
    expect([60, 270].map(at)).toEqual([5, 5]);
    expect([271, 365].map(at)).toEqual([4, 4]);
    expect(at(366)).toBe(3);
    expect(score({ startDate: null }).timing).toBe(1);
  });

  it('scores distance from the nearest home base', () => {
    const at = (lat, lon) => score({ lat, lon }).distance;
    expect(at(52.52, 13.405)).toBe(5); // Berlin, on a base
    expect(at(41.8781, -87.6298)).toBe(4); // Chicago, about 1,150 km from New York
    expect(at(36.1699, -115.1398)).toBe(3); // Las Vegas, about 3,600 km from New York
    expect(at(25.2048, 55.2708)).toBe(2); // Dubai, about 4,500 km from Berlin
    expect(at(-33.8688, 151.2093)).toBe(1); // Sydney
  });

  it('switches band exactly at 500, 1500, 4000 and 8000 km', () => {
    const km = (deg) => score({ lat: 0, lon: deg }, EQUATOR).distance; // one degree of longitude on the equator is 111.195 km
    expect([4.49, 4.51].map(km)).toEqual([5, 4]);
    expect([13.48, 13.5].map(km)).toEqual([4, 3]);
    expect([35.96, 35.98].map(km)).toEqual([3, 2]);
    expect([71.93, 71.95].map(km)).toEqual([2, 1]);
  });

  it('gives distance 1 without coordinates or home bases', () => {
    expect(score({ lat: null, lon: null }).distance).toBe(1);
    expect(score({}, []).distance).toBe(1);
  });
});
