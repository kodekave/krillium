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
    'memory', 'run_items', 'candidate_sources', 'candidates', 'search_runs', 'rejections', 'page_cache', 'event_sources', 'settings',
    'decisions', 'changes', 'event_people', 'event_companies', 'signals', 'people', 'companies',
    'events', 'prefs', 'users', 'icp_config', 'runs', 'calendar_tokens',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // Workspace 1 is made by the migration and always exists; every other workspace belongs to one test.
  await env.DB.prepare('DELETE FROM workspaces WHERE id != 1').run();
  await env.DB.prepare("UPDATE workspaces SET name = 'Main workspace', status = 'active', shared_keys = 1 WHERE id = 1").run();
}

export async function addWorkspace(over = {}) {
  const w = { name: 'Test workspace', status: 'active', shared_keys: 0, ...over };
  const r = await env.DB.prepare('INSERT INTO workspaces (name, status, shared_keys) VALUES (?, ?, ?)')
    .bind(w.name, w.status, w.shared_keys)
    .run();
  return r.meta.last_row_id;
}

export async function addUser(over = {}) {
  const u = { email: 'member@example.test', name: 'Team Member', role: 'member', active: 1, workspaceId: 1, operator: 0, ...over };
  await env.DB.prepare('INSERT INTO users (email, name, role, active, workspace_id, operator) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(u.email, u.name, u.role, u.active, u.workspaceId, u.operator)
    .run();
  return u;
}

// Each helper below takes a workspaceId (default 1) and writes it explicitly, so the helpers keep working once
// migration 0005 removes the column default.
export async function addEvent(over = {}) {
  const e = {
    id: 'e1', name: 'Event One', organiser: 'Organiser', url: 'https://example.test/e1', city: 'Berlin',
    country: 'DE', lat: 52.52, lon: 13.405, start_date: '2027-03-08', end_date: '2027-03-11',
    source_url: 'https://example.test/e1/speakers', last_checked: daysAgo(1), fit: 4, public_names: 4,
    timing: 4, distance: 4, workspaceId: 1, ...over,
  };
  await env.DB.prepare(
    `INSERT INTO events (id, name, organiser, url, city, country, lat, lon, start_date, end_date,
       source_url, last_checked, fit, public_names, timing, distance, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(e.id, e.name, e.organiser, e.url, e.city, e.country, e.lat, e.lon, e.start_date, e.end_date,
      e.source_url, e.last_checked, e.fit, e.public_names, e.timing, e.distance, e.workspaceId)
    .run();
  return e;
}

export async function addCompany(over = {}) {
  const c = { name: 'Acme', domain: null, vendor: 0, workspaceId: 1, ...over };
  const r = await env.DB.prepare('INSERT INTO companies (name, domain, vendor, workspace_id) VALUES (?, ?, ?, ?)')
    .bind(c.name, c.domain, c.vendor, c.workspaceId)
    .run();
  return r.meta.last_row_id;
}

export async function addPerson(over = {}) {
  const p = { name: 'Pat Person', email: null, company_id: null, title: 'CFO', persona: 'economic_buyer',
    source_url: 'https://example.test/person', workspaceId: 1, ...over };
  const r = await env.DB.prepare(
    'INSERT INTO people (name, email, company_id, title, persona, source_url, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(p.name, p.email, p.company_id, p.title, p.persona, p.source_url, p.workspaceId)
    .run();
  return r.meta.last_row_id;
}

export async function attend(eventId, personId, over = {}) {
  const a = { role: 'speaker', fit: 35, contact: 'verified_email', workspaceId: 1, ...over };
  await env.DB.prepare('INSERT INTO event_people (event_id, person_id, role, fit, contact, workspace_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(eventId, personId, a.role, a.fit, a.contact, a.workspaceId)
    .run();
}

export async function attachCompany(eventId, companyId, workspaceId = 1) {
  await env.DB.prepare('INSERT INTO event_companies (event_id, company_id, workspace_id) VALUES (?, ?, ?)')
    .bind(eventId, companyId, workspaceId)
    .run();
}

export async function addChange(eventId, over = {}) {
  const c = { kind: 'lineup', summary: 'Lineup published', at: new Date().toISOString(), workspaceId: 1, ...over };
  await env.DB.prepare('INSERT INTO changes (event_id, kind, summary, at, workspace_id) VALUES (?, ?, ?, ?, ?)')
    .bind(eventId, c.kind, c.summary, c.at, c.workspaceId)
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

// Counts the database statements a piece of code prepares, to hold it to the free plan's 50 queries per request.
// A statement prepared for a batch counts too, which is the cautious reading of the limit.
export function countingDb(real = env.DB) {
  let n = 0;
  return {
    db: { prepare: (sql) => { n += 1; return real.prepare(sql); }, batch: (statements) => real.batch(statements) },
    count: () => n,
  };
}

// Discovery fakes. eventPage() describes an event the way Exa returns it: the page text plus the structured summary
// Exa read from it (a JSON string). fakeSearch() returns pages together with the cost Exa would report for the call.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const SEARCH_COST = 0.03;
export const MODEL_COST = 0.002; // 1,000 tokens in and 200 out at the default Claude prices
const summaries = new Map();

export function eventPage(url, spec) {
  const e = { organiser: 'SSON', country: 'United States', cancelled: false, badDate: false, endDate: null, ...spec };
  const [year, month, day] = e.startDate.split('-').map(Number);
  const dateText = `${day} ${MONTH_NAMES[month - 1]} ${year}`;
  // badDate states a start date in the wrong month, which its own quote cannot support.
  const startDate = e.badDate ? e.startDate.replace(/-(\d\d)-/, (_, mm) => `-${String((Number(mm) % 12) + 1).padStart(2, '0')}-`) : e.startDate;
  const summary = JSON.stringify({
    isEvent: true, name: e.name, organiser: e.organiser, startDate, endDate: e.endDate, city: e.city, country: e.country,
    online: false, cancelled: e.cancelled, quotes: { name: e.name, dates: dateText, city: e.city },
  });
  summaries.set(url, JSON.parse(summary));
  return { url, title: e.name, adapter: 'exa', text: `${e.name}. ${e.city}. ${dateText}. Organised by ${e.organiser}.`, summary };
}

// A page as Exa returns it when it was not asked for a summary, because Claude will read it instead.
export const plain = (page) => ({ ...page, summary: null });

export function fakeSearch(resolve = [], { costUsd = SEARCH_COST } = {}) {
  const calls = [];
  return {
    calls,
    async search(spec) {
      calls.push(spec);
      const result = typeof resolve === 'function' ? resolve(spec, calls.length) : resolve;
      if (result instanceof Error) throw result;
      return { pages: result, costUsd };
    },
  };
}

// Answers extraction requests like Claude would: one object per page in the prompt that eventPage() described.
export function fakeModel({ throws, usage = { input: 1000, output: 200 } } = {}) {
  const calls = [];
  return {
    calls,
    async extract(request) {
      calls.push(request);
      if (throws) throw throws;
      const items = [...request.user.matchAll(/<page id="(\d+)">\nURL: (\S+)/g)].flatMap(([, id, url]) => {
        const summary = summaries.get(url);
        if (!summary) return [];
        const { isEvent, ...fields } = summary;
        return [{ page: Number(id), ...fields }];
      });
      return { text: JSON.stringify(items), usage };
    },
  };
}
