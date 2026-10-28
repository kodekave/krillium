import { describe, it, expect } from 'vitest';
import { formatRange, daysUntil } from '../../site/js/format.js';

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
