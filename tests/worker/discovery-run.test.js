import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { ModelError } from '../../worker/src/discovery/model.js';
import { SourceError } from '../../worker/src/discovery/plan.js';
import { cancelRun, getRun, startRun, stepRun } from '../../worker/src/discovery/run.js';
import { DEFAULT_SETTINGS } from '../../worker/src/discovery/settings.js';
import { rejectCandidate } from '../../worker/src/discovery/store.js';
import { MODEL_COST, SEARCH_COST, addEvent, countingDb, eventPage, fakeModel, fakeSearch, plain, resetData } from './helpers.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const USER = 'member@example.test';
const OTHER = 'other@example.test';

const orlando = { name: 'SSOW Orlando', startDate: '2027-03-08', city: 'Orlando' };
const pageA = eventPage('https://ssonetwork.com/orlando', orlando);
const pageB = eventPage('https://bme.de/symposium', { name: 'BME Symposium Procurement', startDate: '2027-04-19', city: 'Berlin', country: 'Germany' });
const pageOld = eventPage('https://old.example/summit', { name: 'Old Summit', startDate: '2026-09-01', city: 'Berlin', country: 'Germany' });

// One year in range gives 4 planned searches: two Exa passes, then the Confs.tech data and general files.
const query = { query: 'shared services', from: '2027-01-01', to: '2027-06-30', topics: [] };
const settings = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });

function world({ pages = [], feed = [] } = {}) {
  const search = fakeSearch(pages);
  const feeds = { calls: [], list: async (spec) => { feeds.calls.push(spec); return feed; } };
  return { search, feeds, deps: { pages: search, feeds } };
}

const begin = (s = settings(), user = USER) => startRun(env.DB, 1, user, query, s, NOW);
const step = (runId, w, s = settings()) => stepRun({ db: env.DB, workspaceId: 1, runId, deps: w.deps, settings: s, now: NOW });
const count = async (table, where = '1 = 1') => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first()).n;

// A database whose final batch write, the one that stores a step's items, fails.
function dbThatFailsAtRunItems() {
  const real = env.DB;
  return {
    // bind() returns a new statement, so the SQL text is carried across it for the batch below to recognise.
    prepare: (sql) => {
      const statement = real.prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => Object.assign(bind(...values), { sql });
      return statement;
    },
    batch: async (statements) => {
      if (statements.some((s) => String(s.sql).includes('run_items'))) throw new Error('disk full');
      return real.batch(statements);
    },
  };
}

beforeEach(resetData);

describe('startRun', () => {
  it('plans the searches and starts running', async () => {
    const run = await begin();
    expect(run).toMatchObject({ status: 'running', planned: 4, done: 0, pages: 0, searchCalls: 0, spendUsd: 0 });
  });

  it('one active run per user', async () => {
    const first = await begin();
    await expect(begin()).rejects.toMatchObject({ status: 409 });
    const other = await begin(settings(), OTHER);
    expect(other.id).not.toBe(first.id);
  });

  it('a run left running for over 15 minutes no longer blocks a new one', async () => {
    await env.DB.prepare("INSERT INTO search_runs (workspace_id, query_json, created_by, started, updated, status) VALUES (1, '{}', ?, ?, ?, 'running')")
      .bind(USER, new Date(NOW - 20 * 60000).toISOString(), new Date(NOW - 20 * 60000).toISOString()).run();
    const run = await begin();
    expect(run.status).toBe('running');
    expect((await env.DB.prepare('SELECT status FROM search_runs ORDER BY id LIMIT 1').first()).status).toBe('failed');
  });

  it('refuses to start while discovery is paused', async () => {
    await expect(begin(settings({ paused: true }))).rejects.toMatchObject({ status: 423 });
  });

  it('getRun and stepRun return null for an unknown run', async () => {
    expect(await getRun(env.DB, 1, 999)).toBeNull();
    expect(await step(999, world())).toBeNull();
  });
});

