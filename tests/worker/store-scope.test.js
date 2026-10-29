import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildGroup, rejectionKey } from '../../site/js/shared/discovery.js';
import { DEFAULT_CONFIG } from '../../site/js/shared/scoring.js';
import {
  DiscoveryError, approveCandidate, listInbox, loadContext, processGroups, reevaluate, rejectCandidate, saveGroup, undoAutoAdd,
} from '../../worker/src/discovery/store.js';
import { addWorkspace, resetData } from './helpers.js';

// Two workspaces use the candidate store side by side. Until migration 0005 cluster_key is still a global key, so the
// workspaces use different names and dates; the names are similar enough that an unscoped match would merge them.
const NOW = Date.parse('2026-10-29T12:00:00Z');
const USER = 'member@example.test';
let ws2;

const obs = (over = {}) => ({
  name: 'SSOW Orlando', organiser: 'SSON', startDate: '2027-03-08', endDate: '2027-03-11', city: 'Orlando', country: 'US',
  online: false, cancelled: false, url: 'https://ssonetwork.com/orlando', sourceDomain: 'ssonetwork.com', adapter: 'exa',
  title: 'SSOW Orlando', quotes: { name: 'SSOW Orlando', dates: '8-11 March 2027' }, topicHits: 1, ...over,
});
const group = (...observations) => buildGroup(observations);
const threeSites = (over = {}) => group(
  obs(over), obs({ ...over, sourceDomain: 'luminik.io', url: 'https://luminik.io/x' }), obs({ ...over, sourceDomain: '10times.com', url: 'https://10times.com/x' }),
);
const second = (over = {}) => ({ name: 'SSOW Orlando Spring Summit', startDate: '2027-03-09', url: 'https://other.test/ssow', sourceDomain: 'other.test', ...over });
const count = async (sql, ...values) => (await env.DB.prepare(sql).bind(...values).first()).n;
const status = async (id) => (await env.DB.prepare('SELECT status FROM candidates WHERE id = ?').bind(id).first()).status;

beforeEach(async () => {
  await resetData();
  ws2 = await addWorkspace({ name: 'Bravo team' });
  // icp_config.version is a global key until 0005, so workspace 2 starts at version 50 rather than creating its own 1.
  await env.DB.prepare('INSERT INTO icp_config (workspace_id, version, json, created_by) VALUES (?, 50, ?, ?)')
    .bind(ws2, JSON.stringify({ ...DEFAULT_CONFIG, version: 50 }), 'test')
    .run();
});

describe('the candidate store is scoped to a workspace', () => {
  it('an event found in one workspace is not merged into a similar candidate of another', async () => {
    const a = await saveGroup(env.DB, 1, group(obs()), NOW);
    const b = await saveGroup(env.DB, ws2, group(obs(second())), NOW);
    expect(b.candidateId).not.toBe(a.candidateId);
    expect(await count('SELECT COUNT(*) AS n FROM candidates WHERE workspace_id = 1')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM candidates WHERE workspace_id = ?', ws2)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM candidate_sources WHERE workspace_id = 1')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM candidate_sources WHERE workspace_id = ?', ws2)).toBe(1);
  });

  it('a rejection in one workspace does not hide the event in another', async () => {
    const { candidateId } = await saveGroup(env.DB, 1, group(obs()), NOW);
    await rejectCandidate(env.DB, 1, candidateId, USER, NOW);
    const key = rejectionKey('SSOW Orlando', '2027-03-08');
    expect((await loadContext(env.DB, 1)).rejected.has(key)).toBe(true);
    expect((await loadContext(env.DB, ws2)).rejected.size).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM rejections WHERE workspace_id = ?', ws2)).toBe(0);
  });

  it("approving, rejecting, re-evaluating or undoing with another workspace's id is 404 and changes nothing", async () => {
    const { candidateId } = await saveGroup(env.DB, 1, group(obs()), NOW);
    const [auto] = await processGroups(env.DB, 1, [threeSites({ name: 'Auto Summit', startDate: '2027-05-10' })], NOW);
    expect(auto.status).toBe('auto_added');

    const notFound = (promise) => expect(promise).rejects.toMatchObject({ name: 'DiscoveryError', status: 404 });
    await notFound(approveCandidate(env.DB, ws2, candidateId, USER, NOW));
    await notFound(rejectCandidate(env.DB, ws2, candidateId, USER, NOW));
    await notFound(reevaluate(env.DB, ws2, candidateId, NOW));
    await notFound(undoAutoAdd(env.DB, ws2, auto.eventId, USER, NOW));
    expect(await status(candidateId)).toBe('inbox');
    expect(await count('SELECT COUNT(*) AS n FROM events WHERE id = ?', auto.eventId)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM rejections')).toBe(0);
  });

  it("the inbox lists only the caller's candidates", async () => {
    await saveGroup(env.DB, 1, group(obs()), NOW);
    await saveGroup(env.DB, ws2, group(obs({ name: 'Other Summit', startDate: '2027-08-01', url: 'https://o.test/1', sourceDomain: 'o.test' })), NOW);
    expect((await listInbox(env.DB, 1, NOW)).map((c) => c.name)).toEqual(['SSOW Orlando']);
    expect((await listInbox(env.DB, ws2, NOW)).map((c) => c.name)).toEqual(['Other Summit']);
  });

  it('an auto-add creates the event, its sources and its change in the workspace that found it', async () => {
    const [result] = await processGroups(env.DB, ws2, [threeSites({ name: 'Bravo Summit', startDate: '2027-09-01' })], NOW);
    expect(result.status).toBe('auto_added');
    const event = await env.DB.prepare('SELECT workspace_id FROM events WHERE id = ?').bind(result.eventId).first();
    expect(event.workspace_id).toBe(ws2);
    expect(await count('SELECT COUNT(*) AS n FROM event_sources WHERE workspace_id = ?', ws2)).toBe(3);
    expect(await count('SELECT COUNT(*) AS n FROM event_sources WHERE workspace_id = 1')).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM changes WHERE kind = 'new_event' AND workspace_id = ?", ws2)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM candidates WHERE status = 'auto_added' AND workspace_id = ?", ws2)).toBe(1);
  });

  it("existing events are matched only within the workspace", async () => {
    await processGroups(env.DB, 1, [threeSites({ name: 'Auto Summit', startDate: '2027-05-10' })], NOW);
    expect((await loadContext(env.DB, 1)).existing).toHaveLength(1);
    expect((await loadContext(env.DB, ws2)).existing).toHaveLength(0);
  });
});
