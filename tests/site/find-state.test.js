import { describe, it, expect } from 'vitest';
import { FILTER_LABELS, driveRun, groupItems, progressText } from '../../site/js/find-state.js';

const item = (outcome, over = {}) => ({ outcome, name: `${outcome} event`, url: 'https://a.example', reason: null, domains: [], ...over });
const run = (status, over = {}) => ({ id: 7, status, planned: 4, done: 1, pages: 0, modelCalls: 0, spendUsd: 0, note: null, error: null, ...over });

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
