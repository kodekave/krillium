import { describe, it, expect } from 'vitest';
import { parseAsk } from '../../site/js/ask-parse.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');

describe('find_events', () => {
  it('find, search, discover and look for phrases return the find_events intent with the remaining text as the query', () => {
    const cases = [
      ['find events about shared services in europe this autumn', 'shared services in europe this autumn'],
      ['Find events on procurement in Berlin', 'procurement in Berlin'],
      ['search for supply chain conferences 2027', 'supply chain conferences 2027'],
      ['search shared services outsourcing', 'shared services outsourcing'],
      ['discover events for finance automation', 'finance automation'],
      ['look for order to cash events in the US', 'order to cash events in the US'],
    ];
    for (const [text, query] of cases) {
      expect(parseAsk(text, NOW), text).toEqual({ intent: 'find_events', params: { query } });
    }
  });

  it('keeps the original wording and cuts the query at 200 characters', () => {
    expect(parseAsk('find events about SAP S/4HANA migrations', NOW).params.query).toBe('SAP S/4HANA migrations');
    expect(parseAsk(`find ${'x'.repeat(300)}`, NOW).params.query).toHaveLength(200);
  });

  it('a bare verb, or nothing left after it, returns null instead of falling through to another intent', () => {
    for (const text of ['find', 'Find  ', 'search for', 'find events', 'look for events about']) {
      expect(parseAsk(text, NOW), text).toBeNull();
    }
  });

  it('only a leading verb starts a search', () => {
    expect(parseAsk('which events can I find in March', NOW).intent).toBe('top_events_in_range');
  });
});

describe('existing intents', () => {
  it('still parse as before', () => {
    expect(parseAsk('Which events have the most Tier A buyers?', NOW)).toEqual({ intent: 'tier_a_by_event', params: {} });
    expect(parseAsk('top buyers in March', NOW)).toEqual({ intent: 'tier_a_by_event', params: { from: '2027-03-01', to: '2027-03-31' } });
    expect(parseAsk('What changed this week?', NOW)).toEqual({ intent: 'changed_this_week', params: {} });
    expect(parseAsk('Events in the next 60 days', NOW)).toEqual({ intent: 'top_events_in_range', params: { from: '2026-10-29', to: '2026-12-28' } });
    expect(parseAsk('events in March', NOW)).toEqual({ intent: 'top_events_in_range', params: { from: '2027-03-01', to: '2027-03-31' } });
  });

  it('give null for text that is none of them', () => {
    expect(parseAsk('hello there', NOW)).toBeNull();
    expect(parseAsk('', NOW)).toBeNull();
  });
});
