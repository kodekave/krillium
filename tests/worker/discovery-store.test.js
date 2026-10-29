import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildGroup, cluster, rejectionKey } from '../../site/js/shared/discovery.js';
import {
  DiscoveryError, addSourcesToEvent, approveCandidate, listInbox, loadContext, reevaluate, rejectCandidate, saveGroup, undoAutoAdd,
} from '../../worker/src/discovery/store.js';
import { addEvent, addPerson, attend, resetData } from './helpers.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const USER = 'member@example.test';

const obs = (over = {}) => ({
  name: 'SSOW Orlando', organiser: 'SSON', startDate: '2027-03-08', endDate: '2027-03-11', city: 'Orlando', country: 'US',
  online: false, cancelled: false, url: 'https://ssonetwork.com/orlando', sourceDomain: 'ssonetwork.com', adapter: 'exa',
  title: 'SSOW Orlando', quotes: { name: 'SSOW Orlando', dates: '8-11 March 2027' }, topicHits: 1, ...over,
});
const group = (...observations) => buildGroup(observations);
const count = async (table, where = '1 = 1') => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first()).n;
const candidate = (id) => env.DB.prepare('SELECT * FROM candidates WHERE id = ?').bind(id).first();

// Saves one group and re-evaluates it, as a run does.
async function see(g) {
  const { candidateId } = await saveGroup(env.DB, g, NOW);
  return { candidateId, ...(await reevaluate(env.DB, candidateId, NOW)) };
}

const threeSites = () => group(
  obs(), obs({ sourceDomain: 'luminik.io', url: 'https://luminik.io/x' }), obs({ sourceDomain: '10times.com', url: 'https://10times.com/x' }),
);

beforeEach(resetData);

describe('auto-add', () => {
  it('three distinct domains saved in separate runs auto-add on the third', async () => {
    const first = await see(group(obs()));
    expect(first.status).toBe('inbox');
    const second = await see(group(obs({ name: 'SSOW Orlando 2027', startDate: '2027-03-09', sourceDomain: 'luminik.io', url: 'https://luminik.io/x' })));
    expect(second.candidateId).toBe(first.candidateId);
    expect(second.status).toBe('inbox');
    const third = await see(group(obs({ sourceDomain: '10times.com', url: 'https://10times.com/x' })));
    expect(third.candidateId).toBe(first.candidateId);
    expect(third.status).toBe('auto_added');

    const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(third.eventId).first();
    expect(event).toMatchObject({ origin: 'discovered', auto_added: 1, name: 'SSOW Orlando', country: 'US', last_checked: null });
    expect(event.lat).toBeCloseTo(28.5383, 3);
    expect(await count('event_sources', `event_id = '${third.eventId}'`)).toBe(3);
    const change = await env.DB.prepare('SELECT kind, summary FROM changes WHERE event_id = ?').bind(third.eventId).first();
    expect(change.kind).toBe('new_event');
    expect(change.summary).toMatch(/^Found on 3 sites: /);
    expect(await candidate(first.candidateId)).toMatchObject({ status: 'auto_added', event_id: third.eventId });
  });

  it('conflicting sources never auto-add and keep their conflict text', async () => {
    const result = await see(group(
      obs(), obs({ sourceDomain: 'luminik.io', url: 'https://luminik.io/x' }),
      obs({ sourceDomain: '10times.com', url: 'https://10times.com/x', startDate: '2027-03-15' }),
    ));
    expect(result.status).toBe('inbox');
    expect((await candidate(result.candidateId)).conflict).toMatch(/dates disagree: 2027-03-08 vs 2027-03-15/);
    expect(await count('events')).toBe(0);
  });

  it('promotion is atomic: when the batch fails no event, source or change exists', async () => {
    const { candidateId } = await saveGroup(env.DB, threeSites(), NOW);
    const failing = { prepare: (sql) => env.DB.prepare(sql), batch: async () => { throw new Error('boom'); } };
    await expect(reevaluate(failing, candidateId, NOW)).rejects.toThrow('boom');
    expect(await count('events')).toBe(0);
    expect(await count('event_sources')).toBe(0);
    expect(await count('changes')).toBe(0);
    expect((await candidate(candidateId)).status).toBe('inbox');
  });
});

