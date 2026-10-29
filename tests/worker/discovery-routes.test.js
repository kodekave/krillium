import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildGroup } from '../../site/js/shared/discovery.js';
import { createHandler } from '../../worker/src/index.js';
import { SourceError } from '../../worker/src/discovery/plan.js';
import { reevaluate, saveGroup } from '../../worker/src/discovery/store.js';
import { addEvent, addUser, call, eventPage, fakeModel, fakeSearch, resetData, tokenFor } from './helpers.js';

const NOW = Date.now();
const ADMIN = 'admin@example.test';

const orlando = { name: 'SSOW Orlando', startDate: '2027-03-08', city: 'Orlando' };
const pageA = eventPage('https://ssonetwork.com/orlando', orlando);

const feeds = { list: async () => [] };
const deps = (over = {}) => ({ pages: fakeSearch([pageA]), feeds, ...over });
const START = { query: 'shared services', from: '2027-01-01', to: '2027-06-30' };

let member;
let admin;

beforeEach(async () => {
  await resetData();
  await addUser();
  await addUser({ email: ADMIN, name: 'Admin', role: 'admin' });
  member = await tokenFor();
  admin = await tokenFor({ email: ADMIN, name: 'Admin', role: 'admin' });
});

const api = (handler, path, options = {}) => call(handler, path, { token: member, ...options });
const data = async (response) => (await response.json()).data;

// Three sites for one event, saved as a run would, so the event is auto-added.
async function autoAdd() {
  const obs = (sourceDomain) => ({
    name: 'SSOW Orlando', organiser: 'SSON', startDate: '2027-03-08', endDate: '2027-03-11', city: 'Orlando', country: 'US',
    online: false, cancelled: false, url: `https://${sourceDomain}/ssow`, sourceDomain, adapter: 'exa', title: 'SSOW Orlando', quotes: { dates: '8-11 March 2027' }, topicHits: 1,
  });
  const { candidateId } = await saveGroup(env.DB, 1, buildGroup(['ssonetwork.com', 'luminik.io', '10times.com'].map(obs)), NOW);
  return (await reevaluate(env.DB, 1, candidateId, NOW)).eventId;
}

