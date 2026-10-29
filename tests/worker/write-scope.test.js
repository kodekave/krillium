import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../site/js/shared/scoring.js';
import { createHandler } from '../../worker/src/index.js';
import { addEvent, addUser, addWorkspace, call, resetData, tokenFor } from './helpers.js';

// Same two-workspace setup as read-scope.test.js: distinct ids, workspace 2's ICP starts at version 50 (global keys until 0005).
let handler;
let tokenA;
let tokenB;
let ws2;

const decide = (token, eventId, choice = 'attend') =>
  call(handler, '/api/decisions', { method: 'POST', token, body: { eventId, choice } });
const decisionCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM decisions').first()).n;

beforeEach(async () => {
  await resetData();
  handler = createHandler();
  ws2 = await addWorkspace({ name: 'Bravo team' });
  await addUser({ email: 'a@example.test', role: 'admin' });
  await addUser({ email: 'b@example.test', role: 'admin', workspaceId: ws2 });
  tokenA = await tokenFor({ email: 'a@example.test', role: 'admin' });
  tokenB = await tokenFor({ email: 'b@example.test', role: 'admin' });
  await env.DB.prepare('INSERT INTO icp_config (workspace_id, version, json, created_by) VALUES (?, 50, ?, ?)')
    .bind(ws2, JSON.stringify({ ...DEFAULT_CONFIG, version: 50 }), 'test')
    .run();
  await addEvent({ id: 'a1', name: 'Alpha Summit' });
  await addEvent({ id: 'b1', name: 'Bravo Summit', workspaceId: ws2 });
});

describe('writes are scoped to the caller\'s workspace', () => {
  it('a decision on another workspace\'s event is 404 and writes nothing', async () => {
    expect((await decide(tokenA, 'b1')).status).toBe(404);
    expect((await decide(tokenB, 'a1')).status).toBe(404);
    expect(await decisionCount()).toBe(0);
  });

  it('a decision is stamped with the caller\'s workspace', async () => {
    expect((await decide(tokenA, 'a1')).status).toBe(201);
    expect((await decide(tokenB, 'b1')).status).toBe(201);
    const { results } = await env.DB.prepare('SELECT event_id, workspace_id FROM decisions ORDER BY event_id').all();
    expect(results).toEqual([{ event_id: 'a1', workspace_id: 1 }, { event_id: 'b1', workspace_id: ws2 }]);
  });

  it('each workspace\'s event detail shows only its own decision', async () => {
    await decide(tokenA, 'a1', 'watch');
    const detailB = (await (await call(handler, '/api/events/b1', { token: tokenB })).json()).data;
    expect(detailB.myDecision).toBeNull();
    const detailA = (await (await call(handler, '/api/events/a1', { token: tokenA })).json()).data;
    expect(detailA.myDecision).toMatchObject({ choice: 'watch' });
  });

  it('an ICP save in one workspace does not change the other\'s active config', async () => {
    const cfgB = (await (await call(handler, '/api/icp', { token: tokenB })).json()).data;
    cfgB.thresholds.mustAttend = 80;
    const saved = await call(handler, '/api/icp', { method: 'PUT', token: tokenB, body: cfgB });
    expect((await saved.json()).data.version).toBe(51);
    const cfgA = (await (await call(handler, '/api/icp', { token: tokenA })).json()).data;
    expect(cfgA.version).toBe(1);
    expect(cfgA.thresholds.mustAttend).toBe(DEFAULT_CONFIG.thresholds.mustAttend);
    const rows = await env.DB.prepare('SELECT workspace_id, version FROM icp_config ORDER BY version').all();
    expect(rows.results).toEqual([{ workspace_id: 1, version: 1 }, { workspace_id: ws2, version: 50 }, { workspace_id: ws2, version: 51 }]);
  });
});