describe('approve and reject', () => {
  it('approve creates the event with suggested scores, event_sources and a new_event change', async () => {
    const { candidateId } = await saveGroup(env.DB, group(obs()), NOW);
    const { eventId } = await approveCandidate(env.DB, candidateId, USER, NOW);
    expect(eventId).toBe('ssow-orlando-2027-03');
    const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    expect(event).toMatchObject({
      origin: 'discovered', auto_added: 0, city: 'Orlando', start_date: '2027-03-08', end_date: '2027-03-11',
      fit: 2, public_names: 0, timing: 5, distance: 3, last_checked: null, url: 'https://ssonetwork.com/orlando',
    });
    expect(await count('event_sources', `event_id = '${eventId}'`)).toBe(1);
    const change = await env.DB.prepare('SELECT kind, summary FROM changes WHERE event_id = ?').bind(eventId).first();
    expect(change.kind).toBe('new_event');
    expect(change.summary).toMatch(/^Approved from the inbox/);
    expect(await candidate(candidateId)).toMatchObject({ status: 'approved', event_id: eventId });
  });

  it('a second event with the same name and month gets a numeric suffix', async () => {
    const berlin = obs({ name: 'Procurement Summit', city: 'Berlin', country: 'DE' });
    const orlando = obs({ name: 'Procurement Summit', city: 'Orlando', country: 'US', sourceDomain: 'a.com', url: 'https://a.com/x' });
    const a = await saveGroup(env.DB, group(berlin), NOW);
    const b = await saveGroup(env.DB, group(orlando), NOW);
    expect(b.candidateId).not.toBe(a.candidateId);
    const first = await approveCandidate(env.DB, a.candidateId, USER, NOW);
    const second = await approveCandidate(env.DB, b.candidateId, USER, NOW);
    expect([first.eventId, second.eventId]).toEqual(['procurement-summit-2027-03', 'procurement-summit-2027-03-2']);
  });

  it('reject records a rejection that cluster() later filters', async () => {
    const { candidateId } = await saveGroup(env.DB, group(obs()), NOW);
    await rejectCandidate(env.DB, candidateId, USER, NOW);
    expect((await candidate(candidateId)).status).toBe('rejected');
    const { existing, rejected } = await loadContext(env.DB);
    expect(rejected.has(rejectionKey('SSOW Orlando', '2027-03-08'))).toBe(true);
    const result = cluster([obs({ sourceDomain: 'x.com' })], { existing, rejected, now: NOW });
    expect(result.groups).toEqual([]);
    expect(result.filtered[0].reason).toBe('rejected');
  });

  it('saveGroup never moves an approved or rejected candidate back to the inbox', async () => {
    const approved = await saveGroup(env.DB, group(obs()), NOW);
    await approveCandidate(env.DB, approved.candidateId, USER, NOW);
    expect((await saveGroup(env.DB, group(obs({ sourceDomain: 'b.com', url: 'https://b.com/x' })), NOW)).status).toBe('approved');
    expect((await candidate(approved.candidateId)).status).toBe('approved');

    const rejected = await saveGroup(env.DB, group(obs({ name: 'BME Symposium', city: 'Berlin', country: 'DE' })), NOW);
    await rejectCandidate(env.DB, rejected.candidateId, USER, NOW);
    expect((await saveGroup(env.DB, group(obs({ name: 'BME Symposium', city: 'Berlin', country: 'DE', sourceDomain: 'c.com', url: 'https://c.com/x' })), NOW)).status).toBe('rejected');
    expect((await candidate(rejected.candidateId)).status).toBe('rejected');
  });

  it('approve and reject refuse unknown or already-handled candidates', async () => {
    await expect(approveCandidate(env.DB, 999, USER, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(rejectCandidate(env.DB, 999, USER, NOW)).rejects.toMatchObject({ status: 404 });
    const { candidateId } = await saveGroup(env.DB, group(obs()), NOW);
    await approveCandidate(env.DB, candidateId, USER, NOW);
    await expect(approveCandidate(env.DB, candidateId, USER, NOW)).rejects.toMatchObject({ status: 409 });
    await expect(rejectCandidate(env.DB, candidateId, USER, NOW)).rejects.toMatchObject({ status: 409 });
  });
});

describe('undo', () => {
  async function autoAdded() {
    const { eventId } = await see(threeSites());
    return eventId;
  }

  it('removes the event, its sources and changes, records a rejection and leaves a removed audit change', async () => {
    const eventId = await autoAdded();
    await undoAutoAdd(env.DB, eventId, USER, NOW);
    expect(await count('events')).toBe(0);
    expect(await count('event_sources')).toBe(0);
    expect(await count('changes', `event_id = '${eventId}'`)).toBe(0);
    expect(await count('rejections', `name_key = '${rejectionKey('SSOW Orlando', '2027-03-08').split('|')[0]}' AND start_date = '2027-03-08'`)).toBe(1);
    const audit = await env.DB.prepare("SELECT event_id, summary FROM changes WHERE kind = 'removed'").first();
    expect(audit.event_id).toBeNull();
    expect(audit.summary).toBe(`Removed auto-added SSOW Orlando (${USER})`);
    expect(await env.DB.prepare('SELECT status, event_id FROM candidates').first()).toEqual({ status: 'rejected', event_id: null });
  });

  it('returns 409 when a decision exists', async () => {
    const eventId = await autoAdded();
    await env.DB.prepare("INSERT INTO decisions (event_id, user, choice) VALUES (?, ?, 'watch')").bind(eventId, 'other@example.test').run();
    await expect(undoAutoAdd(env.DB, eventId, USER, NOW)).rejects.toMatchObject({ status: 409 });
    expect(await count('events')).toBe(1);
  });

  it('returns 409 when people are attached', async () => {
    const eventId = await autoAdded();
    await attend(eventId, await addPerson());
    await expect(undoAutoAdd(env.DB, eventId, USER, NOW)).rejects.toMatchObject({ status: 409 });
    expect(await count('events')).toBe(1);
  });

  it('returns 409 for an event that was not auto-added and 404 for an unknown one', async () => {
    const imported = await addEvent();
    await expect(undoAutoAdd(env.DB, imported.id, USER, NOW)).rejects.toBeInstanceOf(DiscoveryError);
    await expect(undoAutoAdd(env.DB, imported.id, USER, NOW)).rejects.toMatchObject({ status: 409 });
    await expect(undoAutoAdd(env.DB, 'nope', USER, NOW)).rejects.toMatchObject({ status: 404 });
    expect(await count('events')).toBe(1);
  });
});

describe('tracked events and the inbox', () => {
  it('a tracked event gains a source and no duplicate event is created', async () => {
    const event = await addEvent({ id: 'ssow-orl', name: 'SSOW Orlando', city: 'Orlando', country: 'US', start_date: '2027-03-08' });
    const changesBefore = await count('changes');
    const seen = [obs(), obs({ sourceDomain: 'luminik.io', url: 'https://luminik.io/x' })];
    await addSourcesToEvent(env.DB, event.id, seen, NOW);
    await addSourcesToEvent(env.DB, event.id, seen, NOW);
    expect(await count('event_sources', `event_id = '${event.id}'`)).toBe(2);
    expect(await count('events')).toBe(1);
    expect(await count('changes')).toBe(changesBefore);
  });

  it('loadContext returns existing events and rejected keys', async () => {
    await addEvent({ id: 'e1', name: 'Event One', city: 'Berlin', country: 'DE', start_date: '2027-03-08' });
    const { existing, rejected } = await loadContext(env.DB);
    expect(existing).toEqual([{ id: 'e1', name: 'Event One', startDate: '2027-03-08', city: 'Berlin', country: 'DE' }]);
    expect(rejected.size).toBe(0);
  });

  it('listInbox returns inbox candidates with sources, reason and suggested score', async () => {
    const a = await saveGroup(env.DB, group(obs(), obs({ sourceDomain: 'luminik.io', url: 'https://luminik.io/x' })), NOW);
    const b = await saveGroup(env.DB, group(obs({ name: 'BME Symposium', city: 'Berlin', country: 'DE', startDate: '2026-11-18' })), NOW);
    await approveCandidate(env.DB, b.candidateId, USER, NOW);
    const items = await listInbox(env.DB, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: a.candidateId, name: 'SSOW Orlando', startDate: '2027-03-08', city: 'Orlando', country: 'US', reason: '2 of 3 sites', conflict: null });
    expect(items[0].sources.map((s) => s.domain).sort()).toEqual(['luminik.io', 'ssonetwork.com']);
    expect(items[0].sources[0]).toHaveProperty('quote');
    expect(items[0].suggested).toMatchObject({ public_names: 0, timing: 5 });
  });
});