describe('stepRun', () => {
  it('a step runs one planned search and reports progress', async () => {
    const w = world({ pages: [pageA, pageB, pageOld] });
    const run = await begin();
    const { run: after, items } = await step(run.id, w);
    expect(after).toMatchObject({ status: 'running', done: 1, pages: 3, searchCalls: 1 });
    expect(after.spendUsd).toBeCloseTo(SEARCH_COST, 6);
    expect(w.search.calls).toHaveLength(1);
    expect(items.find((i) => i.name === 'SSOW Orlando')).toMatchObject({
      outcome: 'inbox', reason: '1 of 3 sites', domains: ['ssonetwork.com'], startDate: '2027-03-08', city: 'Orlando',
    });
    expect(items.find((i) => i.name === 'Old Summit')).toMatchObject({ outcome: 'filtered', reason: 'past' });
  });

  it('the run ends done after the last planned search, and repeating a completed step is a no-op', async () => {
    const w = world({ pages: [pageA] });
    const run = await begin();
    let state;
    for (let i = 0; i < 4; i += 1) state = await step(run.id, w);
    expect(state.run).toMatchObject({ status: 'done', done: 4 });
    expect((await env.DB.prepare('SELECT finished FROM search_runs WHERE id = ?').bind(run.id).first()).finished).not.toBeNull();
    const calls = w.search.calls.length;
    const again = await step(run.id, w);
    expect(again.run).toMatchObject({ status: 'done', done: 4 });
    expect(w.search.calls).toHaveLength(calls);
    expect(w.feeds.calls).toEqual([
      expect.objectContaining({ adapter: 'confs', file: 'data', year: 2027, from: '2027-01-01', to: '2027-06-30', terms: ['shared', 'services'] }),
      expect.objectContaining({ adapter: 'confs', file: 'general', year: 2027 }),
    ]);
  });

  it('reaching the run cap stops the run, keeps earlier results and says which cap', async () => {
    const w = world({ pages: [pageA] });
    const s = settings({ runCapUsd: 0.001 });
    const run = await begin(s);
    await step(run.id, w, s);
    const second = await step(run.id, w, s);
    expect(second.run).toMatchObject({ status: 'capped', done: 1 });
    expect(second.run.note).toMatch(/Budget reached: run budget/);
    expect(second.items).toHaveLength(1);
    expect(w.search.calls).toHaveLength(1);
  });

  it('reaching the page limit stops the run', async () => {
    const w = world({ pages: [pageA, pageB] });
    const s = settings({ maxPages: 2 });
    const run = await begin(s);
    await step(run.id, w, s);
    expect((await step(run.id, w, s)).run).toMatchObject({ status: 'capped' });
  });

  it('reaching the day cap stops the run before any work', async () => {
    await env.DB.prepare("INSERT INTO search_runs (workspace_id, query_json, created_by, started, status, model_spend) VALUES (1, '{}', ?, ?, 'done', 5)")
      .bind(OTHER, '2026-10-29T08:00:00.000Z').run();
    const w = world({ pages: [pageA] });
    const run = await begin();
    const result = await step(run.id, w);
    expect(result.run.status).toBe('capped');
    expect(result.run.note).toMatch(/daily budget/);
    expect(w.search.calls).toHaveLength(0);
  });

  it('the pause switch stops a step without work', async () => {
    const w = world({ pages: [pageA] });
    const run = await begin();
    const result = await step(run.id, w, settings({ paused: true }));
    expect(result.run.status).toBe('paused');
    expect(w.search.calls).toHaveLength(0);
    expect((await step(run.id, w)).run.status).toBe('paused');
    expect(w.search.calls).toHaveLength(0);
  });

  it('two concurrent steps advance the run exactly once and create no duplicate candidates or sources', async () => {
    const w = world({ pages: [pageA] });
    const run = await begin();
    await Promise.all([step(run.id, w), step(run.id, w)]);
    expect((await getRun(env.DB, 1, run.id)).run.done).toBe(1);
    expect(w.search.calls).toHaveLength(1);
    expect(await count('candidates')).toBe(1);
    expect(await count('candidate_sources')).toBe(1);
  });

  it('a failing search source is skipped and noted and the run continues', async () => {
    const w = world({ pages: (_spec, n) => (n === 1 ? new SourceError(500, 'boom') : [pageA]) });
    const run = await begin();
    const first = await step(run.id, w);
    expect(first.run).toMatchObject({ status: 'running', done: 1 });
    expect(first.run.note).toMatch(/exa failed: boom/);
    expect(first.items).toEqual([]);
    const second = await step(run.id, w);
    expect(second.items).toHaveLength(1);
  });

  it('pages Exa returned no readable summary for are noted and paid for, and the run continues', async () => {
    const w = world({ pages: [{ ...pageA, summary: 'Sorry, nothing here.' }, pageB] });
    const run = await begin();
    const result = await step(run.id, w);
    expect(result.run).toMatchObject({ status: 'running', done: 1, pages: 2, searchCalls: 1 });
    expect(result.run.note).toMatch(/1 of 2 pages had no readable summary/);
    expect(result.run.spendUsd).toBeCloseTo(SEARCH_COST, 6);
    expect(result.items.map((i) => i.name)).toEqual(['BME Symposium Procurement']);
  });

  it('a missing search source is noted instead of crashing', async () => {
    const w = world();
    const run = await begin();
    const result = await stepRun({ db: env.DB, workspaceId: 1, runId: run.id, deps: { pages: null, feeds: w.feeds }, settings: settings(), now: NOW });
    expect(result.run.note).toMatch(/exa failed: search is not set up/);
  });

  it('the same page found in two steps adds no second candidate or source', async () => {
    const w = world({ pages: [pageA] });
    const run = await begin();
    await step(run.id, w);
    const second = await step(run.id, w);
    expect(second.run).toMatchObject({ done: 2, pages: 2, searchCalls: 2 });
    expect(await count('candidates')).toBe(1);
    expect(await count('candidate_sources')).toBe(1);
    expect(second.items).toHaveLength(1);
  });

  it('a step makes one outside call, and pages beyond 10 are ignored', async () => {
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'];
    const pages = names.map((n, i) => eventPage(`https://site${i}.example/e`, { name: `${n} Procurement Forum`, startDate: '2027-05-10', city: 'Berlin', country: 'Germany' }));
    const w = world({ pages });
    const run = await begin();
    const { run: after, items } = await step(run.id, w);
    expect(w.search.calls).toHaveLength(1);
    expect(after).toMatchObject({ searchCalls: 1, pages: 10 });
    expect(items).toHaveLength(10);
  });

  it('filtered items are stored with their reason, including details the page text could not confirm', async () => {
    const cancelled = eventPage('https://c.example/x', { name: 'Cancelled Forum', startDate: '2027-05-10', city: 'Berlin', cancelled: true });
    const fuzzy = eventPage('https://d.example/x', { name: 'Fuzzy Dates Congress', startDate: '2027-05-10', city: 'Berlin', badDate: true });
    const w = world({ pages: [cancelled, fuzzy] });
    const run = await begin();
    const { items } = await step(run.id, w);
    expect(items.find((i) => i.name === 'Cancelled Forum')).toMatchObject({ outcome: 'filtered', reason: 'cancelled' });
    expect(items.find((i) => i.url === 'https://d.example/x')).toMatchObject({ outcome: 'filtered', reason: 'unverified' });
    expect(await count('run_items', "outcome = 'filtered'")).toBe(2);
  });

  it('a candidate matching a tracked event is reported as tracked and gains a source', async () => {
    await addEvent({ id: 'ssow-orl', name: 'SSOW Orlando', city: 'Orlando', country: 'US', start_date: '2027-03-08' });
    const w = world({ pages: [pageA] });
    const run = await begin();
    const { items } = await step(run.id, w);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ outcome: 'tracked', eventId: 'ssow-orl' });
    expect(await count('event_sources', "event_id = 'ssow-orl'")).toBe(1);
    expect(await count('candidates')).toBe(0);
  });

  it('three sites found across steps auto-add the event once', async () => {
    const second = eventPage('https://luminik.io/ssow', orlando);
    const third = eventPage('https://10times.com/ssow', orlando);
    const w = world({ pages: (_spec, n) => (n === 1 ? [pageA, second] : [third]) });
    const run = await begin();
    const first = await step(run.id, w);
    expect(first.items[0]).toMatchObject({ outcome: 'inbox', reason: '2 of 3 sites' });
    const last = await step(run.id, w);
    expect(last.items).toHaveLength(1);
    expect(last.items[0]).toMatchObject({ outcome: 'auto_added' });
    const event = await env.DB.prepare('SELECT origin, auto_added FROM events WHERE id = ?').bind(last.items[0].eventId).first();
    expect(event).toEqual({ origin: 'discovered', auto_added: 1 });
  });

  it('a feed observation becomes an inbox candidate from its own site', async () => {
    const feed = [{
      name: 'AI Data Summit', organiser: null, startDate: '2027-05-10', endDate: null, city: 'Berlin', country: 'DE', online: false,
      cancelled: false, url: 'https://aidata.example', sourceDomain: 'confs.tech', adapter: 'confs', title: 'AI Data Summit', quotes: null, topicHits: 0,
    }];
    const w = world({ feed });
    const run = await begin();
    await step(run.id, w);
    await step(run.id, w);
    const result = await step(run.id, w);
    expect(result.items[0]).toMatchObject({ outcome: 'inbox', domains: ['confs.tech'], name: 'AI Data Summit' });
  });

  it('a rejected event never returns from a search or from a feed', async () => {
    const first = world({ pages: [pageA] });
    const run1 = await begin();
    const seen = await step(run1.id, first);
    await rejectCandidate(env.DB, 1, seen.items[0].candidateId, USER, NOW);

    const again = eventPage('https://luminik.io/ssow', orlando);
    const viaSearch = world({ pages: [again] });
    const run2 = await begin(settings(), OTHER);
    const searched = await step(run2.id, viaSearch);
    expect(searched.items).toEqual([expect.objectContaining({ outcome: 'filtered', reason: 'rejected' })]);

    const feed = [{
      name: 'SSOW Orlando', organiser: null, startDate: '2027-03-08', endDate: null, city: 'Orlando', country: 'US', online: false,
      cancelled: false, url: 'https://ssow.example', sourceDomain: 'confs.tech', adapter: 'confs', title: 'SSOW Orlando', quotes: null, topicHits: 0,
    }];
    const viaFeed = world({ feed });
    const run3 = await begin(settings(), 'third@example.test');
    await step(run3.id, viaFeed);
    await step(run3.id, viaFeed);
    const fed = await step(run3.id, viaFeed);
    expect(fed.items).toEqual([expect.objectContaining({ outcome: 'filtered', reason: 'rejected' })]);
    expect(await count('candidates')).toBe(1);
  });
});

