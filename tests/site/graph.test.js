import { describe, it, expect } from 'vitest';
import { buildGraph } from '../../site/js/graph-data.js';
import { createSimulation } from '../../site/js/force-layout.js';
import { parseAsk } from '../../site/js/ask-parse.js';

const events = [
  { id: 'e1', name: 'Event One', status: 'must-attend', priority: 90 },
  { id: 'e2', name: 'Event Two', status: 'watch', priority: 20 },
];
const accountsByEvent = {
  e1: [
    { company: 'Acme', domain: 'acme.test', persona: 'economic_buyer', tier: 'A', role: 'speaker' },
    { company: 'Acme', domain: 'acme.test', persona: 'champion', tier: 'B', role: 'attendee' },
    { company: 'Solo Co', domain: 'solo.test', persona: null, tier: null, role: 'company_only' },
  ],
  e2: [{ company: 'Acme', domain: 'acme.test', persona: 'economic_buyer', tier: 'A', role: 'speaker' }],
};

describe('buildGraph', () => {
  const graph = buildGraph(events, accountsByEvent);
  const ids = graph.nodes.map((n) => n.id);

  it('creates one node per event, company and persona with no duplicate ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(graph.nodes.filter((n) => n.kind === 'event')).toHaveLength(2);
    expect(graph.nodes.filter((n) => n.kind === 'company').map((n) => n.label).sort()).toEqual(['Acme', 'Solo Co']);
    expect(graph.nodes.filter((n) => n.kind === 'persona').map((n) => n.label).sort()).toEqual(['Champion', 'Economic buyer']);
  });

  it('links only between existing nodes, without duplicate links', () => {
    for (const l of graph.links) {
      expect(ids).toContain(l.source);
      expect(ids).toContain(l.target);
    }
    const keys = graph.links.map((l) => `${l.source}>${l.target}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('connects an event to its companies and a company to its personas', () => {
    const has = (a, b) => graph.links.some((l) => l.source === a && l.target === b);
    expect(has('event:e1', 'company:acme.test')).toBe(true);
    expect(has('event:e2', 'company:acme.test')).toBe(true);
    expect(has('company:acme.test', 'persona:economic_buyer')).toBe(true);
    expect(has('company:solo.test', 'persona:economic_buyer')).toBe(false);
  });

  it('survives events with no accounts', () => {
    const g = buildGraph([{ id: 'x', name: 'X', status: 'watch', priority: 1 }], {});
    expect(g.nodes).toHaveLength(1);
    expect(g.links).toEqual([]);
  });
});

describe('createSimulation', () => {
  const graph = buildGraph(events, accountsByEvent);

  it('keeps every position finite and inside the box after settling', () => {
    const sim = createSimulation(graph.nodes, graph.links, { width: 800, height: 500 });
    sim.settle(300);
    for (const n of graph.nodes) {
      expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true);
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(800);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(500);
    }
  });

  it('keeps nodes apart rather than collapsing them onto one point', () => {
    const sim = createSimulation(graph.nodes, graph.links, { width: 800, height: 500 });
    sim.settle(300);
    const [a, b] = graph.nodes;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(10);
  });
});

describe('parseAsk', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');

  it('reads the Tier A question with a month as the next March', () => {
    expect(parseAsk('which events in march have the most tier a buyers', now)).toEqual({
      intent: 'tier_a_by_event', params: { from: '2027-03-01', to: '2027-03-31' },
    });
  });

  it('reads a Tier A question without a date range', () => {
    expect(parseAsk('which events have the most Tier A buyers?', now)).toEqual({ intent: 'tier_a_by_event', params: {} });
  });

  it('reads what changed this week', () => {
    expect(parseAsk('what changed this week', now)).toEqual({ intent: 'changed_this_week', params: {} });
  });

  it('reads a quarter and a rolling window', () => {
    expect(parseAsk('top events in Q1 2027', now)).toEqual({ intent: 'top_events_in_range', params: { from: '2027-01-01', to: '2027-03-31' } });
    expect(parseAsk('events in the next 60 days', now)).toEqual({ intent: 'top_events_in_range', params: { from: '2026-10-29', to: '2026-12-28' } });
  });

  it('uses the upcoming occurrence of a month, including the current year', () => {
    expect(parseAsk('events in december', now).params).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('returns null for text it does not understand', () => {
    expect(parseAsk('hello there', now)).toBeNull();
    expect(parseAsk('', now)).toBeNull();
  });
});
