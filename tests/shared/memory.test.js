import { describe, expect, it } from 'vitest';
import { MEMORY_KINDS, describeMemory } from '../../site/js/shared/memory.js';

const entry = (kind, detail = {}) => ({ kind, detail });

describe('describeMemory', () => {
  it('knows the eight kinds the Worker records', () => {
    expect(MEMORY_KINDS).toEqual([
      'event.decision', 'candidate.approved', 'candidate.rejected', 'autoadd.undone', 'search.finished', 'icp.saved', 'sectors.saved', 'samples.loaded',
    ]);
  });

  it('says what a person decided about an event', () => {
    expect(describeMemory(entry('event.decision', { choice: 'skip', name: 'Sibos', reason: 'Too small' }))).toBe('Skipped Sibos: Too small');
    expect(describeMemory(entry('event.decision', { choice: 'skip', name: 'Sibos' }))).toBe('Skipped Sibos');
    expect(describeMemory(entry('event.decision', { choice: 'attend', name: 'Sibos' }))).toBe('Chose to attend Sibos');
    expect(describeMemory(entry('event.decision', { choice: 'watch', name: 'Sibos' }))).toBe('Put Sibos on watch');
  });

  it('says what happened to an inbox candidate and an automatic addition', () => {
    expect(describeMemory(entry('candidate.approved', { name: 'SSOW Orlando', siteCount: 2 }))).toBe('Approved SSOW Orlando from the inbox, 2 sites');
    expect(describeMemory(entry('candidate.rejected', { name: 'BME Symposium', siteCount: 1 }))).toBe('Rejected BME Symposium from the inbox, 1 site');
    expect(describeMemory(entry('autoadd.undone', { name: 'SSOW Orlando' }))).toBe('Removed the automatically added SSOW Orlando');
  });

  it('summarises a finished search', () => {
    const text = describeMemory(entry('search.finished', {
      status: 'done', sectors: ['pharma', 'banking'], counts: { auto_added: 2, inbox: 5, tracked: 1, filtered: 9 }, spendUsd: 0.3123,
    }));
    expect(text).toBe('Search finished for 2 sectors: 2 added, 5 for review, 9 filtered ($0.31)');
    expect(describeMemory(entry('search.finished', { status: 'capped', sectors: [], counts: { auto_added: 0, inbox: 0, tracked: 0, filtered: 0 }, spendUsd: 0.5 })))
      .toBe('Search stopped at the budget: 0 added, 0 for review, 0 filtered ($0.50)');
  });

  it('summarises ICP, sector and sample changes', () => {
    expect(describeMemory(entry('icp.saved', { version: 3, changed: ['thresholds', 'weights'] }))).toBe('Saved ICP version 3 (changed thresholds, weights)');
    expect(describeMemory(entry('icp.saved', { version: 2, changed: [] }))).toBe('Saved ICP version 2');
    expect(describeMemory(entry('sectors.saved', { added: ['energy'], removed: ['banking'], edited: ['pharma'], changed: ['dayCapUsd'] })))
      .toBe('Changed sectors: added energy, removed banking, edited pharma; changed dayCapUsd');
    expect(describeMemory(entry('samples.loaded', { count: 10 }))).toBe('Loaded 10 sample events');
  });

  it('marks entries that were copied from earlier history', () => {
    expect(describeMemory(entry('event.decision', { choice: 'attend', name: 'Sibos', backfilled: true }))).toBe('Chose to attend Sibos (from earlier history)');
  });

  it('never fails on an unknown kind or a missing detail', () => {
    expect(describeMemory({ kind: 'something.new' })).toBe('Recorded something.new');
    expect(describeMemory({ kind: 'event.decision' })).toBeTruthy();
    expect(describeMemory({})).toBe('Recorded an event');
  });
});
