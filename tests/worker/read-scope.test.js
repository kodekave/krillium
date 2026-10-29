import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../site/js/shared/scoring.js';
import { createHandler } from '../../worker/src/index.js';
import {
  addChange, addCompany, addEvent, addPerson, addUser, addWorkspace, attachCompany, attend, call, resetData, tokenFor,
} from './helpers.js';

// Two workspaces with their own events, companies and people. Until migration 0005 the primary keys are still global,
// so the two workspaces use different ids, domains and emails, and workspace 2 starts with an ICP at version 50.
let handler;
let tokenA;
let tokenB;
let ws2;

const get = async (path, token) => (await call(handler, path, { token })).json();

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
  const alphaCo = await addCompany({ name: 'Alpha Corp', domain: 'alpha.test' });
  const alphaPerson = await addPerson({ name: 'Alice Alpha', email: 'alice@alpha.test', company_id: alphaCo });
  await attend('a1', alphaPerson);
  await addChange('a1', { summary: 'Alpha lineup published' });

  await addEvent({ id: 'b1', name: 'Bravo Summit', workspaceId: ws2 });
  const bravoCo = await addCompany({ name: 'Bravo Corp', domain: 'bravo.test', workspaceId: ws2 });
  const bravoPerson = await addPerson({ name: 'Bob Bravo', email: 'bob@bravo.test', company_id: bravoCo, workspaceId: ws2 });
  await attend('b1', bravoPerson, { workspaceId: ws2 });
  await attachCompany('b1', bravoCo, ws2);
  await addChange('b1', { summary: 'Bravo lineup published', workspaceId: ws2 });
});

describe('reads are scoped to the caller\'s workspace', () => {
  it('radar, feed, graph and ask show only the caller\'s workspace', async () => {
    const radarA = (await get('/api/radar', tokenA)).data;
    const radarB = (await get('/api/radar', tokenB)).data;
    expect(radarA.map((e) => e.id)).toEqual(['a1']);
    expect(radarB.map((e) => e.id)).toEqual(['b1']);

    const feedA = JSON.stringify((await get('/api/feed', tokenA)).data);
    expect(feedA).toContain('Alpha lineup published');
    expect(feedA).not.toContain('Bravo');
    expect(JSON.stringify((await get('/api/feed', tokenB)).data)).not.toContain('Alpha');

    const graphA = (await get('/api/graph', tokenA)).data.accountsByEvent;
    const graphB = (await get('/api/graph', tokenB)).data.accountsByEvent;
    expect(Object.keys(graphA)).toEqual(['a1']);
    expect(Object.keys(graphB)).toEqual(['b1']);

    const range = '/api/ask?intent=top_events_in_range&from=2027-01-01&to=2027-12-31';
    expect((await get(range, tokenA)).data.rows.map((r) => r.id)).toEqual(['a1']);
    expect((await get(range, tokenB)).data.rows.map((r) => r.id)).toEqual(['b1']);
    expect((await get('/api/ask?intent=tier_a_by_event', tokenA)).data.rows.map((r) => r.id)).toEqual(['a1']);
    expect(JSON.stringify((await get('/api/ask?intent=changed_this_week', tokenA)).data)).not.toContain('Bravo');
  });

  it('event detail shows only the caller\'s people and sources, and another workspace\'s id is 404', async () => {
    const own = await call(handler, '/api/events/a1', { token: tokenA });
    expect(own.status).toBe(200);
    const detail = (await own.json()).data;
    expect(JSON.stringify(detail)).toContain('Alpha');
    expect(JSON.stringify(detail)).not.toContain('Bravo');
    expect((await call(handler, '/api/events/b1', { token: tokenA })).status).toBe(404);
    expect((await call(handler, '/api/events/a1', { token: tokenB })).status).toBe(404);
  });

  it('ICP versions are per workspace: saving in one leaves the other unchanged', async () => {
    expect((await get('/api/icp', tokenA)).data.version).toBe(1);
    expect((await get('/api/icp', tokenB)).data.version).toBe(50);

    const edited = (await get('/api/icp', tokenA)).data;
    edited.thresholds.mustAttend = 75;
    const saved = await call(handler, '/api/icp', { method: 'PUT', token: tokenA, body: edited });
    expect(saved.status).toBe(200);
    expect((await saved.json()).data.version).toBe(2);

    expect((await get('/api/icp', tokenA)).data.version).toBe(2);
    const b = (await get('/api/icp', tokenB)).data;
    expect(b.version).toBe(50);
    expect(b.thresholds.mustAttend).toBe(DEFAULT_CONFIG.thresholds.mustAttend);
  });
});
