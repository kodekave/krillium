import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { createHandler } from '../../worker/src/index.js';
import {
  resetData, addUser, addEvent, addCompany, addPerson, attend, addChange, daysAgo, tokenFor, call,
} from './helpers.js';

let handler;
let token;

beforeEach(async () => {
  await resetData();
  await addUser();
  handler = createHandler();
  token = await tokenFor();
});

async function config() {
  return (await (await call(handler, '/api/icp', { token })).json()).data;
}

describe('PUT /api/icp', () => {
  it('rejects shares that do not sum to 1 and saves nothing', async () => {
    const bad = await config();
    bad.weights.icpDensityShare = 0.8;
    const res = await call(handler, '/api/icp', { method: 'PUT', token, body: bad });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors.join(' ')).toMatch(/sum to 1/);
    expect((await config()).version).toBe(1);
  });

  it('rejects a consider threshold at or above must-attend', async () => {
    const bad = await config();
    bad.thresholds.consider = 70;
    const res = await call(handler, '/api/icp', { method: 'PUT', token, body: bad });
    expect(res.status).toBe(400);
  });

  it('rejects a config with a missing table', async () => {
    const bad = await config();
    delete bad.persona;
    const res = await call(handler, '/api/icp', { method: 'PUT', token, body: bad });
    expect(res.status).toBe(400);
  });

  it('saves a valid config as the next version', async () => {
    const edited = await config();
    edited.thresholds.mustAttend = 75;
    const res = await call(handler, '/api/icp', { method: 'PUT', token, body: edited });
    expect(res.status).toBe(200);
    expect((await res.json()).data.version).toBe(2);
    const active = await config();
    expect(active.version).toBe(2);
    expect(active.thresholds.mustAttend).toBe(75);
  });
});

async function seedStrongEvent(id = 'd1') {
  await addEvent({ id, fit: 4, public_names: 4, timing: 4, distance: 4 });
  for (let i = 0; i < 4; i += 1) {
    const company = await addCompany({ name: `Buyer ${id} ${i}`, domain: `buyer${id}${i}.test` });
    const person = await addPerson({ name: `Person ${id} ${i}`, email: `p${id}${i}@buyer.test`, company_id: company });
    await attend(id, person);
  }
}

describe('POST /api/decisions', () => {
  it('stores the decision with the score and config version at that moment', async () => {
    await seedStrongEvent();
    const res = await call(handler, '/api/decisions', {
      method: 'POST', token, body: { eventId: 'd1', choice: 'attend', reason: 'High ICP density' },
    });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare('SELECT * FROM decisions WHERE event_id = ?').bind('d1').first();
    expect(row).toMatchObject({
      user: 'member@example.test', choice: 'attend', reason: 'High ICP density', score_snapshot: 92, config_version: 1,
    });
  });

  it('requires a reason to skip', async () => {
    await seedStrongEvent();
    const res = await call(handler, '/api/decisions', { method: 'POST', token, body: { eventId: 'd1', choice: 'skip' } });
    expect(res.status).toBe(400);
  });

  it('rejects a choice outside attend, watch and skip', async () => {
    await seedStrongEvent();
    const res = await call(handler, '/api/decisions', { method: 'POST', token, body: { eventId: 'd1', choice: 'maybe' } });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown event', async () => {
    const res = await call(handler, '/api/decisions', { method: 'POST', token, body: { eventId: 'nope', choice: 'watch' } });
    expect(res.status).toBe(404);
  });
});

describe('/api/prefs', () => {
  it('saves and returns a preference for the signed-in user', async () => {
    await call(handler, '/api/prefs', { method: 'PUT', token, body: { key: 'theme', value: 'light' } });
    const { data } = await (await call(handler, '/api/prefs', { token })).json();
    expect(data).toEqual({ theme: 'light' });
  });

  it('does not show one user the preferences of another', async () => {
    await addUser({ email: 'other@example.test', name: 'Other' });
    const otherToken = await tokenFor({ email: 'other@example.test', name: 'Other' });
    await call(handler, '/api/prefs', { method: 'PUT', token, body: { key: 'theme', value: 'light' } });
    const { data } = await (await call(handler, '/api/prefs', { token: otherToken })).json();
    expect(data).toEqual({});
  });

  it('rejects a value over 4 KB', async () => {
    const res = await call(handler, '/api/prefs', { method: 'PUT', token, body: { key: 'filters', value: 'x'.repeat(4097) } });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid key', async () => {
    const res = await call(handler, '/api/prefs', { method: 'PUT', token, body: { key: 'Bad Key!', value: 'x' } });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/ask', () => {
  it('top_events_in_range returns only events overlapping the range, best first', async () => {
    await seedStrongEvent('march');
    await addEvent({ id: 'may', start_date: '2027-05-10', end_date: '2027-05-13' });
    await addEvent({ id: 'april', start_date: '2027-04-20', end_date: null });
    const res = await call(handler, '/api/ask?intent=top_events_in_range&from=2027-03-01&to=2027-04-30', { token });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.rows.map((e) => e.id)).toEqual(['march', 'april']);
  });

  it('top_events_in_range needs valid dates', async () => {
    const res = await call(handler, '/api/ask?intent=top_events_in_range&from=soon&to=later', { token });
    expect(res.status).toBe(400);
  });

  it('changed_this_week returns recent real changes and skips imports and old ones', async () => {
    await addEvent({ id: 'c1' });
    await addChange('c1', { kind: 'lineup', summary: 'recent', at: daysAgo(2) });
    await addChange('c1', { kind: 'lineup', summary: 'old', at: daysAgo(20) });
    await addChange('c1', { kind: 'imported', summary: 'import', at: daysAgo(1) });
    const { data } = await (await call(handler, '/api/ask?intent=changed_this_week', { token })).json();
    expect(data.rows.map((r) => r.summary)).toEqual(['recent']);
  });

  it('tier_a_by_event ranks events by Tier A people', async () => {
    await seedStrongEvent('many');
    await addEvent({ id: 'none' });
    const { data } = await (await call(handler, '/api/ask?intent=tier_a_by_event', { token })).json();
    expect(data.rows[0]).toMatchObject({ id: 'many', tierA: 4 });
  });

  it('tier_a_by_event accepts an optional date range', async () => {
    await seedStrongEvent('inrange');
    await env.DB.prepare("UPDATE events SET start_date = '2027-03-08', end_date = '2027-03-10' WHERE id = 'inrange'").run();
    await seedStrongEvent('outrange');
    await env.DB.prepare("UPDATE events SET start_date = '2027-09-08', end_date = '2027-09-10' WHERE id = 'outrange'").run();
    const { data } = await (await call(handler, '/api/ask?intent=tier_a_by_event&from=2027-03-01&to=2027-03-31', { token })).json();
    expect(data.rows.map((r) => r.id)).toEqual(['inrange']);
  });

  it('rejects an unknown intent', async () => {
    const res = await call(handler, '/api/ask?intent=drop_tables', { token });
    expect(res.status).toBe(400);
  });
});
