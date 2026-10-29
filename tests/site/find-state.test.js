import { describe, it, expect } from 'vitest';
import { FILTER_LABELS, driveFill, driveRun, fillQuery, groupItems, keysNotice, mergeItems, progressText } from '../../site/js/find-state.js';

const item = (outcome, over = {}) => ({ outcome, name: `${outcome} event`, url: 'https://a.example', reason: null, domains: [], ...over });
const run = (status, over = {}) => ({ id: 7, status, planned: 4, done: 1, pages: 0, searchCalls: 0, spendUsd: 0, note: null, error: null, ...over });

describe('groupItems', () => {
  it('splits outcomes into four groups, keeping order and ignoring unknown outcomes', () => {
    const a = item('auto_added', { name: 'A' });
    const b = item('inbox', { name: 'B' });
    const c = item('tracked', { name: 'C' });
    const d = item('filtered', { name: 'D', reason: 'past' });
    const e = item('inbox', { name: 'E' });
    const groups = groupItems([a, b, c, d, e, item('mystery')]);
    expect(groups.added).toEqual([a]);
    expect(groups.review).toEqual([b, e]);
    expect(groups.tracked).toEqual([c]);
    expect(groups.filtered).toEqual([d]);
  });

  it('copes with no items', () => {
    expect(groupItems([])).toEqual({ added: [], review: [], tracked: [], filtered: [] });
    expect(groupItems(undefined)).toEqual({ added: [], review: [], tracked: [], filtered: [] });
  });
});

describe('progressText', () => {
  const matches = (n) => Array.from({ length: n }, () => item('inbox'));

  it('reads pages and matches', () => {
    expect(progressText(run('running', { pages: 14 }), matches(6))).toBe('14 pages read, 6 matches');
  });

  it('uses singular forms', () => {
    expect(progressText(run('running', { pages: 1 }), matches(1))).toBe('1 page read, 1 match');
    expect(progressText(run('running', { pages: 0 }), [])).toBe('0 pages read, 0 matches');
  });

  it('counts added, review and tracked items as matches but not filtered ones', () => {
    const items = [item('auto_added'), item('inbox'), item('tracked'), item('filtered'), item('filtered')];
    expect(progressText(run('running', { pages: 5 }), items)).toBe('5 pages read, 3 matches');
  });

  it('shows only pages when items are not given', () => {
    expect(progressText(run('running', { pages: 14 }))).toBe('14 pages read');
  });
});

describe('FILTER_LABELS', () => {
  it('has a plain label for every reason a run can give', () => {
    expect(Object.keys(FILTER_LABELS).sort()).toEqual(['cancelled', 'entertainment', 'no_date', 'online_only', 'outside_dates', 'past', 'rejected', 'unverified']);
    for (const [reason, label] of Object.entries(FILTER_LABELS)) expect(label.length, reason).toBeGreaterThan(10);
  });
});

describe('driveRun', () => {
  const apiOf = (responses) => {
    const posts = [];
    return {
      posts,
      post: async (path, body) => {
        posts.push({ path, body });
        return responses[Math.min(posts.length - 1, responses.length - 1)];
      },
    };
  };
  const ok = (status, over) => ({ ok: true, status: 200, data: { run: run(status, over), items: [item('inbox')] } });

  it('posts step until the run is no longer running', async () => {
    const api = apiOf([ok('running'), ok('running'), ok('done')]);
    const updates = [];
    const result = await driveRun({ api, runId: 7, onUpdate: (data) => updates.push(data.run.status) });
    expect(api.posts.map((p) => p.path)).toEqual(['/api/search/7/step', '/api/search/7/step', '/api/search/7/step']);
    expect(updates).toEqual(['running', 'running', 'done']);
    expect(result).toMatchObject({ ok: true, run: { status: 'done' } });
  });

  it('treats capped, paused and failed as finished', async () => {
    for (const status of ['capped', 'paused', 'failed']) {
      const api = apiOf([ok(status)]);
      const result = await driveRun({ api, runId: 7 });
      expect(api.posts, status).toHaveLength(1);
      expect(result.run.status).toBe(status);
    }
  });

  it('does not call step again once done', async () => {
    const api = apiOf([ok('done')]);
    await driveRun({ api, runId: 7 });
    expect(api.posts).toHaveLength(1);
  });

  it('stops when the signal is aborted, between steps', async () => {
    const controller = new AbortController();
    const api = apiOf([ok('running'), ok('running'), ok('done')]);
    const result = await driveRun({ api, runId: 7, signal: controller.signal, onUpdate: () => controller.abort() });
    expect(api.posts).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, stopped: true, run: { status: 'running' } });
  });

  it('does not call step at all when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = apiOf([ok('running')]);
    expect(await driveRun({ api, runId: 7, signal: controller.signal })).toMatchObject({ ok: true, stopped: true });
    expect(api.posts).toHaveLength(0);
  });

  it('returns the error and stops on a failed step', async () => {
    const api = apiOf([ok('running'), { ok: false, status: 500, error: 'boom' }]);
    const result = await driveRun({ api, runId: 7 });
    expect(api.posts).toHaveLength(2);
    expect(result).toEqual({ ok: false, status: 500, error: 'boom' });
  });

  it('explains a lost connection in plain words', async () => {
    const result = await driveRun({ api: apiOf([{ ok: false, stale: true }]), runId: 7 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reach/i);
  });
});