describe('what a failing step must not lose', () => {
  it('spend is recorded as soon as Exa has answered, even when the step then fails', async () => {
    const w = world({ pages: [pageA] });
    const run = await begin();
    const result = await stepRun({ db: dbThatFailsAtRunItems(), workspaceId: 1, runId: run.id, deps: w.deps, settings: settings(), now: NOW });
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toMatch(/disk full/);
    expect(result.run).toMatchObject({ searchCalls: 1 });
    expect(result.run.spendUsd).toBeCloseTo(SEARCH_COST, 6);
  });
});

describe('sector tagging', () => {
  const candidateSectors = async () => JSON.parse((await env.DB.prepare('SELECT sectors FROM candidates').first()).sectors);
  const feed = [{
    name: 'AI Data Summit', organiser: null, startDate: '2027-05-10', endDate: null, city: 'Berlin', country: 'DE', online: false,
    cancelled: false, url: 'https://aidata.example', sourceDomain: 'confs.tech', adapter: 'confs', title: 'AI Data Summit', quotes: null, topicHits: 0,
  }];

  it('tags what a one-sector search finds with that sector, even when the page names none of its topics', async () => {
    const w = world({ pages: [pageA] });
    const run = await startRun(env.DB, 1, USER, { ...query, sectors: ['pharma'] }, settings(), NOW);
    const { items } = await step(run.id, w);
    expect(items[0]).toMatchObject({ name: 'SSOW Orlando', outcome: 'inbox' });
    expect(await candidateSectors()).toEqual(['pharma']);
  });

  it('a search over several sectors tags only what the page itself shows', async () => {
    // BME's page names "procurement" (in its title) and "fintech", so it belongs to two sectors; SSOW's page names no topic
    const w = world({ pages: [pageA, { ...pageB, text: `${pageB.text} Fintech and treasury track.` }] });
    const run = await startRun(env.DB, 1, USER, { ...query, sectors: ['pharma', 'banking'] }, settings(), NOW);
    await step(run.id, w);
    const rows = (await env.DB.prepare('SELECT name, sectors FROM candidates ORDER BY name').all()).results;
    expect(rows.map((r) => [r.name, JSON.parse(r.sectors)])).toEqual([
      ['BME Symposium Procurement', ['banking', 'procurement']],
      ['SSOW Orlando', []],
    ]);
  });

  it('a sector that is switched off marks nothing', async () => {
    const off = settings({ sectors: DEFAULT_SETTINGS.sectors.map((s) => (s.id === 'banking' ? { ...s, enabled: false } : s)) });
    const w = world({ pages: [{ ...pageA, text: `${pageA.text} Fintech and treasury track.` }] });
    const run = await startRun(env.DB, 1, USER, { ...query, sectors: [] }, off, NOW);
    await step(run.id, w, off);
    expect(await candidateSectors()).toEqual([]);
  });

  it('a feed result is tagged with the sector of a one-sector search', async () => {
    const w = world({ feed });
    const run = await startRun(env.DB, 1, USER, { ...query, sectors: ['pharma'] }, settings(), NOW);
    for (let i = 0; i < 3; i += 1) await step(run.id, w);
    expect(await candidateSectors()).toEqual(['pharma']);
  });

  it('a search saved before sectors existed still runs, with nothing to tag', async () => {
    const w = world({ pages: [pageA] });
    const run = await begin();
    const { items } = await step(run.id, w);
    expect(items).toHaveLength(1);
    expect(await candidateSectors()).toEqual([]);
  });
});

