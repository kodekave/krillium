import { AuthError, requireUser, signSession, verifyGoogleIdToken } from './auth.js';
import { corsHeaders } from './cors.js';
import { error, json } from './http.js';
import { eventDetail, feed, icp, radar } from './routes/read.js';

const ROUTES = [
  ['GET', /^\/api\/radar$/, radar],
  ['GET', /^\/api\/events\/([^/]+)$/, eventDetail],
  ['GET', /^\/api\/feed$/, feed],
  ['GET', /^\/api\/icp$/, icp],
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
  const row = await env.DB.prepare('SELECT email, name, role, active FROM users WHERE email = ?')
    .bind(identity.email)
    .first();
  if (!row || !row.active) return error(403, 'this account is not on the allow-list');
  const user = { email: row.email, name: row.name ?? identity.name, role: row.role };
  return json({ token: await signSession(user, env.SESSION_SECRET), user });
}

async function route(request, env, getJwks) {
  const url = new URL(request.url);
  if (request.method === 'POST' && url.pathname === '/auth/google') {
    return authGoogle(request, env, getJwks);
  }
  for (const [method, pattern, handler] of ROUTES) {
    const match = request.method === method ? pattern.exec(url.pathname) : null;
    if (!match) continue;
    const user = await requireUser(request, env);
    return handler({ request, env, url, user, params: match.slice(1) });
  }
  if (url.pathname.startsWith('/api/')) await requireUser(request, env);
  return error(404, 'not found');
}

export function createHandler({ getJwks } = {}) {
  return async function handle(request, env) {
    const cors = corsHeaders(request.headers.get('origin'), env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, env, getJwks);
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
