import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGroup } from '../../site/js/shared/discovery.js';
import { fitDetail, listMemory, remember, summariseRun } from '../../worker/src/memory.js';
import { cancelRun, startRun, stepRun } from '../../worker/src/discovery/run.js';
import { DEFAULT_SETTINGS } from '../../worker/src/discovery/settings.js';
import { processGroups, saveGroup } from '../../worker/src/discovery/store.js';
import { createHandler } from '../../worker/src/index.js';
import {
  SEARCH_COST, addCompany, addEvent, addPerson, addUser, addWorkspace, attend, call, countingDb, eventPage, fakeSearch, resetData, tokenFor,
} from './helpers.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const A = 'a@example.test';
const B = 'b@example.test';
let handler;
let tokenA;
let tokenB;
let ws2;

const memoryRows = async (workspaceId = 1) =>
  (await env.DB.prepare('SELECT actor, kind, subject, detail FROM memory WHERE workspace_id = ? ORDER BY id').bind(workspaceId).all())
    .results.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
const post = (path, token, body) => call(handler, path, { method: 'POST', token, body });

const obs = (over = {}) => ({
  name: 'SSOW Orlando', organiser: 'SSON', startDate: '2027-03-08', endDate: '2027-03-11', city: 'Orlando', country: 'US',
  online: false, cancelled: false, url: 'https://ssonetwork.com/orlando', sourceDomain: 'ssonetwork.com', adapter: 'exa',
  title: 'SSOW Orlando', quotes: { name: 'SSOW Orlando', dates: '8-11 March 2027' }, topicHits: 1, ...over,
});
const threeSites = (over = {}) => buildGroup([
  obs(over), obs({ ...over, sourceDomain: 'luminik.io', url: 'https://luminik.io/x' }), obs({ ...over, sourceDomain: '10times.com', url: 'https://10times.com/x' }),
]);

beforeEach(async () => {
  await resetData();
  handler = createHandler();
  ws2 = await addWorkspace({ name: 'Bravo team' });
  await addUser({ email: A, role: 'admin' });
  await addUser({ email: B, role: 'admin', workspaceId: ws2 });
  tokenA = await tokenFor({ email: A, role: 'admin' });
  tokenB = await tokenFor({ email: B, role: 'admin' });
});

describe('remember, fitDetail and listMemory', () => {
  it('writes many entries in one statement', async () => {
    const counter = countingDb();
    const ok = await remember(counter.db, 1, [
      { actor: A, kind: 'event.decision', subject: 'e1', detail: { choice: 'attend' } },
      { actor: A, kind: 'icp.saved', subject: 2, detail: { version: 2 } },
      { actor: 'system', kind: 'samples.loaded', detail: { count: 10 } },
    ]);
    expect(ok).toBe(true);
    expect(counter.count()).toBe(1);
    const rows = await memoryRows();
    expect(rows.map((r) => [r.actor, r.kind, r.subject])).toEqual([[A, 'event.decision', 'e1'], [A, 'icp.saved', '2'], ['system', 'samples.loaded', null]]);
  });

  it('returns false and does not throw when the write fails', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { prepare: () => { throw new Error('database down'); } };
    await expect(remember(broken, 1, [{ actor: A, kind: 'icp.saved', detail: {} }])).resolves.toBe(false);
    await expect(remember(env.DB, 'not-an-id', [{ actor: A, kind: 'icp.saved', detail: {} }])).resolves.toBe(false);
    quiet.mockRestore();
  });

  it('keeps detail under 2048 bytes and valid JSON for huge lists', () => {
    const huge = {
      sites: Array.from({ length: 500 }, (_, i) => `a-rather-long-domain-name-${i}.example.com`),
      autoAdded: Array.from({ length: 300 }, (_, i) => `A fairly long event name number ${i}`),
      reason: 'x'.repeat(5000),
      choice: 'skip',
    };
    const fitted = fitDetail(huge);
    const text = JSON.stringify(fitted);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(2048);
    expect(JSON.parse(text)).toEqual(fitted);
    expect(fitted.choice).toBe('skip');
    expect(fitted.sitesMore).toBeGreaterThan(0);
    expect(fitted.reason.length).toBeLessThanOrEqual(201);
  });

  it('leaves a small detail untouched', () => {
    const small = { choice: 'attend', sectors: ['pharma'], sites: ['a.test'] };
    expect(fitDetail(small)).toEqual(small);
  });

  it('scopes entries and the list to the workspace', async () => {
    await remember(env.DB, 1, [{ actor: A, kind: 'icp.saved', detail: { version: 2 } }]);
    await remember(env.DB, ws2, [{ actor: B, kind: 'icp.saved', detail: { version: 51 } }, { actor: B, kind: 'samples.loaded', detail: { count: 10 } }]);
    const one = await listMemory(env.DB, 1, { limit: 20 });
    expect(one.total).toBe(1);
    expect(one.items[0]).toMatchObject({ actor: A, kind: 'icp.saved', detail: { version: 2 } });
    const two = await listMemory(env.DB, ws2, { limit: 1 });
    expect(two.total).toBe(2);
    expect(two.items).toHaveLength(1);
    expect(two.items[0].kind).toBe('samples.loaded');
  });
});

