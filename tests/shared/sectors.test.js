import { describe, it, expect } from 'vitest';
import { DEFAULT_SECTORS, cleanSectors, interleaveTopics, sectorId, validateSectors } from '../../site/js/shared/sectors.js';

const sector = (over = {}) => ({ id: 'pharma', name: 'Pharma', topics: ['pharma supply chain'], enabled: true, ...over });

describe('DEFAULT_SECTORS', () => {
  it('starts with the five agreed sectors, all on and all valid', () => {
    expect(DEFAULT_SECTORS.map((s) => s.id)).toEqual(['procurement', 'finance-ops', 'pharma', 'manufacturing', 'banking']);
    expect(DEFAULT_SECTORS.every((s) => s.enabled)).toBe(true);
    expect(validateSectors(DEFAULT_SECTORS)).toEqual([]);
  });

  it('gives every sector 5 or more topics and keeps the earlier procurement topics somewhere', () => {
    expect(DEFAULT_SECTORS.every((s) => s.topics.length >= 5)).toBe(true);
    const all = DEFAULT_SECTORS.flatMap((s) => s.topics).map((t) => t.toLowerCase());
    for (const earlier of ['procure to pay', 'order to cash', 'shared services', 'erp', 'finance automation', 'supply chain', 'distribution']) {
      expect(all, earlier).toContain(earlier);
    }
  });

  it('uses no topic phrase twice', () => {
    const all = DEFAULT_SECTORS.flatMap((s) => s.topics).map((t) => t.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('validateSectors', () => {
  it('accepts valid sectors, including a switched-off one', () => {
    expect(validateSectors([sector(), sector({ id: 'banking', name: 'Banking', enabled: false })])).toEqual([]);
  });

  it('rejects anything that is not 1 to 12 well-formed sectors', () => {
    const many = Array.from({ length: 13 }, (_, i) => sector({ id: `s${i}`, name: `S${i}` }));
    const bad = [
      null, 'x', {}, [], many, ['x'], [null], [[]],
      [sector({ id: 'A b' })], [sector({ id: '' })], [sector({ id: 'x'.repeat(31) })], [sector({ id: '-a' })], [sector({ id: 3 })],
      [sector(), sector({ name: 'Other' })],
      [sector({ name: '' })], [sector({ name: '   ' })], [sector({ name: 'x'.repeat(41) })], [sector({ name: 5 })],
      [sector({ topics: [] })], [sector({ topics: new Array(9).fill('erp').map((t, i) => `${t}${i}`) })], [sector({ topics: [' '] })],
      [sector({ topics: ['a'.repeat(61)] })], [sector({ topics: [1] })], [sector({ topics: 'erp' })],
      [sector({ enabled: 'yes' })], [sector({ enabled: undefined })],
    ];
    for (const list of bad) expect(validateSectors(list).length, JSON.stringify(list)).toBeGreaterThan(0);
  });

  it('says which sector is wrong', () => {
    const errors = validateSectors([sector(), sector({ id: 'banking', name: '' })]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/sector 2/i);
  });

  it('accepts 12 sectors and 8 topics, the largest allowed', () => {
    const topics = Array.from({ length: 8 }, (_, i) => `topic ${i}`);
    const twelve = Array.from({ length: 12 }, (_, i) => sector({ id: `s${i}`, name: `S${i}`, topics }));
    expect(validateSectors(twelve)).toEqual([]);
  });
});

describe('cleanSectors', () => {
  it('trims names and topics, drops other fields and leaves the input alone', () => {
    const input = [{ id: 'p', name: ' Pharma ', topics: [' a ', 'b'], enabled: true, extra: 1 }];
    const cleaned = cleanSectors(input);
    expect(cleaned).toEqual([{ id: 'p', name: 'Pharma', topics: ['a', 'b'], enabled: true }]);
    expect(input[0].name).toBe(' Pharma ');
    expect(cleaned[0].topics).not.toBe(input[0].topics);
  });
});

describe('interleaveTopics', () => {
  it('takes one topic from each sector in turn, so every sector gets searched', () => {
    const list = [{ topics: ['a1', 'a2', 'a3'] }, { topics: ['b1'] }, { topics: ['c1', 'c2'] }];
    expect(interleaveTopics(list)).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  });

  it('keeps a phrase shared by two sectors once, ignoring case', () => {
    expect(interleaveTopics([{ topics: ['ERP', 'x'] }, { topics: ['erp', 'y'] }])).toEqual(['ERP', 'x', 'y']);
  });

  it('is empty for no sectors', () => {
    expect(interleaveTopics([])).toEqual([]);
  });
});

describe('sectorId', () => {
  it('makes a short lowercase slug from the name', () => {
    expect(sectorId('Pharma and life sciences')).toBe('pharma-and-life-sciences');
    expect(sectorId('Banking & Insurance — Ops')).toBe('banking-insurance-ops');
    expect(sectorId('Épargne')).toBe('epargne');
  });

  it('adds a number when the id is taken', () => {
    expect(sectorId('Pharma', ['pharma'])).toBe('pharma-2');
    expect(sectorId('Pharma', ['pharma', 'pharma-2'])).toBe('pharma-3');
  });

  it('falls back to "sector" and never exceeds 30 characters', () => {
    expect(sectorId('???')).toBe('sector');
    expect(sectorId('???', ['sector'])).toBe('sector-2');
    const long = sectorId('x'.repeat(50));
    expect(long).toHaveLength(30);
    expect(sectorId('x'.repeat(50), [long]).length).toBeLessThanOrEqual(30);
    expect(validateSectors([sector({ id: sectorId('x'.repeat(50), [long]) })])).toEqual([]);
  });
});
