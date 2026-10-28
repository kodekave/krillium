import { env } from 'cloudflare:test';
import { signSession } from '../../worker/src/auth.js';

const enc = new TextEncoder();

export const b64url = (input) => {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }, kid };
}

export async function makeIdToken({ privateKey, kid }, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://accounts.google.com',
    aud: env.GOOGLE_CLIENT_ID,
    exp: now + 3600,
    iat: now,
    email: 'member@example.test',
    email_verified: true,
    name: 'Team Member',
    ...overrides,
  };
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

export async function resetData() {
  for (const table of [
    'decisions', 'changes', 'event_people', 'event_companies', 'signals', 'people', 'companies',
    'events', 'prefs', 'users', 'icp_config', 'runs', 'calendar_tokens',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

export async function addUser(over = {}) {
  const u = { email: 'member@example.test', name: 'Team Member', role: 'member', active: 1, ...over };
  await env.DB.prepare('INSERT INTO users (email, name, role, active) VALUES (?, ?, ?, ?)')
    .bind(u.email, u.name, u.role, u.active)
    .run();
  return u;
}

export async function addEvent(over = {}) {
  const e = {
    id: 'e1', name: 'Event One', organiser: 'Organiser', url: 'https://example.test/e1', city: 'Berlin',
    country: 'DE', lat: 52.52, lon: 13.405, start_date: '2027-03-08', end_date: '2027-03-11',
    source_url: 'https://example.test/e1/speakers', last_checked: daysAgo(1), fit: 4, public_names: 4,
    timing: 4, distance: 4, ...over,
  };
  await env.DB.prepare(
    `INSERT INTO events (id, name, organiser, url, city, country, lat, lon, start_date, end_date,
       source_url, last_checked, fit, public_names, timing, distance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(e.id, e.name, e.organiser, e.url, e.city, e.country, e.lat, e.lon, e.start_date, e.end_date,
      e.source_url, e.last_checked, e.fit, e.public_names, e.timing, e.distance)
    .run();
  return e;
}

export async function addCompany(over = {}) {
  const c = { name: 'Acme', domain: null, vendor: 0, ...over };
  const r = await env.DB.prepare('INSERT INTO companies (name, domain, vendor) VALUES (?, ?, ?)')
    .bind(c.name, c.domain, c.vendor)
    .run();
  return r.meta.last_row_id;
}

export async function addPerson(over = {}) {
  const p = { name: 'Pat Person', email: null, company_id: null, title: 'CFO', persona: 'economic_buyer',
    source_url: 'https://example.test/person', ...over };
  const r = await env.DB.prepare(
    'INSERT INTO people (name, email, company_id, title, persona, source_url) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(p.name, p.email, p.company_id, p.title, p.persona, p.source_url)
    .run();
  return r.meta.last_row_id;
}

export async function attend(eventId, personId, over = {}) {
  const a = { role: 'speaker', score: 95, tier: 'A', ...over };
  await env.DB.prepare('INSERT INTO event_people (event_id, person_id, role, score, tier) VALUES (?, ?, ?, ?, ?)')
    .bind(eventId, personId, a.role, a.score, a.tier)
    .run();
}

export async function attachCompany(eventId, companyId) {
  await env.DB.prepare('INSERT INTO event_companies (event_id, company_id) VALUES (?, ?)')
    .bind(eventId, companyId)
    .run();
}

export async function addChange(eventId, over = {}) {
  const c = { kind: 'lineup', summary: 'Lineup published', at: new Date().toISOString(), ...over };
  await env.DB.prepare('INSERT INTO changes (event_id, kind, summary, at) VALUES (?, ?, ?, ?)')
    .bind(eventId, c.kind, c.summary, c.at)
    .run();
}

export async function tokenFor(user = {}) {
  return signSession(
    { email: 'member@example.test', name: 'Team Member', role: 'member', ...user },
    env.SESSION_SECRET,
  );
}

export async function call(handler, path, { method = 'GET', token, origin, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`https://api.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handler(request, env);
}
