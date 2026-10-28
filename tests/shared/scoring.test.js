import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONFIG,
  leadScore,
  tierFor,
  icpDensity,
  eventPriority,
  statusFor,
  rankEvents,
  validateConfig,
} from '../../site/js/shared/scoring.js';

const cfg = DEFAULT_CONFIG;

describe('leadScore', () => {
  it('scores the three pushed case-study leads at 95', () => {
    const score = leadScore(
      { fit: 35, persona: 'economic_buyer', eventRole: 'speaker', contact: 'verified_email' },
      cfg,
    );
    expect(score).toBe(95);
  });

  it('scores a champion speaker with a verified email at 87', () => {
    const score = leadScore(
      { fit: 35, persona: 'champion', eventRole: 'speaker', contact: 'verified_email' },
      cfg,
    );
    expect(score).toBe(87);
  });

  it('gives no persona points when the persona is unknown', () => {
    const score = leadScore(
      { fit: 20, persona: null, eventRole: 'company_only', contact: 'none' },
      cfg,
    );
    expect(score).toBe(28);
  });
});

describe('tierFor', () => {
  it('cuts tiers at 75 and 55', () => {
    expect(tierFor(75, cfg)).toBe('A');
    expect(tierFor(74, cfg)).toBe('B');
    expect(tierFor(55, cfg)).toBe('B');
    expect(tierFor(54, cfg)).toBe('C');
  });
});

describe('icpDensity', () => {
  it('weights tier A 3, tier B 1 and account-only 0.5', () => {
    expect(icpDensity({ tierA: 2, tierB: 1, accountOnly: 2 }, cfg)).toBe(8);
  });
});

describe('eventPriority', () => {
  it('blends event score and ICP density 40/60', () => {
    const event = { eventScore20: 15, counts: { tierA: 2, tierB: 1, accountOnly: 2 } };
    expect(eventPriority(event, 16, cfg)).toBe(60);
  });

  it('ranks from the event score alone when no event has any ICP density', () => {
    const event = { eventScore20: 20, counts: { tierA: 0, tierB: 0, accountOnly: 0 } };
    const priority = eventPriority(event, 0, cfg);
    expect(Number.isFinite(priority)).toBe(true);
    expect(priority).toBe(40);
  });
});

describe('statusFor', () => {
  it('cuts statuses at 70 and 45', () => {
    expect(statusFor(70, cfg)).toBe('must-attend');
    expect(statusFor(69.9, cfg)).toBe('consider');
    expect(statusFor(45, cfg)).toBe('consider');
    expect(statusFor(44.9, cfg)).toBe('watch');
  });
});

describe('rankEvents', () => {
  const events = [
    { id: 'low', eventScore20: 18, counts: { tierA: 0, tierB: 0, accountOnly: 0 } },
    { id: 'high', eventScore20: 10, counts: { tierA: 4, tierB: 0, accountOnly: 0 } },
  ];

  it('sorts by priority descending and adds priority and status', () => {
    const ranked = rankEvents(events, cfg);
    expect(ranked.map((e) => e.id)).toEqual(['high', 'low']);
    expect(ranked[0].priority).toBe(80);
    expect(ranked[0].status).toBe('must-attend');
    expect(ranked[1].priority).toBe(36);
    expect(ranked[1].status).toBe('watch');
  });

  it('does not mutate its input', () => {
    rankEvents(events, cfg);
    expect(events[0]).not.toHaveProperty('priority');
  });
});

describe('validateConfig', () => {
  it('accepts the default config', () => {
    expect(validateConfig(cfg)).toEqual({ ok: true, errors: [] });
  });

  it('rejects event and density shares that do not sum to 1', () => {
    const bad = structuredClone(cfg);
    bad.weights.icpDensityShare = 0.8;
    const result = validateConfig(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/sum to 1/);
  });

  it('rejects a consider threshold at or above must-attend', () => {
    const bad = structuredClone(cfg);
    bad.thresholds.consider = 70;
    const result = validateConfig(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/consider/);
  });

  it('rejects a tier B cut-off at or above tier A', () => {
    const bad = structuredClone(cfg);
    bad.thresholds.tierB = 75;
    expect(validateConfig(bad).ok).toBe(false);
  });
});

describe('validateConfig required tables', () => {
  it.each(['density', 'persona', 'eventRole', 'contact'])('rejects a config with no %s table', (table) => {
    const bad = structuredClone(cfg);
    delete bad[table];
    const result = validateConfig(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain(table);
  });
});
