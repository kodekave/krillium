import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHandler } from '../../worker/src/index.js';
import { SAMPLE_EVENTS } from '../../worker/src/samples.js';
import { addUser, call, resetData, tokenFor } from './helpers.js';

let handler;
let admin;
let member;

const load = (token) => call(handler, '/api/workspace/samples', { method: 'POST', token });
const eventCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE workspace_id = 1').first()).n;

beforeEach(async () => {
  await resetData();
  handler = createHandler();
  await addUser({ email: 'admin@example.test', role: 'admin' });
  await addUser({ email: 'member@example.test' });
  admin = await tokenFor({ email: 'admin@example.test', role: 'admin' });
  member = await tokenFor({ email: 'member@example.test' });
});

describe('sample events', () => {
  it('defines the ten public case-study events', () => {
    expect(SAMPLE_EVENTS).toHaveLength(10);
    expect(SAMPLE_EVENTS[0]).toMatchObject({ id: 'bvl', name: 'BVL Supply Chain CX', city: 'Berlin', country: 'DE', startDate: '2026-10-21' });
  });

  it("loads the ten samples into the caller's workspace and answers how many were added", async () => {
    const res = await load(admin);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ added: 10 });
    expect(await eventCount()).toBe(10);
  });

  it('adds nothing the second time', async () => {
    await load(admin);
    expect((await (await load(admin)).json()).data).toEqual({ added: 0 });
    expect(await eventCount()).toBe(10);
  });

  it('refuses a member who is not an admin with 403', async () => {
    expect((await load(member)).status).toBe(403);
    expect(await eventCount()).toBe(0);
  });

  it('tags the samples with the procurement sector and places them on the map', async () => {
    await load(admin);
    const { results } = await env.DB.prepare('SELECT sectors, origin, lat, lon FROM events WHERE workspace_id = 1').all();
    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r.sectors).toBe('["procurement"]');
      expect(r.origin).toBe('import');
      expect(typeof r.lat).toBe('number');
      expect(typeof r.lon).toBe('number');
    }
  });
});