describe('capture at the existing decision points', () => {
  it('records event.decision with the facts of that moment', async () => {
    await addEvent({ id: 'a1', name: 'Alpha Summit' });
    const res = await post('/api/decisions', tokenA, { eventId: 'a1', choice: 'skip', reason: 'Too small' });
    expect(res.status).toBe(201);
    const [entry] = await memoryRows();
    expect(entry).toMatchObject({ actor: A, kind: 'event.decision', subject: 'a1' });
    expect(entry.detail).toMatchObject({
      choice: 'skip', reason: 'Too small', name: 'Alpha Summit', organiser: 'Organiser', city: 'Berlin', country: 'DE', sectors: [], icpVersion: 1,
    });
    expect(typeof entry.detail.priority).toBe('number');
  });

  it('records candidate.approved and candidate.rejected with the sites that agreed', async () => {
    const first = await saveGroup(env.DB, 1, buildGroup([obs()]), NOW);
    const second = await saveGroup(env.DB, 1, buildGroup([obs({ name: 'BME Symposium', city: 'Berlin', country: 'DE', startDate: '2027-04-19', url: 'https://bme.de/x', sourceDomain: 'bme.de' })]), NOW);
    expect((await post(`/api/inbox/${first.candidateId}/approve`, tokenA)).status).toBe(200);
    expect((await post(`/api/inbox/${second.candidateId}/reject`, tokenA)).status).toBe(200);
    const [approved, rejected] = await memoryRows();
    expect(approved).toMatchObject({ actor: A, kind: 'candidate.approved', subject: String(first.candidateId) });
    expect(approved.detail).toMatchObject({
      name: 'SSOW Orlando', organiser: 'SSON', city: 'Orlando', country: 'US', startDate: '2027-03-08', sectors: [],
      sites: ['ssonetwork.com'], siteCount: 1, inboxReason: '1 of 3 sites',
    });
    expect(rejected).toMatchObject({ kind: 'candidate.rejected', subject: String(second.candidateId) });
    expect(rejected.detail).toMatchObject({ name: 'BME Symposium', sites: ['bme.de'], siteCount: 1 });
  });

  it('records autoadd.undone, and the approve response keeps its old shape', async () => {
    const [auto] = await processGroups(env.DB, 1, [threeSites()], NOW);
    expect(auto.status).toBe('auto_added');
    const undone = await post(`/api/events/${auto.eventId}/undo-auto-add`, tokenA);
    expect(undone.status).toBe(200);
    expect((await undone.json()).data).toEqual({});
    const [entry] = await memoryRows();
    expect(entry).toMatchObject({ actor: A, kind: 'autoadd.undone', subject: auto.eventId });
    expect(entry.detail).toMatchObject({ name: 'SSOW Orlando', city: 'Orlando', country: 'US', siteCount: 3 });
    expect([...entry.detail.sites].sort()).toEqual(['10times.com', 'luminik.io', 'ssonetwork.com']);

    const one = await saveGroup(env.DB, 1, buildGroup([obs({ name: 'Other Forum', startDate: '2027-07-01', url: 'https://o.test/1', sourceDomain: 'o.test' })]), NOW);
    const approved = await post(`/api/inbox/${one.candidateId}/approve`, tokenA);
    expect(Object.keys((await approved.json()).data)).toEqual(['eventId']);
  });

  it('records icp.saved with only the keys that changed', async () => {
    const cfg = (await (await call(handler, '/api/icp', { token: tokenA })).json()).data;
    cfg.thresholds.mustAttend = 75;
    const saved = await call(handler, '/api/icp', { method: 'PUT', token: tokenA, body: cfg });
    expect(saved.status).toBe(200);
    const [entry] = await memoryRows();
    expect(entry).toMatchObject({ actor: A, kind: 'icp.saved', subject: '2' });
    expect(entry.detail).toEqual({ version: 2, changed: ['thresholds'] });
  });

  it('records sectors.saved: sectors added, removed and edited, and setting keys changed', async () => {
    const sectors = structuredClone(DEFAULT_SETTINGS.sectors);
    sectors.find((s) => s.id === 'pharma').name = 'Pharma and biotech';
    const kept = sectors.filter((s) => s.id !== 'banking');
    kept.push({ id: 'energy', name: 'Energy', topics: ['energy procurement'], enabled: true });
    const res = await call(handler, '/api/discovery/settings', { method: 'PUT', token: tokenA, body: { sectors: kept, dayCapUsd: 3 } });
    expect(res.status).toBe(200);
    const [entry] = await memoryRows();
    expect(entry).toMatchObject({ actor: A, kind: 'sectors.saved' });
    expect(entry.detail).toEqual({ added: ['energy'], removed: ['banking'], edited: ['pharma'], changed: ['dayCapUsd'] });
  });

  it('records nothing when a settings save changes nothing', async () => {
    const res = await call(handler, '/api/discovery/settings', { method: 'PUT', token: tokenA, body: { dayCapUsd: DEFAULT_SETTINGS.dayCapUsd } });
    expect(res.status).toBe(200);
    expect(await memoryRows()).toEqual([]);
  });

  it('records samples.loaded once, and not on a second load that adds nothing', async () => {
    await post('/api/workspace/samples', tokenA);
    await post('/api/workspace/samples', tokenA);
    const rows = await memoryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: A, kind: 'samples.loaded', detail: { count: 10 } });
  });
});

