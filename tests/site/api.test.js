import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApi } from '../../site/js/api.js';

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(fetchImpl, token = 'tok-123') {
  const api = createApi({ apiBase: 'https://api.test/' }, { fetchImpl, getToken: () => token });
  return api;
}

describe('createApi', () => {
  it('sends the bearer token and resolves URLs from apiBase', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { data: { a: 1 } }));
    const result = await setup(fetchImpl).get('/api/radar');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test/api/radar');
    expect(init.headers.authorization).toBe('Bearer tok-123');
    expect(result).toEqual({ ok: true, status: 200, data: { a: 1 } });
  });

  it('marks the result stale when the network fails', async () => {
    const api = setup(vi.fn(async () => { throw new TypeError('network down'); }));
    expect(await api.get('/api/radar')).toEqual({ ok: false, stale: true });
  });

  it('calls the unauthorised handler once on a 401', async () => {
    const api = setup(vi.fn(async () => reply(401, { error: 'unauthorised' })));
    const handler = vi.fn();
    api.onUnauthorised(handler);
    const result = await api.get('/api/radar');
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('returns the error message and validation errors from a 400', async () => {
    const api = setup(vi.fn(async () => reply(400, { error: 'invalid config', errors: ['weights must sum to 1'] })));
    const result = await api.put('/api/icp', { x: 1 });
    expect(result).toMatchObject({ ok: false, status: 400, error: 'invalid config', errors: ['weights must sum to 1'] });
  });

  it('sends JSON bodies on put and post', async () => {
    const fetchImpl = vi.fn(async () => reply(201, { data: { id: 1 } }));
    const api = setup(fetchImpl);
    await api.post('/api/decisions', { eventId: 'e1', choice: 'attend' });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ eventId: 'e1', choice: 'attend' });
  });

  it('omits the authorization header when signed out', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { data: null }));
    await setup(fetchImpl, null).get('/api/radar');
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBeUndefined();
  });
});

describe('index.html', () => {
  const html = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');

  it('uses no absolute-path asset URLs, so it works under any subpath', () => {
    const absolute = [...html.matchAll(/(?:src|href)="(\/[^/"][^"]*)"/g)].map((m) => m[1]);
    expect(absolute).toEqual([]);
  });

  it('loads its entry module by a relative path', () => {
    expect(html).toMatch(/<script type="module" src="js\/main\.js"><\/script>/);
  });
});

describe('createApi connection state', () => {
  it('reports stale after a network failure and fresh after the next success', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new TypeError('network down');
      return reply(200, { data: [] });
    });
    const api = setup(fetchImpl);
    const events = [];
    api.onStale(() => events.push('stale'));
    api.onFresh(() => events.push('fresh'));
    await api.get('/api/radar');
    fail = false;
    await api.get('/api/radar');
    expect(events).toEqual(['stale', 'fresh']);
  });
});

describe('sessionEndedMessage', () => {
  it('only claims a session ended when there was a session', async () => {
    const { sessionEndedMessage } = await import('../../site/js/auth.js');
    expect(sessionEndedMessage(true)).toMatch(/session ended/i);
    expect(sessionEndedMessage(false)).toBeUndefined();
  });
});
