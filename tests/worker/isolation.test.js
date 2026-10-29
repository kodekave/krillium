import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getActiveConfig, saveConfig } from '../../worker/src/db.js';
import { putSettings } from '../../worker/src/discovery/settings.js';
import { ROUTES, createHandler } from '../../worker/src/index.js';
import { remember } from '../../worker/src/memory.js';
import {
  addChange, addCompany, addEvent, addPerson, addUser, addWorkspace, attachCompany, attend, call, fakeSearch, resetData, tokenFor,
} from './helpers.js';

// The isolation sweep: two workspaces hold the SAME event id, company domain, person email and cluster key, and each has a
// marker string that exists only on its own side. Every route is called as each workspace, so a query that forgets its
// workspace shows up as the other side's marker, a 200 for the other side's id, or a row that changed over there.
const TENANT_TABLES = [
  'events', 'companies', 'people', 'event_people', 'event_companies', 'event_sources', 'icp_config', 'decisions', 'changes',
  'search_runs', 'run_items', 'candidates', 'candidate_sources', 'rejections', 'settings', 'memory',
];

const SIDES = {
  A: { email: 'a@example.test', marker: 'Alpha-ONLY', slug: 'alpha', cap: 5 },
  B: { email: 'b@example.test', marker: 'Bravo-ONLY', slug: 'bravo', cap: 9 },
};
const OTHER = { A: 'B', B: 'A' };

// Every call the sweep makes, as data, so the last test can check that no route in ROUTES is missing from it.
const READS = [
  '/api/radar', '/api/events/shared-id', '/api/feed', '/api/graph', '/api/icp', '/api/memory', '/api/prefs', '/api/inbox',
  '/api/discovery/settings', '/api/ask?intent=top_events_in_range&from=2026-01-01&to=2030-12-31',
  '/api/ask?intent=changed_this_week', '/api/ask?intent=tier_a_by_event',
];
const OTHERS_IDS = (o) => [
  ['GET', `/api/events/${o.onlyEvent}`], ['GET', `/api/search/${o.run}`], ['POST', `/api/search/${o.run}/step`],
  ['POST', `/api/search/${o.run}/cancel`], ['POST', `/api/inbox/${o.candidate}/approve`], ['POST', `/api/inbox/${o.candidate}/reject`],
  ['POST', `/api/events/${o.autoEvent}/undo-auto-add`],
];
const OPERATOR_ONLY = (id) => [
  ['GET', '/api/operator/workspaces'], ['POST', `/api/operator/workspaces/${id}/approve`], ['POST', `/api/operator/workspaces/${id}/suspend`],
  ['PUT', `/api/operator/workspaces/${id}/shared-keys`],
];
const WRITES = ['/api/icp', '/api/decisions', '/api/prefs', '/api/search', '/api/discovery/settings', '/api/workspace/samples'];
const DUMMY = { onlyEvent: 'x', run: 1, candidate: 1, autoEvent: 'y' };
const STATIC_CALLS = [
  ...READS.map((p) => ['GET', p]), ...OTHERS_IDS(DUMMY), ...OPERATOR_ONLY(1),
  ['PUT', '/api/icp'], ['POST', '/api/decisions'], ['GET', '/api/prefs'], ['PUT', '/api/prefs'], ['POST', '/api/search'],
  ['PUT', '/api/discovery/settings'], ['POST', '/api/workspace/samples'],
];

let handler;
let ws;
let token;
let ids;