describe('search.finished', () => {
  const pageA = eventPage('https://ssonetwork.com/orlando', { name: 'SSOW Orlando', startDate: '2027-03-08', city: 'Orlando' });
  const pageOld = eventPage('https://old.example/summit', { name: 'Old Summit', startDate: '2026-09-01', city: 'Berlin', country: 'Germany' });
  const query = { query: 'shared services', from: '2027-01-01', to: '2027-06-30', topics: [] };
  const world = (pages) => ({ pages: fakeSearch(pages), feeds: { list: async () => [] } });
  const begin = (user = A) => startRun(env.DB, 1, user, query, { ...DEFAULT_SETTINGS }, NOW);
  const step = (runId, w, db = env.DB) => stepRun({ db, workspaceId: 1, runId, deps: w, settings: { ...DEFAULT_SETTINGS }, now: NOW });
  const count = async (sql, ...v) => (await env.DB.prepare(sql).bind(...v).first()).n;

  it('is written once when a run ends, with sectors, counts, spend, productive and wasted sources, and not while it runs', async () => {
    const w = world([pageA, pageOld]);
    const run = await begin();
    for (let i = 1; i <= 3; i += 1) {
      await step(run.id, w);
      expect(await count("SELECT COUNT(*) AS n FROM memory WHERE kind = 'search.finished'")).toBe(0);
    }
    const last = await step(run.id, w);
    expect(last.run.status).toBe('done');
    await step(run.id, w);
    const rows = await memoryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: A, kind: 'search.finished', subject: String(run.id) });
    expect(rows[0].detail).toMatchObject({
      status: 'done', sectors: [], searches: 2, pages: 4,
      counts: { auto_added: 0, inbox: 1, tracked: 0, filtered: 1 }, filteredBy: { past: 1 },
      productive: ['ssonetwork.com'], wasted: ['old.example'], autoAdded: [],
    });
    expect(rows[0].detail.spendUsd).toBeCloseTo(2 * SEARCH_COST, 6);
  });

  it('is written once when a person stops a run, by the person who stopped it', async () => {
    const run = await begin();
    await cancelRun(env.DB, 1, run.id, B, 'admin', NOW);
    await cancelRun(env.DB, 1, run.id, B, 'admin', NOW);
    const rows = await memoryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: B, kind: 'search.finished', subject: String(run.id), detail: { status: 'stopped' } });
  });

  it('is written when a run fails', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = { prepare: (sql) => env.DB.prepare(sql), batch: async () => { throw new Error('disk full'); } };
    const run = await begin();
    const result = await step(run.id, world([pageA]), failing);
    expect(result.run.status).toBe('failed');
    expect((await memoryRows())[0]).toMatchObject({ kind: 'search.finished', detail: { status: 'failed' } });
    quiet.mockRestore();
  });

  it('a step that finds ten events writes no memory before the run ends, and the last step still stays within 50 queries', async () => {
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];
    const pages = names.map((name, i) => eventPage(`https://m${i}.example/e`, { name: `${name} Procurement Forum`, startDate: '2027-05-10', city: 'Berlin', country: 'Germany' }));

    const middle = countingDb();
    const run = await begin();
    await step(run.id, world(pages), middle.db);
    expect(middle.count()).toBeLessThanOrEqual(50);
    expect(await count('SELECT COUNT(*) AS n FROM memory')).toBe(0);

    // The last step finds ten different events, so it takes the same path as the first (re-finding events already stored
    // costs more statements, which is a separate matter).
    const later = ['Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango']
      .map((name, i) => eventPage(`https://n${i}.example/e`, { name: `${name} Procurement Forum`, startDate: '2027-06-10', city: 'Berlin', country: 'Germany' }));
    await env.DB.prepare('UPDATE search_runs SET planned = done + 1 WHERE id = ?').bind(run.id).run();
    const final = countingDb();
    const result = await step(run.id, world(later), final.db);
    expect(result.run.status).toBe('done');
    expect(final.count()).toBeLessThanOrEqual(50);
    expect(await count("SELECT COUNT(*) AS n FROM memory WHERE kind = 'search.finished'")).toBe(1);
  });

  it('summariseRun lists a source as wasted only if it produced nothing new', () => {
    const detail = summariseRun({
      run: { status: 'done', searchCalls: 1, pages: 3, spendUsd: 0.0301 },
      query: { sectors: ['pharma'] },
      items: [
        { outcome: 'inbox', domains: ['good.example'], url: 'https://good.example/a', name: 'A' },
        { outcome: 'auto_added', domains: ['also.example'], url: 'https://also.example/a', name: 'B' },
        { outcome: 'filtered', reason: 'past', url: 'https://good.example/old', domains: [] },
        { outcome: 'filtered', reason: 'online_only', url: 'https://waste.example/x', domains: [] },
      ],
    });
    expect(detail).toMatchObject({
      sectors: ['pharma'], counts: { auto_added: 1, inbox: 1, tracked: 0, filtered: 2 }, filteredBy: { past: 1, online_only: 1 },
      productive: ['also.example', 'good.example'], wasted: ['waste.example'], autoAdded: ['B'],
    });
  });
});

