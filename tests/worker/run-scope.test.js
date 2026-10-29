import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../site/js/shared/scoring.js';
import { defaultDeps } from '../../worker/src/discovery/deps.js';
import { cancelRun, getRun, startRun, stepRun } from '../../worker/src/discovery/run.js';
import { DEFAULT_SETTINGS, daySpend, getSettings, putSettings } from '../../worker/src/discovery/settings.js';
import { createHandler } from '../../worker/src/index.js';
import { addUser, addWorkspace, call, eventPage, fakeSearch, resetData, tokenFor } from './helpers.js';

// Two workspaces run searches side by side. Until migration 0005 settings.key is a global key, so the two
// workspaces store different settings keys.
const NOW = Date.parse('2026-10-29T12:00:00Z');
const A = 'a@example.test';
const B = 'b@example.test';
const query = { query: 'shared services', from: '2027-01-01', to: '2027-06-30', topics: [] };
const settings = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });
let ws2;

const page = eventPage('https://ssonetwork.com/orlando', { name: 'SSOW Orlando', startDate: '2027-03-08', city: 'Orlando' });
const world = () => ({ pages: fakeSearch([page]), feeds: { list: async () => [] } });
const begin = (workspaceId, user) => startRun(env.DB, workspaceId, user, query, settings(), NOW);
const step = (workspaceId, runId, over = {}) => stepRun({ db: env.DB, workspaceId, runId, deps: world(), settings: settings(), now: NOW, ...over });
const spendToday = (workspaceId, usd) =>
  env.DB.prepare("INSERT INTO search_runs (workspace_id, query_json, created_by, started, status, model_spend) VALUES (?, '{}', 'old@example.test', ?, 'done', ?)")
    .bind(workspaceId, new Date(NOW).toISOString(), usd)
    .run();

beforeEach(async () => {
  await resetData();
  ws2 = await addWorkspace({ name: 'Bravo team' });
  await env.DB.prepare('INSERT INTO icp_config (workspace_id, version, json, created_by) VALUES (?, 50, ?, ?)')
    .bind(ws2, JSON.stringify({ ...DEFAULT_CONFIG, version: 50 }), 'test')
    .run();
});

describe('search runs are scoped to a workspace', () => {
  it("daySpend counts only the workspace's own runs", async () => {
    await spendToday(1, 0.4);
    await spendToday(ws2, 5);
    expect(await daySpend(env.DB, 1, NOW)).toBeCloseTo(0.4);
    expect(await daySpend(env.DB, ws2, NOW)).toBeCloseTo(5);
  });

  it('a run in workspace 1 is not capped by $5 spent today in workspace 2, and the reverse', async () => {
    await spendToday(ws2, 5);
    const own = await begin(1, A);
    const ownStep = await step(1, own.id);
    expect(ownStep.run).toMatchObject({ status: 'running', done: 1 });

    const capped = await begin(ws2, B);
    const cappedStep = await step(ws2, capped.id);
    expect(cappedStep.run.status).toBe('capped');
    expect(cappedStep.run.note).toMatch(/daily budget/);
  });

  it("get, step and cancel with another workspace's run id find nothing and change nothing", async () => {
    const run = await begin(1, A);
    expect(await getRun(env.DB, ws2, run.id)).toBeNull();
    expect(await stepRun({ db: env.DB, workspaceId: ws2, runId: run.id, deps: world(), settings: settings(), now: NOW })).toBeNull();
    expect(await cancelRun(env.DB, ws2, run.id, B, 'admin', NOW)).toBeNull();
    const row = await env.DB.prepare('SELECT status, done FROM search_runs WHERE id = ?').bind(run.id).first();
    expect(row).toEqual({ status: 'running', done: 0 });
  });

  it('stamps the run and its items with the workspace that ran it', async () => {
    const run = await begin(ws2, B);
    await step(ws2, run.id);
    expect((await env.DB.prepare('SELECT workspace_id FROM search_runs WHERE id = ?').bind(run.id).first()).workspace_id).toBe(ws2);
    const items = await env.DB.prepare('SELECT DISTINCT workspace_id FROM run_items WHERE run_id = ?').bind(run.id).all();
    expect(items.results).toEqual([{ workspace_id: ws2 }]);
  });

  it('one running search per person still holds inside a workspace', async () => {
    await begin(1, A);
    await expect(begin(1, A)).rejects.toMatchObject({ status: 409 });
  });
});

describe('settings are scoped to a workspace', () => {
  it("settings written in one workspace do not change the other's", async () => {
    await putSettings(env.DB, 1, { dayCapUsd: 7 });
    await putSettings(env.DB, ws2, { runCapUsd: 3 });
    expect(await getSettings(env.DB, 1)).toEqual({ ...DEFAULT_SETTINGS, dayCapUsd: 7 });
    expect(await getSettings(env.DB, ws2)).toEqual({ ...DEFAULT_SETTINGS, runCapUsd: 3 });
    const { results } = await env.DB.prepare('SELECT key, workspace_id FROM settings ORDER BY key').all();
    expect(results).toEqual([{ key: 'dayCapUsd', workspace_id: 1 }, { key: 'runCapUsd', workspace_id: ws2 }]);
  });
});

describe('shared keys', () => {
  it('without shared keys there is no search or model reader, but the free feed stays', () => {
    const deps = defaultDeps({ EXA_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, { sharedKeys: false });
    expect(deps.pages).toBeNull();
    expect(deps.model).toBeNull();
    expect(deps.feeds).toBeTruthy();
  });

  it('with shared keys and the secrets set, the readers exist', () => {
    const both = defaultDeps({ EXA_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, { sharedKeys: true });
    expect(both.pages).toBeTruthy();
    expect(both.model).toBeTruthy();
    expect(defaultDeps({}, { sharedKeys: true }).pages).toBeNull();
  });

  it("the settings route reports each workspace's shared-keys flag", async () => {
    const handler = createHandler();
    await addUser({ email: A, role: 'admin' });
    await addUser({ email: B, role: 'admin', workspaceId: ws2 });
    const flagFor = async (email) => (await (await call(handler, '/api/discovery/settings', { token: await tokenFor({ email, role: 'admin' }) })).json()).data.sharedKeys;
    expect(await flagFor(A)).toBe(true);
    expect(await flagFor(B)).toBe(false);
  });
});
