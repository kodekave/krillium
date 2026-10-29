import { describe, it, expect, vi, afterEach } from 'vitest';

const LIVE = 'https://gtm-radar-api.gtm-radar.workers.dev';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function configFor(location) {
  vi.stubGlobal('location', location);
  vi.resetModules();
  return (await import('../../site/config.js')).default;
}

describe('site config', () => {
  it('talks to the local Worker when the page is served from localhost', async () => {
    expect((await configFor({ hostname: 'localhost' })).apiBase).toBe('http://localhost:8787');
    expect((await configFor({ hostname: '127.0.0.1' })).apiBase).toBe('http://localhost:8787');
  });

  it('talks to the live Worker from any other host', async () => {
    expect((await configFor({ hostname: 'kodekave.github.io' })).apiBase).toBe(LIVE);
    expect((await configFor({ hostname: 'localhost.evil.example' })).apiBase).toBe(LIVE);
  });

  it('talks to the live Worker when there is no location at all', async () => {
    expect((await configFor(undefined)).apiBase).toBe(LIVE);
  });

  it('keeps the public values the page needs', async () => {
    const config = await configFor({ hostname: 'kodekave.github.io' });
    expect(config.googleClientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(config).toHaveProperty('cockpitUrl');
  });
});