describe('the chosen dates', () => {
  it('events outside them are filtered with a reason and events inside them are kept', async () => {
    const w = world({ pages: [pageA, pageB] });
    const run = await startRun(env.DB, 1, USER, { ...query, from: '2027-04-01', to: '2027-06-30' }, settings(), NOW);
    const { items } = await step(run.id, w);
    expect(items.find((i) => i.name === 'SSOW Orlando')).toMatchObject({ outcome: 'filtered', reason: 'outside_dates' });
    expect(items.find((i) => i.name === 'BME Symposium Procurement')).toMatchObject({ outcome: 'inbox' });
    expect(await count('candidates')).toBe(1);
  });
});

describe('the free plan allows 50 database queries per request', () => {
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];
  const pagesOf = (n) => names.slice(0, n).map((name, i) => eventPage(`https://q${n}-${i}.example/e`, { name: `${name} Procurement Forum`, startDate: '2027-05-10', city: 'Berlin', country: 'Germany' }));

  it('a step that finds 5 new events stays well inside it', async () => {
    const counter = countingDb();
    const w = world({ pages: pagesOf(5) });
    const run = await begin();
    const result = await stepRun({ db: counter.db, workspaceId: 1, runId: run.id, deps: w.deps, settings: settings(), now: NOW });
    expect(result.items).toHaveLength(5);
    expect(counter.count()).toBeLessThanOrEqual(35);
  });

  it('a step that finds 10 new events stays inside it', async () => {
    const counter = countingDb();
    const w = world({ pages: pagesOf(10) });
    const run = await begin();
    const result = await stepRun({ db: counter.db, workspaceId: 1, runId: run.id, deps: w.deps, settings: settings(), now: NOW });
    expect(result.items).toHaveLength(10);
    expect(counter.count()).toBeLessThanOrEqual(50);
  });
});

