import { describe, it, expect } from 'vitest';
import { project, unproject, arcPath, pinRadius, dateWindow, distanceKm, nearestBase, fitView } from '../../site/js/map-geometry.js';

const size = { width: 1000, height: 500 };

describe('project', () => {
  it('maps Berlin to finite coordinates inside the box', () => {
    const [x, y] = project(52.52, 13.405, size);
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(size.width);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(size.height);
  });

  it('returns null for missing or non-finite coordinates', () => {
    expect(project(null, null, size)).toBeNull();
    expect(project(undefined, 10, size)).toBeNull();
    expect(project(Number.NaN, 10, size)).toBeNull();
  });

  it('puts New York left of Berlin and Orlando below New York', () => {
    const berlin = project(52.52, 13.405, size);
    const ny = project(40.7128, -74.006, size);
    const orlando = project(28.5383, -81.3792, size);
    expect(ny[0]).toBeLessThan(berlin[0]);
    expect(orlando[1]).toBeGreaterThan(ny[1]);
  });

  it('round-trips through unproject', () => {
    const [x, y] = project(40.7128, -74.006, size);
    const [lat, lon] = unproject(x, y, size);
    expect(lat).toBeCloseTo(40.7128, 3);
    expect(lon).toBeCloseTo(-74.006, 3);
  });
});

describe('arcPath', () => {
  it('starts and ends at its two points and bows upward', () => {
    const d = arcPath([100, 200], [400, 200]);
    expect(d.startsWith('M 100 200')).toBe(true);
    expect(d.endsWith('400 200')).toBe(true);
    const control = d.match(/Q ([\d.-]+) ([\d.-]+)/);
    expect(Number(control[2])).toBeLessThan(200);
  });
});

describe('pinRadius', () => {
  it('increases with priority and stays bounded', () => {
    expect(pinRadius(90)).toBeGreaterThan(pinRadius(20));
    expect(pinRadius(0)).toBeGreaterThan(0);
    expect(pinRadius(100)).toBeLessThanOrEqual(16);
    expect(pinRadius(250)).toBeLessThanOrEqual(16);
  });
});

describe('dateWindow', () => {
  const events = [
    { id: 'march', startDate: '2027-03-08', endDate: '2027-03-11' },
    { id: 'april', startDate: '2027-04-20', endDate: null },
    { id: 'may', startDate: '2027-05-10', endDate: '2027-05-13' },
    { id: 'tbc', startDate: null, endDate: null },
  ];

  it('keeps events overlapping the range, treats a null end date as the start date, and keeps undated events', () => {
    const ids = dateWindow(events, '2027-03-01', '2027-04-30').map((e) => e.id);
    expect(ids).toEqual(['march', 'april', 'tbc']);
  });

  it('keeps events with no dates so they are never silently hidden', () => {
    expect(dateWindow(events, '2030-01-01', '2030-02-01').map((e) => e.id)).toEqual(['tbc']);
  });
});

describe('distance helpers', () => {
  it('measures Berlin to New York at roughly 6,380 km', () => {
    expect(distanceKm(52.52, 13.405, 40.7128, -74.006)).toBeGreaterThan(6300);
    expect(distanceKm(52.52, 13.405, 40.7128, -74.006)).toBeLessThan(6450);
  });

  it('picks Berlin for Estoril and New York for Orlando', () => {
    const bases = [{ name: 'Berlin', lat: 52.52, lon: 13.405 }, { name: 'New York', lat: 40.7128, lon: -74.006 }];
    expect(nearestBase({ lat: 38.7057, lon: -9.3978 }, bases).name).toBe('Berlin');
    expect(nearestBase({ lat: 28.5383, lon: -81.3792 }, bases).name).toBe('New York');
  });
});

describe('fitView', () => {
  it('returns a view box containing every point at the requested aspect', () => {
    const view = fitView([[100, 100], [300, 180]], 2, 40);
    expect(view.x).toBeLessThanOrEqual(100 - 40);
    expect(view.x + view.w).toBeGreaterThanOrEqual(300 + 40);
    expect(view.y).toBeLessThanOrEqual(100 - 40);
    expect(view.y + view.h).toBeGreaterThanOrEqual(180 + 40);
    expect(view.w / view.h).toBeCloseTo(2, 5);
  });
});
