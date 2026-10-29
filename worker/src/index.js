import { AuthError, requireUser, signSession, verifyGoogleIdToken } from './auth.js';
import { corsHeaders } from './cors.js';
import { error, json } from './http.js';
import { defaultDeps } from './discovery/deps.js';
import { ask } from './routes/ask.js';
import {
  approveInbox, cancelSearch, getDiscoverySettings, getSearch, inbox, putDiscoverySettings, rejectInbox, startSearch, stepSearch, undoAutoAddRoute,
} from './routes/discovery.js';
import { eventDetail, feed, graph, icp, memory, radar } from './routes/read.js';
import { getPrefs, postDecision, putIcp, putPref } from './routes/write.js';
import { approveWorkspace, listWorkspaces, loadSamplesRoute, setSharedKeys, suspendWorkspace } from './routes/workspaces.js';

export const ROUTES = [
  ['GET', /^\/api\/radar$/, radar],
  ['GET', /^\/api\/events\/([^/]+)$/, eventDetail],
  ['GET', /^\/api\/feed$/, feed],
  ['GET', /^\/api\/graph$/, graph],
  ['GET', /^\/api\/memory$/, memory],
  ['GET', /^\/api\/icp$/, icp],
  ['PUT', /^\/api\/icp$/, putIcp],
  ['POST', /^\/api\/decisions$/, postDecision],
  ['GET', /^\/api\/prefs$/, getPrefs],
  ['PUT', /^\/api\/prefs$/, putPref],
  ['GET', /^\/api\/ask$/, ask],
  ['POST', /^\/api\/search$/, startSearch],
  ['GET', /^\/api\/search\/(\d+)$/, getSearch],
  ['POST', /^\/api\/search\/(\d+)\/step$/, stepSearch],
  ['POST', /^\/api\/search\/(\d+)\/cancel$/, cancelSearch],
  ['GET', /^\/api\/inbox$/, inbox],
  ['POST', /^\/api\/inbox\/(\d+)\/approve$/, approveInbox],
  ['POST', /^\/api\/inbox\/(\d+)\/reject$/, rejectInbox],
  ['POST', /^\/api\/events\/([^/]+)\/undo-auto-add$/, undoAutoAddRoute],
  ['GET', /^\/api\/discovery\/settings$/, getDiscoverySettings],
  ['PUT', /^\/api\/discovery\/settings$/, putDiscoverySettings],
  ['GET', /^\/api\/operator\/workspaces$/, listWorkspaces],
  ['POST', /^\/api\/operator\/workspaces\/(\d+)\/approve$/, approveWorkspace],
  ['POST', /^\/api\/operator\/workspaces\/(\d+)\/suspend$/, suspendWorkspace],
  ['PUT', /^\/api\/operator\/workspaces\/(\d+)\/shared-keys$/, setSharedKeys],
  ['POST', /^\/api\/workspace\/samples$/, loadSamplesRoute],
];

// Sign-ups wait for the operator's approval; this many waiting at once is the most the app will hold.
const MAX_PENDING_WORKSPACES = 50;

const SIGN_IN_SQL = `SELECT u.email, u.name, u.role, u.active, u.operator, u.workspace_id, w.name AS workspace_name, w.status
  FROM users u LEFT JOIN workspaces w ON w.id = u.workspace_id
  WHERE lower(u.email) = lower(?)`;

// A verified Google account the app has not seen before asks for a workspace: a pending workspace and an admin user
// in it, made in one batch so neither exists without the other. Returns 'closed' when too many are already waiting.
async function requestWorkspace(env, identity) {
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE status = 'pending'").first();
  if (waiting.n >= MAX_PENDING_WORKSPACES) return 'closed';
  const name = `${identity.name}'s workspace`.slice(0, 60);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspaces (name, status) VALUES (?, 'pending')").bind(name),
      env.DB.prepare("INSERT INTO users (email, name, role, workspace_id) VALUES (?, ?, 'admin', last_insert_rowid())")
        .bind(identity.email, identity.name),
    ]);
  } catch (e) {
    // Two first sign-ins at once: the other one made this person already (and the batch rolled back), so read theirs.
    if (!/UNIQUE|constraint/i.test(`${e?.message ?? ''} ${e?.cause?.message ?? ''}`)) throw e;
  }
  return 'requested';
}

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
  let row = await env.DB.prepare(SIGN_IN_SQL).bind(identity.email).first();
  if (!row) {
    if ((await requestWorkspace(env, identity)) === 'closed') return error(503, 'sign-ups are closed for now');
    row = await env.DB.prepare(SIGN_IN_SQL).bind(identity.email).first();
  }
  if (!row || !row.active || !row.workspace_id) return error(403, 'this workspace is not active');
  if (row.status === 'pending') return json({ status: 'pending' }, 202);
  if (row.status !== 'active') return error(403, 'this workspace is not active');
  const user = { email: row.email, name: row.name ?? identity.name, role: row.role };
  return json({
    token: await signSession(user, env.SESSION_SECRET),
    user,
    workspace: { id: row.workspace_id, name: row.workspace_name },
    operator: Boolean(row.operator),
  });
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
    return handler({ request, env, url, user, params: match.slice(1), deps: discovery ?? defaultDeps(env, user) });
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
