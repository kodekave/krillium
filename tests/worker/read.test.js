import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { createHandler } from '../../worker/src/index.js';
import {
  makeKeyPair, makeIdToken, resetData, addUser, addEvent, addCompany, addPerson, attend,
  attachCompany, addChange, daysAgo, tokenFor, call,
} from './helpers.js';

let handler;
let keys;
let token;

beforeEach(async () => {
  await resetData();
  await addUser();
  keys = await makeKeyPair('k1');
  handler = createHandler({ getJwks: async () => keys.jwks });
  token = await tokenFor();
});

describe('access control', () => {
  it('returns 401 without a token', async () => {
    const res = await call(handler, '/api/radar');
    expect(res.status).toBe(401);
  });

  it('answers preflight from the allowed origin with that exact origin', async () => {
    const res = await call(handler, '/api/radar', { method: 'OPTIONS', origin: env.ALLOWED_ORIGIN });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(env.ALLOWED_ORIGIN);
    expect(res.headers.get('access-control-allow-headers').toLowerCase()).toContain('authorization');
  });

  it('gives no CORS header to another origin', async () => {
    const res = await call(handler, '/api/radar', { method: 'OPTIONS', origin: 'https://evil.example.test' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('lets the allowed origin read a 401 body', async () => {
    const res = await call(handler, '/api/radar', { origin: env.ALLOWED_ORIGIN });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe(env.ALLOWED_ORIGIN);
  });

  it('returns 404 for an unknown route', async () => {
    const res = await call(handler, '/api/nope', { token });
    expect(res.status).toBe(404);
  });
});

describe('POST /auth/google', () => {
  it('returns 403 for an email that is not on the allow-list', async () => {
    const idToken = await makeIdToken(keys, { email: 'stranger@example.test' });
    const res = await call(handler, '/auth/google', { method: 'POST', body: { idToken } });
    expect(res.status).toBe(403);
  });

  it('returns 403 for an inactive user', async () => {
    await addUser({ email: 'gone@example.test', active: 0 });
    const idToken = await makeIdToken(keys, { email: 'gone@example.test' });
    const res = await call(handler, '/auth/google', { method: 'POST', body: { idToken } });
    expect(res.status).toBe(403);
  });

  it('returns a session token for an allow-listed email', async () => {
    const idToken = await makeIdToken(keys);
    const res = await call(handler, '/auth/google', { method: 'POST', body: { idToken } });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.user).toMatchObject({ email: 'member@example.test', role: 'member' });
    const radar = await call(handler, '/api/radar', { token: data.token });
    expect(radar.status).toBe(200);
  });

  it('returns 401 for a token that does not verify', async () => {
    const res = await call(handler, '/auth/google', { method: 'POST', body: { idToken: 'not.a.token' } });
    expect(res.status).toBe(401);
  });
});

async function seedRadar() {
  await addEvent({ id: 'hi', name: 'High ICP', fit: 4, public_names: 4, timing: 4, distance: 4 });
  for (let i = 0; i < 4; i += 1) {
    const company = await addCompany({ name: `Buyer ${i}`, domain: `buyer${i}.test` });
    const person = await addPerson({ name: `Buyer Person ${i}`, email: `p${i}@buyer${i}.test`, company_id: company });
    await attend('hi', person);
  }
  await addEvent({ id: 'lo', name: 'No People', fit: 5, public_names: 5, timing: 4, distance: 4 });
}

describe('GET /api/radar', () => {
  it('returns events sorted by priority with status', async () => {
    await seedRadar();
    const res = await call(handler, '/api/radar', { token });
    const { data } = await res.json();
    expect(data.map((e) => e.id)).toEqual(['hi', 'lo']);
    expect(data[0]).toMatchObject({ priority: 92, status: 'must-attend', counts: { tierA: 4, tierB: 0, accountOnly: 0 } });
    expect(data[0].eventScore20).toBe(16);
  });

  it('ranks an event with no attached people from its event score alone', async () => {
    await seedRadar();
    const { data } = await (await call(handler, '/api/radar', { token })).json();
    const lo = data.find((e) => e.id === 'lo');
    expect(Number.isFinite(lo.priority)).toBe(true);
    expect(lo.priority).toBeCloseTo(0.4 * (18 / 20) * 100, 5);
    expect(lo.status).toBe('watch');
  });

  it('still returns an event with no coordinates or end date, marked needs-check', async () => {
    await addEvent({ id: 'tbc', lat: null, lon: null, end_date: null, last_checked: null });
    const { data } = await (await call(handler, '/api/radar', { token })).json();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 'tbc', lat: null, lon: null, endDate: null, freshness: 'needs-check' });
  });

  it('marks a page read 36 days ago needs-check and one read 10 days ago verified', async () => {
    await addEvent({ id: 'stale', last_checked: daysAgo(36) });
    await addEvent({ id: 'fresh', last_checked: daysAgo(10) });
    const { data } = await (await call(handler, '/api/radar', { token })).json();
    const byId = Object.fromEntries(data.map((e) => [e.id, e.freshness]));
    expect(byId).toEqual({ stale: 'needs-check', fresh: 'verified' });
  });

  it('marks an event with a recent real change as changed, but not an import entry', async () => {
    await addEvent({ id: 'moved', last_checked: daysAgo(1) });
    await addChange('moved', { kind: 'lineup', at: daysAgo(2) });
    await addEvent({ id: 'imp', last_checked: daysAgo(1) });
    await addChange('imp', { kind: 'imported', at: daysAgo(1) });
    const { data } = await (await call(handler, '/api/radar', { token })).json();
    const byId = Object.fromEntries(data.map((e) => [e.id, e.freshness]));
    expect(byId).toEqual({ moved: 'changed', imp: 'verified' });
  });

  it('does not count vendor people or vendor companies toward ICP counts', async () => {
    await addEvent({ id: 'v' });
    const vendor = await addCompany({ name: 'Vendor Co', domain: 'vendor.test', vendor: 1 });
    const person = await addPerson({ name: 'Vendor Person', email: 'v@vendor.test', company_id: vendor });
    await attend('v', person);
    await attachCompany('v', vendor);
    const { data } = await (await call(handler, '/api/radar', { token })).json();
    expect(data[0].counts).toEqual({ tierA: 0, tierB: 0, accountOnly: 0 });
  });
});

describe('GET /api/events/:id', () => {
  it('returns reasons, accounts, sources and history built from stored facts', async () => {
    await addEvent({ id: 'd1', source_url: 'https://example.test/d1/speakers' });
    const acme = await addCompany({ name: 'Acme', domain: 'acme.test' });
    const person = await addPerson({ name: 'Ada Buyer', email: 'ada@acme.test', company_id: acme, title: 'CFO' });
    await attend('d1', person);
    const solo = await addCompany({ name: 'Solo Co', domain: 'solo.test' });
    await attachCompany('d1', solo);
    const vendor = await addCompany({ name: 'Vendor Co', domain: 'vendor.test', vendor: 1 });
    await attachCompany('d1', vendor);
    await addChange('d1', { kind: 'imported', summary: 'Imported from the Sheet', at: daysAgo(3) });

    const res = await call(handler, '/api/events/d1', { token });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe('d1');
    expect(data.reasons.length).toBeGreaterThan(0);
    expect(data.reasons.every((r) => typeof r === 'string')).toBe(true);
    expect(data.accounts.map((a) => a.company).sort()).toEqual(['Acme', 'Solo Co']);
    expect(data.accounts.find((a) => a.company === 'Acme')).toMatchObject({ tier: 'A', persona: 'economic_buyer', role: 'speaker' });
    expect(data.sources.map((s) => s.url)).toContain('https://example.test/d1/speakers');
    expect(data.history[0]).toMatchObject({ kind: 'imported', summary: 'Imported from the Sheet' });
    expect(data.vendorCount).toBe(1);
    expect(data.vendorShare).toBeCloseTo(1 / 3, 5);
  });

  it('includes the signed-in user\'s latest decision and nobody else\'s', async () => {
    await addEvent({ id: 'dd' });
    await env.DB.prepare('INSERT INTO decisions (event_id, user, choice, reason, at) VALUES (?, ?, ?, ?, ?)')
      .bind('dd', 'member@example.test', 'watch', 'wait for lineup', daysAgo(3)).run();
    await env.DB.prepare('INSERT INTO decisions (event_id, user, choice, reason, at) VALUES (?, ?, ?, ?, ?)')
      .bind('dd', 'member@example.test', 'attend', 'lineup is strong', daysAgo(1)).run();
    await env.DB.prepare('INSERT INTO decisions (event_id, user, choice, reason, at) VALUES (?, ?, ?, ?, ?)')
      .bind('dd', 'other@example.test', 'skip', 'not for us', daysAgo(0)).run();
    const { data } = await (await call(handler, '/api/events/dd', { token })).json();
    expect(data.myDecision).toMatchObject({ choice: 'attend', reason: 'lineup is strong' });
  });

  it('returns a null myDecision when the user has not decided', async () => {
    await addEvent({ id: 'nd' });
    const { data } = await (await call(handler, '/api/events/nd', { token })).json();
    expect(data.myDecision).toBeNull();
  });

  it('returns 404 for an unknown event', async () => {
    const res = await call(handler, '/api/events/unknown', { token });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/feed', () => {
  it('returns the 50 newest changes, newest first', async () => {
    await addEvent({ id: 'f1' });
    for (let i = 0; i < 55; i += 1) await addChange('f1', { summary: `change ${i}`, at: daysAgo(i) });
    const { data } = await (await call(handler, '/api/feed', { token })).json();
    expect(data).toHaveLength(50);
    expect(data[0].summary).toBe('change 0');
    expect(data[49].summary).toBe('change 49');
  });
});

describe('GET /api/icp', () => {
  it('returns the active config', async () => {
    const { data } = await (await call(handler, '/api/icp', { token })).json();
    expect(data.version).toBe(1);
    expect(data.thresholds.mustAttend).toBe(70);
  });
});

describe('GET /api/graph', () => {
  it('returns accounts grouped by event and leaves vendors out', async () => {
    await addEvent({ id: 'g1' });
    const acme = await addCompany({ name: 'Acme', domain: 'acme.test' });
    const person = await addPerson({ name: 'Ada Buyer', email: 'ada@acme.test', company_id: acme });
    await attend('g1', person);
    const solo = await addCompany({ name: 'Solo Co', domain: 'solo.test' });
    await attachCompany('g1', solo);
    const vendor = await addCompany({ name: 'Vendor Co', domain: 'vendor.test', vendor: 1 });
    await attachCompany('g1', vendor);
    const { data } = await (await call(handler, '/api/graph', { token })).json();
    expect(data.accountsByEvent.g1.map((a) => a.company).sort()).toEqual(['Acme', 'Solo Co']);
    expect(data.accountsByEvent.g1.find((a) => a.company === 'Acme')).toMatchObject({ domain: 'acme.test', persona: 'economic_buyer', tier: 'A' });
  });

  it('requires a token', async () => {
    expect((await call(handler, '/api/graph')).status).toBe(401);
  });
});
