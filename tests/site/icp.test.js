import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../../site/js/shared/scoring.js';
import { applyEdit, setDensityShare, describeDraft, previewRanking, createDraftStore } from '../../site/js/icp-draft.js';

const saved = { ...DEFAULT_CONFIG, version: 3 };

const events = [
  { id: 'wide', name: 'High event score', eventScore20: 18, counts: { tierA: 0, tierB: 0, accountOnly: 0 } },
  { id: 'dense', name: 'High ICP density', eventScore20: 10, counts: { tierA: 4, tierB: 0, accountOnly: 0 } },
];

describe('applyEdit', () => {
  it('returns a new config and leaves the original untouched', () => {
    const next = applyEdit(saved, 'thresholds.mustAttend', 80);
    expect(next.thresholds.mustAttend).toBe(80);
    expect(saved.thresholds.mustAttend).toBe(70);
    expect(next).not.toBe(saved);
    expect(next.thresholds).not.toBe(saved.thresholds);
  });

  it('edits array entries by index', () => {
    const next = applyEdit(saved, 'homeBases.1.lat', 41);
    expect(next.homeBases[1].lat).toBe(41);
    expect(saved.homeBases[1].lat).toBe(40.7128);
  });
});

describe('setDensityShare', () => {
  it('keeps the two shares summing to 1', () => {
    const next = setDensityShare(saved, 0.8);
    expect(next.weights.icpDensityShare).toBeCloseTo(0.8, 10);
    expect(next.weights.eventScoreShare).toBeCloseTo(0.2, 10);
  });
});

describe('previewRanking', () => {
  it('re-orders events when the density weight falls', () => {
    const before = previewRanking(events, saved, saved).map((r) => r.id);
    expect(before).toEqual(['dense', 'wide']);
    const draft = setDensityShare(saved, 0.1);
    const after = previewRanking(events, saved, draft);
    expect(after.map((r) => r.id)).toEqual(['wide', 'dense']);
    expect(after[0]).toMatchObject({ rank: 1, previousRank: 2, delta: 1 });
    expect(after[1]).toMatchObject({ rank: 2, previousRank: 1, delta: -1 });
  });

  it('flags an event whose status changes', () => {
    const draft = applyEdit(saved, 'thresholds.mustAttend', 95);
    const row = previewRanking(events, saved, draft).find((r) => r.id === 'dense');
    expect(row.statusChanged).toBe(true);
    expect(row.previousStatus).toBe('must-attend');
    expect(row.status).toBe('consider');
  });
});

describe('describeDraft', () => {
  it('is clean and valid when nothing changed', () => {
    expect(describeDraft(saved, saved)).toEqual({ dirty: false, valid: true, errors: [] });
  });

  it('is dirty and valid after a legal edit', () => {
    const state = describeDraft(saved, applyEdit(saved, 'thresholds.mustAttend', 80));
    expect(state).toMatchObject({ dirty: true, valid: true });
  });

  it('lists the errors of an invalid draft so Save can be disabled', () => {
    const bad = applyEdit(saved, 'thresholds.consider', 90);
    const state = describeDraft(saved, bad);
    expect(state.valid).toBe(false);
    expect(state.errors.join(' ')).toMatch(/consider/);
  });
});

describe('createDraftStore', () => {
  it('keeps the draft in memory across a sign-in interruption', () => {
    const store = createDraftStore();
    const draft = applyEdit(saved, 'thresholds.mustAttend', 80);
    store.set(draft);
    // a 401 shows the sign-in overlay; nothing touches the store
    expect(store.get()).toBe(draft);
    store.clear();
    expect(store.get()).toBeNull();
  });
});

describe('previewRanking with lead inputs', () => {
  const lead = (persona) => ({ fit: 35, persona, eventRole: 'speaker', contact: 'verified_email' });
  const mix = [
    { id: 'econ', name: 'Economic buyers', eventScore20: 10, accountOnly: 0, leads: [lead('economic_buyer'), lead('economic_buyer')] },
    { id: 'champ', name: 'Champions', eventScore20: 10, accountOnly: 0, leads: [lead('champion'), lead('champion'), lead('champion')] },
  ];

  it('re-ranks when persona points change, not only the ranking mix', () => {
    expect(previewRanking(mix, saved, saved).map((r) => r.id)).toEqual(['champ', 'econ']);
    const draft = applyEdit(saved, 'persona.champion', 0);
    expect(previewRanking(mix, saved, draft).map((r) => r.id)).toEqual(['econ', 'champ']);
  });
});
