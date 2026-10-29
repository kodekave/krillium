import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { ModelError } from '../../worker/src/discovery/model.js';
import { SourceError } from '../../worker/src/discovery/plan.js';
import { getRun, startRun, stepRun } from '../../worker/src/discovery/run.js';
import { DEFAULT_SETTINGS } from '../../worker/src/discovery/settings.js';
import { rejectCandidate } from '../../worker/src/discovery/store.js';
import { addEvent, eventPage, fakeModel, fakeSearch, resetData } from './helpers.js';

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

function world({ pages = [], feed = [], model } = {}) {
  const search = fakeSearch(pages);
  const aiModel = fakeModel(model);
  const feeds = { calls: [], list: async (spec) => { feeds.calls.push(spec); return feed; } };
  return { search, model: aiModel, feeds, deps: { pages: search, feeds, model: aiModel } };
}

const begin = (s = settings(), user = USER) => startRun(env.DB, user, query, s, NOW);
const step = (runId, w, s = settings()) => stepRun({ db: env.DB, runId, deps: w.deps, settings: s, now: NOW });
const count = async (table, where = '1 = 1') => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first()).n;

beforeEach(resetData);

describe('startRun', () => {
  it('plans the searches and starts running', async () => {
    const run = await begin();
    expect(run).toMatchObject({ status: 'running', planned: 4, done: 0, pages: 0, modelCalls: 0, spendUsd: 0 });
  });

  it('one active run per user', async () => {
    const first = await begin();
    await expect(begin()).rejects.toMatchObject({ status: 409 });
    const other = await begin(settings(), OTHER);
    expect(other.id).not.toBe(first.id);
  });

  it('a run left running for over 15 minutes no longer blocks a new one', async () => {
    await env.DB.prepare("INSERT INTO search_runs (query_json, created_by, started, status) VALUES ('{}', ?, ?, 'running')")
      .bind(USER, new Date(NOW - 20 * 60000).toISOString()).run();
    const run = await begin();
    expect(run.status).toBe('running');
    expect((await env.DB.prepare('SELECT status FROM search_runs ORDER BY id LIMIT 1').first()).status).toBe('failed');
  });

  it('refuses to start while discovery is paused', async () => {
    await expect(begin(settings({ paused: true }))).rejects.toMatchObject({ status: 423 });
  });

  it('getRun and stepRun return null for an unknown run', async () => {
    expect(await getRun(env.DB, 999)).toBeNull();
    expect(await step(999, world())).toBeNull();
  });
});

describe('stepRun', () => {
  it('a step runs one planned search and reports progress', async () => {
    const w = world({ pages: [pageA, pageB, pageOld] });
    const run = await begin();
    const { run: after, items } = await step(run.id, w);
    expect(after).toMatchObject({ status: 'running', done: 1, pages: 3, modelCalls: 1 });
    expect(after.spendUsd).toBeCloseTo(0.002, 6);
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
    expect(w.feeds.calls).toEqual([{ adapter: 'confs', file: 'data', year: 2027 }, { adapter: 'confs', file: 'general', year: 2027 }]);
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
    await env.DB.prepare("INSERT INTO search_runs (query_json, created_by, started, status, model_spend) VALUES ('{}', ?, ?, 'done', 5)")
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
    expect((await getRun(env.DB, run.id)).run.done).toBe(1);
    expect(w.search.calls).toHaveLength(1);
    expect(w.model.calls).toHaveLength(1);
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

  it('a failing model call is noted, its pages are not cached, and the run continues', async () => {
    const w = world({ pages: [pageA], model: { throws: new ModelError(429, 'rate limited') } });
    const run = await begin();
    const result = await step(run.id, w);
    expect(result.run).toMatchObject({ status: 'running', done: 1, modelCalls: 0 });
    expect(result.run.note).toMatch(/model failed: rate limited/);
    expect(result.items).toEqual([]);
    expect(await count('page_cache')).toBe(0);
  });

  it('a missing search source is noted instead of crashing', async () => {
    const w = world();
    const run = await begin();
    const result = await stepRun({ db: env.DB, runId: run.id, deps: { pages: null, feeds: w.feeds, model: w.model }, settings: settings(), now: NOW });
    expect(result.run.note).toMatch(/exa failed: search is not set up/);
  });

  it('a cached page is not sent to the model again', async () => {
    const w = world({ pages: [pageA] });
    const run = await begin();
    await step(run.id, w);
    const second = await step(run.id, w);
    expect(w.model.calls).toHaveLength(1);
    expect(second.run).toMatchObject({ done: 2, pages: 2, modelCalls: 1 });
    expect(await count('candidates')).toBe(1);
    expect(await count('candidate_sources')).toBe(1);
    expect(second.items).toHaveLength(1);
  });

  it('outside calls per step never exceed 3 with 10 pages, and extra pages are ignored', async () => {
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'];
    const pages = names.map((n, i) => eventPage(`https://site${i}.example/e`, { name: `${n} Procurement Forum`, startDate: '2027-05-10', city: 'Berlin', country: 'Germany' }));
    const w = world({ pages });
    const run = await begin();
    const { run: after, items } = await step(run.id, w);
    expect(w.search.calls.length + w.model.calls.length).toBe(3);
    expect(after).toMatchObject({ modelCalls: 2, pages: 10 });
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
    await rejectCandidate(env.DB, seen.items[0].candidateId, USER, NOW);

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