const snapshot = async (workspaceId) => {
  const out = {};
  for (const table of TENANT_TABLES) out[table] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).bind(workspaceId).first()).n;
  return out;
};
const rowsOf = async (table, workspaceId) =>
  (await env.DB.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`).bind(workspaceId).all()).results;
const get = (side, path) => call(handler, path, { token: token[side] });
const send = (side, method, path, body) => call(handler, path, { method, token: token[side], body });

async function seedSide(side) {
  const { email, marker, slug, cap } = SIDES[side];
  const w = ws[side];
  await addEvent({ id: 'shared-id', name: `${marker} Shared Summit`, workspaceId: w });
  await addEvent({ id: `${slug}-only-id`, name: `${marker} Extra`, workspaceId: w });
  await addEvent({ id: `${slug}-auto-id`, name: `${marker} Auto`, workspaceId: w });
  await env.DB.prepare('UPDATE events SET auto_added = 1 WHERE workspace_id = ? AND id = ?').bind(w, `${slug}-auto-id`).run();
  const company = await addCompany({ name: `${marker} Corp`, domain: 'shared.test', workspaceId: w });
  const person = await addPerson({ name: `Person ${marker}`, email: 'pat@shared.test', company_id: company, workspaceId: w });
  await attend('shared-id', person, { workspaceId: w });
  await attachCompany('shared-id', company, w);
  await addChange('shared-id', { summary: `${marker} lineup`, workspaceId: w });
  await env.DB.prepare("INSERT INTO decisions (workspace_id, event_id, user, choice, reason) VALUES (?, 'shared-id', ?, 'watch', ?)").bind(w, email, `${marker} reason`).run();
  const candidate = await env.DB.prepare(
    "INSERT INTO candidates (workspace_id, cluster_key, name, organiser, city, country, start_date, status) VALUES (?, 'ck-1', ?, 'Org', 'Paris', 'FR', '2027-09-01', 'inbox')",
  ).bind(w, `${marker} Candidate`).run();
  await env.DB.prepare("INSERT INTO candidate_sources (workspace_id, candidate_id, domain, url, adapter) VALUES (?, ?, 'cand.test', 'https://cand.test/x', 'exa')")
    .bind(w, candidate.meta.last_row_id).run();
  const run = await env.DB.prepare(
    "INSERT INTO search_runs (workspace_id, query_json, created_by, status, planned) VALUES (?, ?, ?, 'done', 0)",
  ).bind(w, JSON.stringify({ query: { query: marker }, plan: [] }), email).run();
  await env.DB.prepare("INSERT INTO run_items (workspace_id, run_id, outcome, name) VALUES (?, ?, 'inbox', ?)").bind(w, run.meta.last_row_id, `${marker} item`).run();
  await env.DB.prepare("INSERT INTO rejections (workspace_id, name_key, start_date, rejected_by) VALUES (?, 'same-rejection', '2027-01-01', ?)").bind(w, email).run();
  await putSettings(env.DB, w, { dayCapUsd: cap });
  await env.DB.prepare("INSERT INTO prefs (user, key, value) VALUES (?, 'note', ?)").bind(email, marker).run();
  await remember(env.DB, w, [{ actor: email, kind: 'icp.saved', subject: 2, detail: { version: 2, changed: [marker] } }]);
  if (side === 'B') {
    const edited = structuredClone(await getActiveConfig(env.DB, w));
    edited.thresholds.mustAttend = 77;
    await saveConfig(env.DB, w, edited, email);
  }
  ids[side] = { onlyEvent: `${slug}-only-id`, autoEvent: `${slug}-auto-id`, candidate: candidate.meta.last_row_id, run: run.meta.last_row_id };
}

beforeEach(async () => {
  await resetData();
  handler = createHandler({ discovery: { pages: fakeSearch([]), feeds: { list: async () => [] } } });
  ws = { A: 1, B: await addWorkspace({ name: 'Bravo-ONLY team' }) };
  await addUser({ email: SIDES.A.email, role: 'admin', operator: 1 });
  await addUser({ email: SIDES.B.email, role: 'admin', workspaceId: ws.B });
  token = { A: await tokenFor({ email: SIDES.A.email, role: 'admin' }), B: await tokenFor({ email: SIDES.B.email, role: 'admin' }) };
  ids = {};
  await seedSide('A');
  await seedSide('B');
});

describe('workspace isolation sweep', () => {
  it('every read returns the caller\'s own data and nothing of the other workspace, in both directions', async () => {
    const OWN = {
      '/api/radar': 'marker', '/api/events/shared-id': 'marker', '/api/feed': 'marker', '/api/graph': 'marker', '/api/memory': 'marker',
      '/api/prefs': 'marker', '/api/inbox': 'marker',
    };
    for (const side of ['A', 'B']) {
      const mine = SIDES[side];
      const theirs = SIDES[OTHER[side]];
      for (const path of READS) {
        const res = await get(side, path);
        expect(res.status, `${side} ${path}`).toBe(200);
        const text = await res.text();
        expect(text, `${side} ${path} must not contain ${theirs.marker}`).not.toContain(theirs.marker);
        if (OWN[path]) expect(text, `${side} ${path} shows its own data`).toContain(mine.marker);
      }
      const settings = (await (await get(side, '/api/discovery/settings')).json()).data;
      expect(settings.dayCapUsd, `${side} settings`).toBe(mine.cap);
      const icp = (await (await get(side, '/api/icp')).json()).data;
      expect(icp.version, `${side} ICP version`).toBe(side === 'A' ? 1 : 2);
    }
  });

  it("every route that takes an id answers 404 for the other workspace's id, and changes nothing there", async () => {
    for (const side of ['A', 'B']) {
      const other = OTHER[side];
      const before = await snapshot(ws[other]);
      const rowsBefore = Object.fromEntries(await Promise.all(TENANT_TABLES.map(async (t) => [t, await rowsOf(t, ws[other])])));
      for (const [method, path] of OTHERS_IDS(ids[other])) {
        const res = await send(side, method, path);
        expect(res.status, `${side} ${method} ${path}`).toBe(404);
      }
      expect(await snapshot(ws[other])).toEqual(before);
      for (const table of TENANT_TABLES) expect(await rowsOf(table, ws[other]), `${other} ${table} unchanged`).toEqual(rowsBefore[table]);
    }
  });

  it('writes land only in the caller\'s workspace', async () => {
    for (const side of ['A', 'B']) {
      const other = OTHER[side];
      const mine = ws[side];
      const theirsBefore = Object.fromEntries(await Promise.all(TENANT_TABLES.map(async (t) => [t, await rowsOf(t, ws[other])])));
      const myBefore = await snapshot(mine);

      const cfg = (await (await get(side, '/api/icp')).json()).data;
      const versionBefore = cfg.version;
      cfg.thresholds.mustAttend = 66;
      expect((await send(side, 'PUT', '/api/icp', cfg)).status).toBe(200);
      expect((await (await get(side, '/api/icp')).json()).data.version).toBe(versionBefore + 1);
      expect((await send(side, 'POST', '/api/decisions', { eventId: 'shared-id', choice: 'attend' })).status).toBe(201);
      expect((await send(side, 'PUT', '/api/discovery/settings', { runCapUsd: 0.25 })).status).toBe(200);
      expect((await send(side, 'PUT', '/api/prefs', { key: 'theme', value: 'dark' })).status).toBe(200);
      expect((await send(side, 'POST', '/api/inbox/' + ids[side].candidate + '/approve')).status).toBe(200);
      expect((await send(side, 'POST', `/api/events/${ids[side].autoEvent}/undo-auto-add`)).status).toBe(200);
      expect((await send(side, 'POST', '/api/workspace/samples')).json).toBeTruthy();

      const started = await send(side, 'POST', '/api/search', { query: 'shared services' });
      expect(started.status).toBe(201);
      const runId = (await started.json()).data.run.id;
      expect((await send(side, 'POST', `/api/search/${runId}/step`)).status).toBe(200);
      expect((await send(side, 'POST', `/api/search/${runId}/cancel`)).status).toBe(200);
      expect((await send(side, 'GET', `/api/search/${runId}`)).status).toBe(200);

      const myAfter = await snapshot(mine);
      expect(myAfter.icp_config).toBeGreaterThan(myBefore.icp_config);
      expect(myAfter.decisions).toBe(myBefore.decisions + 1);
      expect(myAfter.settings).toBe(myBefore.settings + 1);
      expect(myAfter.search_runs).toBe(myBefore.search_runs + 1);
      expect(myAfter.memory).toBeGreaterThan(myBefore.memory);
      const run = await env.DB.prepare('SELECT workspace_id FROM search_runs WHERE id = ?').bind(runId).first();
      expect(run.workspace_id).toBe(mine);
      for (const table of TENANT_TABLES) expect(await rowsOf(table, ws[other]), `${side} left ${other}'s ${table} alone`).toEqual(theirsBefore[table]);
    }
  });

  it('operator routes are closed to a person who is not the operator', async () => {
    for (const [method, path] of OPERATOR_ONLY(ws.A)) {
      const res = await send('B', method, path, method === 'PUT' ? { on: true } : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const stillActive = await env.DB.prepare('SELECT status, shared_keys FROM workspaces WHERE id = 1').first();
    expect(stillActive).toEqual({ status: 'active', shared_keys: 1 });
  });

  it('loads the samples into two workspaces independently', async () => {
    const a = await (await send('A', 'POST', '/api/workspace/samples')).json();
    const b = await (await send('B', 'POST', '/api/workspace/samples')).json();
    expect(a.data).toEqual({ added: 10 });
    expect(b.data).toEqual({ added: 10 });
    expect((await (await send('A', 'POST', '/api/workspace/samples')).json()).data).toEqual({ added: 0 });
    for (const side of ['A', 'B']) {
      const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE workspace_id = ? AND id = 'bvl'").bind(ws[side]).first()).n;
      expect(n).toBe(1);
    }
  });

  it('the sweep covers every route in ROUTES', () => {
    const covered = (method, regex) => STATIC_CALLS.some(([m, p]) => m === method && regex.test(new URL(p, 'https://x.test').pathname));
    const missing = ROUTES.filter(([method, regex]) => !covered(method, regex)).map(([method, regex]) => `${method} ${regex.source}`);
    expect(missing, `routes without sweep coverage: ${missing.join(', ')}`).toEqual([]);
    expect(WRITES.length).toBeGreaterThan(0);
  });
});