describe('reading the pages with Claude when an Anthropic key is set', () => {
  const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'];
  const forumPages = (n) => NAMES.slice(0, n).map((name, i) => eventPage(`https://claude${n}-${i}.example/e`, { name: `${name} Procurement Forum`, startDate: '2027-05-10', city: 'Berlin', country: 'Germany' }));

  // Exa is not asked for summaries in this mode, so its pages come back plain.
  function claudeWorld(pages, modelOptions) {
    const w = world({ pages: pages.map(plain) });
    w.model = fakeModel(modelOptions);
    w.deps.model = w.model;
    return w;
  }

  it('Claude reads the pages, and its cost is added to the search cost', async () => {
    const w = claudeWorld([pageA, pageB, pageOld]);
    const run = await begin();
    const { run: after, items } = await step(run.id, w);
    expect(w.model.calls).toHaveLength(1);
    expect(after).toMatchObject({ status: 'running', done: 1, pages: 3, searchCalls: 1 });
    expect(after.spendUsd).toBeCloseTo(SEARCH_COST + MODEL_COST, 6);
    expect(items.find((i) => i.name === 'SSOW Orlando')).toMatchObject({ outcome: 'inbox', reason: '1 of 3 sites' });
    expect(items.find((i) => i.name === 'Old Summit')).toMatchObject({ outcome: 'filtered', reason: 'past' });
  });

  it('a page Claude has read is not sent to it again', async () => {
    const w = claudeWorld([pageA]);
    const run = await begin();
    await step(run.id, w);
    const second = await step(run.id, w);
    expect(w.model.calls).toHaveLength(1);
    expect(second.run).toMatchObject({ done: 2, pages: 2, searchCalls: 2 });
    expect(second.run.spendUsd).toBeCloseTo(2 * SEARCH_COST + MODEL_COST, 6);
    expect(await count('candidates')).toBe(1);
    expect(await count('candidate_sources')).toBe(1);
    expect(second.items).toHaveLength(1);
  });

  it('a failing Claude call is noted, its pages are not remembered, and the run continues', async () => {
    const w = claudeWorld([pageA], { throws: new ModelError(429, 'rate limited') });
    const run = await begin();
    const result = await step(run.id, w);
    expect(result.run).toMatchObject({ status: 'running', done: 1, searchCalls: 1 });
    expect(result.run.note).toMatch(/model failed: rate limited/);
    expect(result.run.spendUsd).toBeCloseTo(SEARCH_COST, 6);
    expect(result.items).toEqual([]);
    expect(await count('page_cache')).toBe(0);
  });

  it('an answer that cannot be read is noted and not remembered, so the pages are tried again', async () => {
    const w = claudeWorld([pageA]);
    const inner = w.model;
    const calls = [];
    w.deps.model = { calls, extract: async (req) => (calls.push(req), calls.length === 1 ? { text: 'Sorry, I cannot help.', usage: { input: 500, output: 20 } } : inner.extract(req)) };
    const run = await begin();
    const first = await step(run.id, w);
    expect(first.run.note).toMatch(/1 of 1 pages had no readable summary/);
    expect(first.run.spendUsd).toBeCloseTo(SEARCH_COST + 0.0006, 6);
    expect(first.items).toEqual([]);
    expect(await count('page_cache')).toBe(0);
    const second = await step(run.id, w);
    expect(calls).toHaveLength(2);
    expect(second.items[0]).toMatchObject({ outcome: 'inbox', name: 'SSOW Orlando' });
  });

  it('a step makes at most 3 outside calls with 10 pages, and extra pages are ignored', async () => {
    const w = claudeWorld(forumPages(12));
    const run = await begin();
    const { run: after, items } = await step(run.id, w);
    expect(w.search.calls.length + w.model.calls.length).toBe(3);
    expect(after).toMatchObject({ searchCalls: 1, pages: 10 });
    expect(items).toHaveLength(10);
  });

  it("Claude's cost is recorded as soon as it has answered, even when the step then fails", async () => {
    const w = claudeWorld([pageA]);
    const run = await begin();
    const result = await stepRun({ db: dbThatFailsAtRunItems(), workspaceId: 1, runId: run.id, deps: w.deps, settings: settings(), now: NOW });
    expect(result.run.status).toBe('failed');
    expect(result.run.spendUsd).toBeCloseTo(SEARCH_COST + MODEL_COST, 6);
  });

  it('a step that finds 10 new events stays inside 50 database queries', async () => {
    const counter = countingDb();
    const w = claudeWorld(forumPages(10));
    const run = await begin();
    const result = await stepRun({ db: counter.db, workspaceId: 1, runId: run.id, deps: w.deps, settings: settings(), now: NOW });
    expect(result.items).toHaveLength(10);
    expect(counter.count()).toBeLessThanOrEqual(50);
  });
});