describe('memory never gets in the way, and never holds lead details', () => {
  it('a failed memory write does not fail the action', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await addEvent({ id: 'a1' });
    // A plain object, not a child of env: assigning DB onto a child of the test env would replace the real env.DB.
    const realDb = env.DB;
    const sabotaged = {
      SESSION_SECRET: env.SESSION_SECRET, GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID, ALLOWED_ORIGIN: env.ALLOWED_ORIGIN,
      DB: { prepare: (sql) => { if (/INSERT INTO memory/.test(sql)) throw new Error('memory down'); return realDb.prepare(sql); }, batch: (s) => realDb.batch(s) },
    };
    const request = new Request('https://api.test/api/decisions', {
      method: 'POST', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }, body: JSON.stringify({ eventId: 'a1', choice: 'attend' }),
    });
    const res = await handler(request, sabotaged);
    expect(res.status).toBe(201);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM decisions').first()).n).toBe(1);
    expect(await memoryRows()).toEqual([]);
    quiet.mockRestore();
  });

  it("never puts a lead's name or email in any entry", async () => {
    await addEvent({ id: 'a1', name: 'Alpha Summit' });
    const company = await addCompany({ name: 'Acme Holdings', domain: 'acme.test' });
    const person = await addPerson({ name: 'Pat Person', email: 'pat@acme.test', company_id: company });
    await attend('a1', person);
    await post('/api/decisions', tokenA, { eventId: 'a1', choice: 'attend', note: 'Pat Person said hello' });
    await post('/api/workspace/samples', tokenA);
    const everything = JSON.stringify(await memoryRows());
    expect(everything).not.toContain('Pat Person');
    expect(everything).not.toContain('pat@acme.test');
    expect(everything).not.toContain('Acme Holdings');
    expect(everything).not.toContain('hello');
  });
});

describe('GET /api/memory', () => {
  it("returns the total and the newest entries of the caller's workspace only", async () => {
    await remember(env.DB, 1, [1, 2, 3].map((n) => ({ actor: A, kind: 'icp.saved', subject: n, detail: { version: n } })));
    await remember(env.DB, ws2, [{ actor: B, kind: 'icp.saved', subject: 99, detail: { version: 99 } }]);
    const res = await call(handler, '/api/memory?limit=2', { token: tokenA });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.total).toBe(3);
    expect(data.items.map((i) => i.detail.version)).toEqual([3, 2]);
    const other = (await (await call(handler, '/api/memory', { token: tokenB })).json()).data;
    expect(other.total).toBe(1);
    expect(other.items[0].detail.version).toBe(99);
  });

  it('refuses a request without a session', async () => {
    expect((await call(handler, '/api/memory')).status).toBe(401);
  });
});