describe('authentication and settings', () => {
  it('every discovery route returns 401 without a session', async () => {
    const handler = createHandler({ discovery: deps() });
    const routes = [
      ['POST', '/api/search'], ['GET', '/api/search/1'], ['POST', '/api/search/1/step'], ['GET', '/api/inbox'],
      ['POST', '/api/search/1/cancel'], ['POST', '/api/inbox/1/approve'], ['POST', '/api/inbox/1/reject'], ['POST', '/api/events/e1/undo-auto-add'],
      ['GET', '/api/discovery/settings'], ['PUT', '/api/discovery/settings'],
    ];
    for (const [method, path] of routes) {
      const response = await call(handler, path, { method, body: method === 'GET' ? undefined : {} });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('any member reads the settings; only an admin changes them', async () => {
    const handler = createHandler({ discovery: deps() });
    expect((await data(await api(handler, '/api/discovery/settings'))).runCapUsd).toBe(0.5);
    const denied = await api(handler, '/api/discovery/settings', { method: 'PUT', body: { runCapUsd: 1 } });
    expect(denied.status).toBe(403);
    const saved = await api(handler, '/api/discovery/settings', { method: 'PUT', token: admin, body: { runCapUsd: 1 } });
    expect(saved.status).toBe(200);
    expect((await data(saved)).runCapUsd).toBe(1);
    expect((await data(await api(handler, '/api/discovery/settings'))).runCapUsd).toBe(1);
  });

  it('the settings response lists the missing secrets so the page can say so before a search', async () => {
    expect((await data(await api(createHandler({ discovery: deps() }), '/api/discovery/settings'))).missing).toEqual([]);
    expect((await data(await api(createHandler(), '/api/discovery/settings'))).missing).toEqual(['EXA_API_KEY']);
    expect((await data(await api(createHandler({ discovery: deps({ pages: null }) }), '/api/discovery/settings'))).missing).toEqual(['EXA_API_KEY']);
  });

  it('the settings response says who reads the pages: Exa alone, or Claude once an Anthropic key is set', async () => {
    expect((await data(await api(createHandler({ discovery: deps() }), '/api/discovery/settings'))).reader).toBe('exa');
    expect((await data(await api(createHandler({ discovery: deps({ model: fakeModel() }) }), '/api/discovery/settings'))).reader).toBe('claude');
  });

  it('a saved settings response carries neither the missing list nor the reader', async () => {
    const saved = await api(createHandler({ discovery: deps() }), '/api/discovery/settings', { method: 'PUT', token: admin, body: { maxPages: 60 } });
    const body = await data(saved);
    expect(body).not.toHaveProperty('missing');
    expect(body).not.toHaveProperty('reader');
  });

  it('rejects invalid settings with the reasons', async () => {
    const handler = createHandler({ discovery: deps() });
    const response = await api(handler, '/api/discovery/settings', { method: 'PUT', token: admin, body: { runCapUsd: -5, bogus: 1 } });
    expect(response.status).toBe(400);
    expect((await response.json()).errors.join(' ')).toMatch(/runCapUsd/);
  });
});

describe('starting a search', () => {
  it('returns 503 naming the missing secrets when no keys are configured', async () => {
    const response = await api(createHandler(), '/api/search', { method: 'POST', body: START });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('discovery is not set up');
    expect(body.missing).toEqual(['EXA_API_KEY']);
  });

  it('names the Exa key when search is not set up, and starts nothing', async () => {
    const handler = createHandler({ discovery: deps({ pages: null }) });
    const response = await api(handler, '/api/search', { method: 'POST', body: START });
    expect(response.status).toBe(503);
    expect((await response.json()).missing).toEqual(['EXA_API_KEY']);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM search_runs').first()).n).toBe(0);
  });

  it('validates its input', async () => {
    const handler = createHandler({ discovery: deps() });
    const bad = [
      {}, { query: 'a' }, { query: 'x'.repeat(201) }, { ...START, from: '2027-13-01' }, { ...START, from: '2027-06-30', to: '2027-01-01' },
      { ...START, region: 'r'.repeat(61) }, { ...START, sectors: 'pharma' }, { ...START, sectors: [3] }, { ...START, sectors: ['nope'] },
      { ...START, sectors: new Array(13).fill('pharma') },
    ];
    for (const body of bad) {
      expect((await api(handler, '/api/search', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('refuses a second search while one is running and while paused', async () => {
    const handler = createHandler({ discovery: deps() });
    expect((await api(handler, '/api/search', { method: 'POST', body: START })).status).toBe(201);
    expect((await api(handler, '/api/search', { method: 'POST', body: START })).status).toBe(409);
    await api(handler, '/api/discovery/settings', { method: 'PUT', token: admin, body: { paused: true } });
    expect((await api(handler, '/api/search', { method: 'POST', body: START, token: admin })).status).toBe(423);
  });

  it('defaults the dates to the next 12 months and the topics to the saved list', async () => {
    const handler = createHandler({ discovery: deps() });
    const { run } = await data(await api(handler, '/api/search', { method: 'POST', body: { query: 'shared services' } }));
    expect(run.planned).toBeGreaterThan(2);
    const stored = JSON.parse((await env.DB.prepare('SELECT query_json FROM search_runs WHERE id = ?').bind(run.id).first()).query_json).query;
    expect(stored.from).toBe(new Date().toISOString().slice(0, 10));
    expect(stored.to > stored.from).toBe(true);
    expect(stored.sectors).toEqual(['procurement', 'finance-ops', 'pharma', 'manufacturing', 'banking']);
    expect(stored.topics).toContain('shared services');
  });
});

describe('choosing sectors', () => {
  const stored = async (run) => JSON.parse((await env.DB.prepare('SELECT query_json FROM search_runs WHERE id = ?').bind(run.id).first()).query_json).query;
  const start = async (handler, body) => data(await api(handler, '/api/search', { method: 'POST', body: { ...START, ...body } }));

  it('searches the sectors you pick, one topic from each in turn, in the order of the settings', async () => {
    const { run } = await start(createHandler({ discovery: deps() }), { sectors: ['banking', 'pharma'] });
    const query = await stored(run);
    expect(query.sectors).toEqual(['pharma', 'banking']);
    expect(query.topics.slice(0, 4)).toEqual(['pharma supply chain', 'banking operations', 'pharmaceutical procurement', 'insurance operations']);
  });

  it('searches no topics when you pick none, so only your own words are used', async () => {
    const { run } = await start(createHandler({ discovery: deps() }), { sectors: [] });
    const query = await stored(run);
    expect(query).toMatchObject({ sectors: [], topics: [] });
  });

  it('ignores topics sent by an older page', async () => {
    const { run } = await start(createHandler({ discovery: deps() }), { sectors: ['pharma'], topics: ['something else'] });
    expect((await stored(run)).topics).not.toContain('something else');
  });

  it('leaves a switched-off sector out by default and refuses it when asked for', async () => {
    const handler = createHandler({ discovery: deps() });
    const current = (await data(await api(handler, '/api/discovery/settings'))).sectors;
    const off = current.map((s) => (s.id === 'banking' ? { ...s, enabled: false } : s));
    expect((await api(handler, '/api/discovery/settings', { method: 'PUT', token: admin, body: { sectors: off } })).status).toBe(200);
    const refused = await api(handler, '/api/search', { method: 'POST', body: { ...START, sectors: ['banking'] } });
    expect(refused.status).toBe(400);
    const { run } = await start(handler, {});
    expect((await stored(run)).sectors).toEqual(['procurement', 'finance-ops', 'pharma', 'manufacturing']);
  });

  it('refuses a settings change that leaves a sector malformed, with the reason', async () => {
    const handler = createHandler({ discovery: deps() });
    const bad = await api(handler, '/api/discovery/settings', { method: 'PUT', token: admin, body: { sectors: [{ id: 'A b', name: 'x', topics: ['t'], enabled: true }] } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors.join(' ')).toMatch(/sector 1/);
  });
});

describe('running a search', () => {
  it('start, step and get return the run and its grouped items', async () => {
    const handler = createHandler({ discovery: deps() });
    const started = await api(handler, '/api/search', { method: 'POST', body: START });
    expect(started.status).toBe(201);
    const { run, items } = await data(started);
    // every sector is searched by default: 12 web searches (the most a run makes) plus the 2 Confs.tech files for 2027
    expect(run).toMatchObject({ status: 'running', planned: 14, done: 0 });
    expect(items).toEqual([]);

    const stepped = await data(await api(handler, `/api/search/${run.id}/step`, { method: 'POST', body: {} }));
    expect(stepped.run).toMatchObject({ done: 1, pages: 1 });
    expect(stepped.items[0]).toMatchObject({ outcome: 'inbox', name: 'SSOW Orlando', city: 'Orlando' });

    const fetched = await data(await api(handler, `/api/search/${run.id}`));
    expect(fetched.items).toEqual(stepped.items);
  });

  it('cancel stops a run so its owner can search again, and nobody else but an admin can cancel it', async () => {
    const handler = createHandler({ discovery: deps() });
    const { run } = await data(await api(handler, '/api/search', { method: 'POST', body: START }));
    await addUser({ email: 'other@example.test', name: 'Other', role: 'member' });
    const other = await tokenFor({ email: 'other@example.test', name: 'Other', role: 'member' });
    expect((await api(handler, `/api/search/${run.id}/cancel`, { method: 'POST', body: {}, token: other })).status).toBe(403);
    const stopped = await api(handler, `/api/search/${run.id}/cancel`, { method: 'POST', body: {} });
    expect(stopped.status).toBe(200);
    expect((await data(stopped)).run.status).toBe('stopped');
    expect((await api(handler, '/api/search', { method: 'POST', body: START })).status).toBe(201);
    expect((await api(handler, '/api/search/999/cancel', { method: 'POST', body: {} })).status).toBe(404);
  });

  it('returns 404 for an unknown run', async () => {
    const handler = createHandler({ discovery: deps() });
    expect((await api(handler, '/api/search/999')).status).toBe(404);
    expect((await api(handler, '/api/search/999/step', { method: 'POST', body: {} })).status).toBe(404);
  });

  it('never passes an upstream 401 on as a 401 that would sign the user out', async () => {
    const handler = createHandler({ discovery: deps({ pages: fakeSearch(new SourceError(401, 'bad key')) }) });
    const { run } = await data(await api(handler, '/api/search', { method: 'POST', body: START }));
    const response = await api(handler, `/api/search/${run.id}/step`, { method: 'POST', body: {} });
    expect(response.status).toBe(200);
    expect((await data(response)).run.note).toMatch(/exa failed/);
  });

  it('a step without keys returns 503 as well', async () => {
    const { run } = await data(await api(createHandler({ discovery: deps() }), '/api/search', { method: 'POST', body: START }));
    const response = await api(createHandler(), `/api/search/${run.id}/step`, { method: 'POST', body: {} });
    expect(response.status).toBe(503);
  });
});

describe('inbox and undo', () => {
  async function twoInbox(handler) {
    const pageB = eventPage('https://bme.de/symposium', { name: 'BME Symposium Procurement', startDate: '2027-04-19', city: 'Berlin', country: 'Germany' });
    const withTwo = createHandler({ discovery: deps({ pages: fakeSearch([pageA, pageB]) }) });
    const { run } = await data(await api(withTwo, '/api/search', { method: 'POST', body: START }));
    await api(withTwo, `/api/search/${run.id}/step`, { method: 'POST', body: {} });
    return data(await api(handler, '/api/inbox'));
  }

  it('lists the inbox and approves, rejects and refuses with the documented statuses', async () => {
    const handler = createHandler({ discovery: deps() });
    const inbox = await twoInbox(handler);
    expect(inbox).toHaveLength(2);
    expect(inbox[0]).toHaveProperty('sources');
    expect(inbox[0]).toHaveProperty('suggested');
    const [first, second] = inbox;

    const approved = await api(handler, `/api/inbox/${first.id}/approve`, { method: 'POST', body: {} });
    expect(approved.status).toBe(200);
    const { eventId } = await data(approved);
    expect((await api(handler, `/api/inbox/${first.id}/approve`, { method: 'POST', body: {} })).status).toBe(409);
    expect((await api(handler, '/api/inbox/99999/approve', { method: 'POST', body: {} })).status).toBe(404);

    expect((await api(handler, `/api/inbox/${second.id}/reject`, { method: 'POST', body: {} })).status).toBe(200);
    expect((await api(handler, `/api/inbox/${second.id}/reject`, { method: 'POST', body: {} })).status).toBe(409);
    expect((await api(handler, '/api/inbox/99999/reject', { method: 'POST', body: {} })).status).toBe(404);
    expect(await data(await api(handler, '/api/inbox'))).toEqual([]);

    expect((await api(handler, `/api/events/${eventId}/undo-auto-add`, { method: 'POST', body: {} })).status).toBe(409);
  });

  it('undo removes an auto-added event and answers 404 for an unknown one', async () => {
    const handler = createHandler({ discovery: deps() });
    const eventId = await autoAdd();
    expect((await api(handler, `/api/events/${eventId}/undo-auto-add`, { method: 'POST', body: {} })).status).toBe(200);
    expect((await data(await api(handler, '/api/radar'))).map((e) => e.id)).not.toContain(eventId);
    expect((await api(handler, '/api/events/nope/undo-auto-add', { method: 'POST', body: {} })).status).toBe(404);
  });
});

describe('radar and event detail', () => {
  it('the radar payload marks discovered events with origin and autoAdded', async () => {
    const handler = createHandler({ discovery: deps() });
    const imported = await addEvent({ id: 'imp', name: 'Imported Event', city: 'Berlin', country: 'DE' });
    const eventId = await autoAdd();
    const radar = await data(await api(handler, '/api/radar'));
    expect(radar.find((e) => e.id === eventId)).toMatchObject({ origin: 'discovered', autoAdded: true });
    expect(radar.find((e) => e.id === imported.id)).toMatchObject({ origin: 'import', autoAdded: false });
  });

  it("the radar payload and event detail carry each event's sectors", async () => {
    const handler = createHandler({ discovery: deps() });
    await addEvent({ id: 'tagged', name: 'Tagged Event' });
    await env.DB.prepare("UPDATE events SET sectors = '[\"pharma\",\"banking\"]' WHERE id = 'tagged'").run();
    await addEvent({ id: 'plain', name: 'Plain Event' });
    const radar = await data(await api(handler, '/api/radar'));
    expect(radar.find((e) => e.id === 'tagged').sectors).toEqual(['pharma', 'banking']);
    expect(radar.find((e) => e.id === 'plain').sectors).toEqual([]);
    expect((await data(await api(handler, '/api/events/tagged'))).sectors).toEqual(['pharma', 'banking']);
  });

  it('event detail lists the pages that found a discovered event', async () => {
    const handler = createHandler({ discovery: deps() });
    const eventId = await autoAdd();
    const detail = await data(await api(handler, `/api/events/${eventId}`));
    const found = detail.sources.filter((s) => s.label === 'Found by search').map((s) => s.url).sort();
    expect(found).toContain('https://luminik.io/ssow');
    expect(detail.sources.map((s) => s.url)).toContain('https://10times.com/ssow');
  });

  it('preflight allows POST from the configured origin', async () => {
    const handler = createHandler({ discovery: deps() });
    const response = await call(handler, '/api/search/1/step', { method: 'OPTIONS', origin: env.ALLOWED_ORIGIN });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(env.ALLOWED_ORIGIN);
    expect(response.headers.get('access-control-allow-methods')).toMatch(/POST/);
  });
});