describe('fillQuery and driveFill', () => {
  const sectors = [
    { id: 'pharma', name: 'Pharma and life sciences' },
    { id: 'banking', name: 'Banking and insurance operations' },
    { id: 'procurement', name: 'Procurement and supply chain' },
  ];
  const dates = { from: '2027-01-01', to: '2027-06-30' };

  // Starting a search gives a run with the next id (101, 102, ...). The first step of a run ends it with the status
  // given for it, or "done". startFails maps the number of runs already started to the answer a start gives instead.
  function fillApi({ ends = [], startFails = {} } = {}) {
    const posts = [];
    let started = 0;
    return {
      posts,
      post: async (path, body) => {
        posts.push({ path, body });
        if (path === '/api/search') {
          if (startFails[started]) return startFails[started];
          started += 1;
          return { ok: true, status: 201, data: { run: run('running', { id: 100 + started }), items: [] } };
        }
        const id = Number(path.split('/')[3]);
        return { ok: true, status: 200, data: { run: run(ends[id - 101] ?? 'done', { id }), items: [item('inbox')] } };
      },
    };
  }
  const starts = (api) => api.posts.filter((p) => p.path === '/api/search');

  it('names the search after the sector', () => {
    expect(fillQuery(sectors[0])).toBe('Pharma and life sciences conferences and trade shows');
  });

  it('runs one search per sector in turn, each for that sector alone, to its end before the next starts', async () => {
    const api = fillApi();
    const seen = [];
    const result = await driveFill({ api, sectors, ...dates, region: 'Europe', onSector: ({ index, total, sector }) => seen.push([index, total, sector.id]) });
    expect(starts(api).map((p) => p.body)).toEqual(sectors.map((s) => ({ query: fillQuery(s), ...dates, region: 'Europe', sectors: [s.id] })));
    expect(api.posts.map((p) => p.path)).toEqual(['/api/search', '/api/search/101/step', '/api/search', '/api/search/102/step', '/api/search', '/api/search/103/step']);
    expect(seen).toEqual([[0, 3, 'pharma'], [1, 3, 'banking'], [2, 3, 'procurement']]);
    expect(result.ok).toBe(true);
    expect(result.done.map((d) => d.sector.id)).toEqual(['pharma', 'banking', 'procurement']);
  });

  it('leaves the region out when there is none', async () => {
    const api = fillApi();
    await driveFill({ api, sectors: sectors.slice(0, 1), ...dates });
    expect(starts(api)[0].body).not.toHaveProperty('region');
  });

  it('reports every step of a run together with its sector', async () => {
    const updates = [];
    await driveFill({ api: fillApi(), sectors: sectors.slice(0, 2), ...dates, onUpdate: (u) => updates.push([u.sector.id, u.run.status]) });
    expect(updates).toEqual([['pharma', 'done'], ['banking', 'done']]);
  });

  it('stops at a run that ends capped, keeping what finished before it', async () => {
    const api = fillApi({ ends: ['done', 'capped'] });
    const result = await driveFill({ api, sectors, ...dates });
    expect(result).toMatchObject({ ok: true, ended: 'capped', run: { status: 'capped' } });
    expect(result.done.map((d) => d.sector.id)).toEqual(['pharma']);
    expect(starts(api)).toHaveLength(2);
  });

  it('stops with the reason when a search cannot start', async () => {
    const api = fillApi({ startFails: { 1: { ok: false, status: 503, error: 'discovery is not set up', missing: ['EXA_API_KEY'] } } });
    const result = await driveFill({ api, sectors, ...dates });
    expect(result).toMatchObject({ ok: false, status: 503, missing: ['EXA_API_KEY'], error: 'discovery is not set up' });
    expect(result.done.map((d) => d.sector.id)).toEqual(['pharma']);
  });

  it('explains a lost connection in plain words', async () => {
    const result = await driveFill({ api: fillApi({ startFails: { 0: { ok: false, stale: true } } }), sectors, ...dates });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reach/i);
  });

  it('stops before the next sector once the signal is aborted', async () => {
    const controller = new AbortController();
    const api = fillApi();
    const result = await driveFill({ api, sectors, ...dates, signal: controller.signal, onUpdate: () => controller.abort() });
    expect(result).toMatchObject({ ok: true, stopped: true });
    expect(result.done.map((d) => d.sector.id)).toEqual(['pharma']);
    expect(starts(api)).toHaveLength(1);
  });

  it('hands back the run that was still going when it was stopped, so the page can end it on the server', async () => {
    const controller = new AbortController();
    const api = fillApi({ ends: ['running'] });
    const result = await driveFill({ api, sectors, ...dates, signal: controller.signal, onUpdate: () => controller.abort() });
    expect(result).toMatchObject({ ok: true, stopped: true, run: { id: 101, status: 'running' }, done: [] });
  });

  it('does nothing for no sectors', async () => {
    const api = fillApi();
    expect(await driveFill({ api, sectors: [], ...dates })).toEqual({ ok: true, done: [] });
    expect(api.posts).toEqual([]);
  });
});