describe('stopping a run', () => {
  it('ends it on the server so the user can search again, and a stopped run does no more work', async () => {
    const w = world({ pages: [pageA] });
    const run = await begin();
    await step(run.id, w);
    const stopped = await cancelRun(env.DB, 1, run.id, USER, 'member', NOW);
    expect(stopped.run.status).toBe('stopped');
    const calls = w.search.calls.length;
    expect((await step(run.id, w)).run.status).toBe('stopped');
    expect(w.search.calls).toHaveLength(calls);
    expect((await begin()).status).toBe('running');
  });

  it('only its owner or an admin can stop it, and an unknown run is null', async () => {
    const run = await begin();
    await expect(cancelRun(env.DB, 1, run.id, OTHER, 'member', NOW)).rejects.toMatchObject({ status: 403 });
    expect((await cancelRun(env.DB, 1, run.id, OTHER, 'admin', NOW)).run.status).toBe('stopped');
    expect(await cancelRun(env.DB, 1, 999, USER, 'member', NOW)).toBeNull();
  });

  it('a run is abandoned after 15 minutes without activity, not 15 minutes after it started', async () => {
    const insert = (started, updated) => env.DB.prepare("INSERT INTO search_runs (workspace_id, query_json, created_by, started, updated, status) VALUES (1, '{}', ?, ?, ?, 'running')")
      .bind(USER, started, updated).run();
    await insert(new Date(NOW - 60 * 60000).toISOString(), new Date(NOW - 2 * 60000).toISOString());
    await expect(begin()).rejects.toMatchObject({ status: 409 });
    await env.DB.prepare('DELETE FROM search_runs').run();
    await insert(new Date(NOW - 60 * 60000).toISOString(), new Date(NOW - 20 * 60000).toISOString());
    expect((await begin()).status).toBe('running');
  });

  it('two starts at once give one run and one clear refusal', async () => {
    const results = await Promise.allSettled([begin(), begin()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ status: 409 });
  });
});
