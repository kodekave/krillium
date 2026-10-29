import { describe, expect, it } from 'vitest';
import { FIRST_RUN_STEPS, loadSamples } from '../../site/js/first-run.js';

describe('FIRST_RUN_STEPS', () => {
  it('offers three steps: set sectors, load the sample events, find events', () => {
    expect(FIRST_RUN_STEPS.map((s) => s.id)).toEqual(['sectors', 'samples', 'find']);
    for (const step of FIRST_RUN_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.text.length).toBeGreaterThan(0);
      expect(step.label.length).toBeGreaterThan(0);
    }
  });

  it('sends the sector and search steps to their screens, and makes loading samples an action', () => {
    const byId = Object.fromEntries(FIRST_RUN_STEPS.map((s) => [s.id, s]));
    expect(byId.sectors.href).toBe('#/icp');
    expect(byId.find.href).toBe('#/find');
    expect(byId.samples.href).toBeUndefined();
    expect(byId.samples.label).toBe('Load sample events');
  });
});

describe('loadSamples', () => {
  const api = (answer) => ({ calls: [], post(path) { this.calls.push(path); return Promise.resolve(answer); } });

  it('posts to the samples route and says how many events were loaded', async () => {
    const fake = api({ ok: true, status: 200, data: { added: 10 } });
    expect(await loadSamples(fake)).toEqual({ ok: true, added: 10, message: 'Loaded 10 sample events.' });
    expect(fake.calls).toEqual(['/api/workspace/samples']);
  });

  it('says so when there is only one, or when they were already loaded', async () => {
    expect((await loadSamples(api({ ok: true, status: 200, data: { added: 1 } }))).message).toBe('Loaded 1 sample event.');
    expect(await loadSamples(api({ ok: true, status: 200, data: { added: 0 } }))).toEqual({
      ok: true, added: 0, message: 'The sample events are already loaded.',
    });
  });

  it('explains a refusal, an unreachable service and any other failure in plain words', async () => {
    expect(await loadSamples(api({ ok: false, status: 403 }))).toEqual({ ok: false, message: 'Only an admin of this workspace can load the sample events.' });
    expect(await loadSamples(api({ ok: false, stale: true }))).toEqual({ ok: false, message: 'Cannot reach the radar service. Check your connection and try again.' });
    expect(await loadSamples(api({ ok: false, status: 500 }))).toEqual({ ok: false, message: 'The sample events could not be loaded. Try again.' });
  });
});
