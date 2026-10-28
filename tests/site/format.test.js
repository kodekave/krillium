import { describe, it, expect } from 'vitest';
import { formatRange, daysUntil, monthsSpan } from '../../site/js/format.js';

describe('formatRange', () => {
  it('formats a range inside one month', () => {
    expect(formatRange('2026-11-18', '2026-11-19')).toBe('18–19 Nov 2026');
  });
  it('formats a range across months', () => {
    expect(formatRange('2027-03-30', '2027-04-02')).toBe('30 Mar – 2 Apr 2027');
  });
  it('formats a range across years', () => {
    expect(formatRange('2026-12-30', '2027-01-02')).toBe('30 Dec 2026 – 2 Jan 2027');
  });
  it('formats a single day when the end date is missing or equal', () => {
    expect(formatRange('2027-03-08', null)).toBe('8 Mar 2027');
    expect(formatRange('2027-03-08', '2027-03-08')).toBe('8 Mar 2027');
  });
  it('says Dates TBC when there is no start date', () => {
    expect(formatRange(null, null)).toBe('Dates TBC');
  });
});

describe('daysUntil', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  it('counts whole days to a future start', () => {
    expect(daysUntil('2026-11-18', now)).toBe(20);
  });
  it('is negative for a past date and null when unknown', () => {
    expect(daysUntil('2026-10-21', now)).toBeLessThan(0);
    expect(daysUntil(null, now)).toBeNull();
  });
});

describe('formatRange with unusable dates', () => {
  it('says Dates TBC instead of NaN for a date that is not ISO', () => {
    expect(formatRange('11/18/2026', null)).toBe('Dates TBC');
    expect(formatRange('2026-18-11', '2026-19-11')).toBe('Dates TBC');
  });
});

describe('monthsSpan', () => {
  it('lists every month from the earliest to the latest valid date', () => {
    const months = monthsSpan([{ startDate: '2026-10-21', endDate: '2026-10-22' }, { startDate: '2027-01-19', endDate: null }]);
    expect(months).toEqual([{ y: 2026, m: 10 }, { y: 2026, m: 11 }, { y: 2026, m: 12 }, { y: 2027, m: 1 }]);
  });

  it('ignores dates that are not valid ISO dates and never loops forever', () => {
    const months = monthsSpan([{ startDate: '2026-18-11', endDate: null }, { startDate: '11/18/2026', endDate: null }, { startDate: '2027-03-08', endDate: null }]);
    expect(months).toEqual([{ y: 2027, m: 3 }]);
  });

  it('caps the span and returns nothing when there are no dates', () => {
    expect(monthsSpan([{ startDate: '1900-01-01', endDate: '2099-12-31' }]).length).toBeLessThanOrEqual(120);
    expect(monthsSpan([{ startDate: null, endDate: null }])).toEqual([]);
  });
});
