import { AuthError, requireUser, signSession, verifyGoogleIdToken } from './auth.js';
import { corsHeaders } from './cors.js';
import { error, json } from './http.js';
import { defaultDeps } from './discovery/deps.js';
import { ask } from './routes/ask.js';
import {
  approveInbox, getDiscoverySettings, getSearch, inbox, putDiscoverySettings, rejectInbox, startSearch, stepSearch, undoAutoAddRoute,
} from './routes/discovery.js';
import { eventDetail, feed, graph, icp, radar } from './routes/read.js';
import { getPrefs, postDecision, putIcp, putPref } from './routes/write.js';

const ROUTES = [
  ['GET', /^\/api\/radar$/, radar],
  ['GET', /^\/api\/events\/([^/]+)$/, eventDetail],
  ['GET', /^\/api\/feed$/, feed],
  ['GET', /^\/api\/graph$/, graph],
  ['GET', /^\/api\/icp$/, icp],
  ['PUT', /^\/api\/icp$/, putIcp],
  ['POST', /^\/api\/decisions$/, postDecision],
  ['GET', /^\/api\/prefs$/, getPrefs],
  ['PUT', /^\/api\/prefs$/, putPref],
  ['GET', /^\/api\/ask$/, ask],
  ['POST', /^\/api\/search$/, startSearch],
  ['GET', /^\/api\/search\/(\d+)$/, getSearch],
  ['POST', /^\/api\/search\/(\d+)\/step$/, stepSearch],
  ['GET', /^\/api\/inbox$/, inbox],
  ['POST', /^\/api\/inbox\/(\d+)\/approve$/, approveInbox],
  ['POST', /^\/api\/inbox\/(\d+)\/reject$/, rejectInbox],
  ['POST', /^\/api\/events\/([^/]+)\/undo-auto-add$/, undoAutoAddRoute],
  ['GET', /^\/api\/discovery\/settings$/, getDiscoverySettings],
  ['PUT', /^\/api\/discovery\/settings$/, putDiscoverySettings],
];

async function authGoogle(request, env, getJwks) {
  let body;
  try {
    body = await request.json();
  } catch {
    return error(400, 'invalid JSON body');
  }
  let identity;
  try {
    identity = await verifyGoogleIdToken(body?.idToken, env, getJwks);
  } catch (e) {
    if (e instanceof AuthError) return error(401, 'sign-in could not be verified');
    throw e;
  }
  const row = await env.DB.prepare('SELECT email, name, role, active FROM users WHERE lower(email) = lower(?)')
    .bind(identity.email)
    .first();
  if (!row || !row.active) return error(403, 'this account is not on the allow-list');
  const user = { email: row.email, name: row.name ?? identity.name, role: row.role };
  return json({ token: await signSession(user, env.SESSION_SECRET), user });
}

async function route(request, env, getJwks, discovery) {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/auth/google') {
    return authGoogle(request, env, getJwks);
  }
  for (const [method, pattern, handler] of ROUTES) {
    const match = request.method === method ? pattern.exec(url.pathname) : null;
    if (!match) continue;
    const user = await requireUser(request, env);
    return handler({ request, env, url, user, params: match.slice(1), deps: discovery ?? defaultDeps(env) });
  }
  if (url.pathname.startsWith('/api/')) await requireUser(request, env);
  return error(404, 'not found');
}

export function createHandler({ getJwks, discovery } = {}) {
  return async function handle(request, env) {
    const cors = corsHeaders(request.headers.get('origin'), env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, env, getJwks, discovery);
    } catch (e) {
      if (e instanceof Response) {
        response = e;
      } else {
        console.error(e);
        response = error(500, 'internal error');
      }
    }
    const out = new Response(response.body, response);
    for (const [name, value] of Object.entries(cors)) out.headers.set(name, value);
    return out;
  };
}

export default { fetch: createHandler() };