describe('mergeItems', () => {
  it('keeps one row for the same event found twice, the latest outcome winning, in first-seen order', () => {
    const a1 = item('inbox', { name: 'A', candidateId: 1 });
    const b = item('inbox', { name: 'B', candidateId: 2 });
    const a2 = item('auto_added', { name: 'A', candidateId: 1, eventId: 'a' });
    expect(mergeItems([a1, b], [a2])).toEqual([a2, b]);
  });

  it('tells tracked events apart by event id and filtered ones by reason and name', () => {
    const t1 = item('tracked', { eventId: 'e1', name: 'T' });
    const t2 = item('tracked', { eventId: 'e2', name: 'T' });
    const f1 = item('filtered', { reason: 'past', name: 'F' });
    const f2 = item('filtered', { reason: 'cancelled', name: 'F' });
    expect(mergeItems([t1, t2, f1, f2])).toHaveLength(4);
    expect(mergeItems([f1], [{ ...f1 }])).toHaveLength(1);
  });

  it('copes with no lists', () => {
    expect(mergeItems()).toEqual([]);
    expect(mergeItems([], undefined)).toEqual([]);
  });
});

describe('keysNotice', () => {
  it('says nothing when nothing is missing', () => {
    expect(keysNotice({ missing: [], sharedKeys: true })).toBeNull();
    expect(keysNotice({})).toBeNull();
  });

  it('tells a workspace without shared keys that it needs its own, and that the operator can lend the shared one', () => {
    const text = 'Search needs an Exa key for this workspace. Per-workspace keys arrive in the next update; the operator can switch on the shared key meanwhile.';
    expect(keysNotice({ missing: ['EXA_API_KEY'], sharedKeys: false })).toBe(text);
    expect(keysNotice({ missing: ['EXA_API_KEY'], sharedKeys: false, admin: false })).toBe(text);
  });

  it('keeps the Worker-secret instructions for a workspace that may use the shared keys', () => {
    expect(keysNotice({ missing: ['EXA_API_KEY'], sharedKeys: true, admin: true })).toBe(
      'Add EXA_API_KEY to the Worker as a secret, then reload this page. An Anthropic key is optional: with it, Claude reads the pages instead of Exa. DEPLOY.md has the steps.',
    );
    expect(keysNotice({ missing: ['EXA_API_KEY'], sharedKeys: true, admin: false })).toBe('An admin needs to finish setting up search.');
  });

  it('treats a missing sharedKeys flag as shared, so an older Worker still gets the old wording', () => {
    expect(keysNotice({ missing: ['EXA_API_KEY'] })).toMatch(/^Add EXA_API_KEY to the Worker/);
  });
});
