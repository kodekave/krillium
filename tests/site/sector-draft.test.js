import { describe, it, expect } from 'vitest';
import { addSector, describeSectors, parseTopics, removeSector, topicsText, updateSector } from '../../site/js/sector-draft.js';

const saved = [
  { id: 'pharma', name: 'Pharma', topics: ['clinical supply', 'GxP'], enabled: true },
  { id: 'banking', name: 'Banking', topics: ['fintech'], enabled: false },
];

describe('parseTopics and topicsText', () => {
  it('splits on commas and line breaks, trims, and drops empty and repeated phrases', () => {
    expect(parseTopics(' a, b ,, c\nd ')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseTopics('ERP, erp, Erp')).toEqual(['ERP']);
    expect(parseTopics('  ')).toEqual([]);
    expect(parseTopics(undefined)).toEqual([]);
  });

  it('writes topics back as one comma-separated line', () => {
    expect(topicsText(['a', 'b'])).toBe('a, b');
    expect(topicsText([])).toBe('');
  });
});

describe('editing a draft', () => {
  it('updateSector changes one sector and leaves the input alone', () => {
    const next = updateSector(saved, 1, { name: 'Banking and insurance', enabled: true });
    expect(next[1]).toEqual({ id: 'banking', name: 'Banking and insurance', topics: ['fintech'], enabled: true });
    expect(next[0]).toBe(saved[0]);
    expect(saved[1].name).toBe('Banking');
    expect(updateSector(saved, 9, { name: 'x' })).toEqual(saved);
  });

  it('addSector appends a switched-on sector with a free id and no topics yet', () => {
    const once = addSector(saved);
    expect(once).toHaveLength(3);
    expect(once[2]).toEqual({ id: 'new-sector', name: 'New sector', topics: [], enabled: true });
    expect(addSector(once)[3].id).toBe('new-sector-2');
    expect(saved).toHaveLength(2);
  });

  it('removeSector drops one sector', () => {
    expect(removeSector(saved, 0).map((s) => s.id)).toEqual(['banking']);
    expect(removeSector(saved, 5)).toEqual(saved);
  });
});

describe('describeSectors', () => {
  it('is clean and valid when nothing changed', () => {
    expect(describeSectors(saved, structuredClone(saved))).toEqual({ dirty: false, valid: true, errors: [] });
  });

  it('is dirty and valid after a rename, a switch or a new topic', () => {
    expect(describeSectors(saved, updateSector(saved, 0, { name: 'Pharma and biotech' }))).toMatchObject({ dirty: true, valid: true });
    expect(describeSectors(saved, updateSector(saved, 1, { enabled: true }))).toMatchObject({ dirty: true, valid: true });
    expect(describeSectors(saved, updateSector(saved, 1, { topics: ['fintech', 'treasury'] }))).toMatchObject({ dirty: true, valid: true });
  });

  it('is invalid, with the reason and the sector number, for a blank name or a sector with no topics', () => {
    const blank = describeSectors(saved, updateSector(saved, 1, { name: ' ' }));
    expect(blank.valid).toBe(false);
    expect(blank.errors.join(' ')).toMatch(/sector 2.*name/i);
    const fresh = describeSectors(saved, addSector(saved));
    expect(fresh).toMatchObject({ dirty: true, valid: false });
    expect(fresh.errors.join(' ')).toMatch(/sector 3.*topics/i);
  });

  it('is invalid when every sector is removed', () => {
    expect(describeSectors(saved, [])).toMatchObject({ dirty: true, valid: false });
  });
});
