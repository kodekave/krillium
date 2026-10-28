// Google sign-in verification and HS256 session tokens, using Web Crypto only.

const SESSION_LIFE_SECONDS = 8 * 3600;
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(input) {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function parseJson(bytes) {
  return JSON.parse(dec.decode(bytes));
}

async function fetchGoogleJwks() {
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new AuthError('could not load Google signing keys');
  return res.json();
}

export async function verifyGoogleIdToken(idToken, env, getJwks = fetchGoogleJwks) {
  const parts = String(idToken ?? '').split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');
  let header;
  let payload;
  try {
    header = parseJson(b64urlDecode(parts[0]));
    payload = parseJson(b64urlDecode(parts[1]));
  } catch {
    throw new AuthError('malformed token');
  }
  if (header.alg !== 'RS256') throw new AuthError('unsupported algorithm');

  const { keys } = await getJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AuthError('unknown signing key');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new AuthError('bad signature');

  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new AuthError('wrong issuer');
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new AuthError('wrong audience');
  if (!(payload.exp > Date.now() / 1000)) throw new AuthError('token expired');
  if (payload.email_verified !== true || !payload.email) throw new AuthError('email not verified');
  return { email: String(payload.email).toLowerCase(), name: payload.name ?? payload.email };
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signSession(user, secret, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const head = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(
    JSON.stringify({ email: user.email, name: user.name, role: user.role, iat, exp: iat + SESSION_LIFE_SECONDS }),
  );
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64urlEncode(sig)}`;
}

export async function verifySession(token, secret, now = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const payload = parseJson(b64urlDecode(parts[1]));
    if (!(payload.exp > now / 1000)) return null;
    return { email: payload.email, name: payload.name, role: payload.role };
  } catch {
    return null;
  }
}

const unauthorised = () =>
  new Response(JSON.stringify({ error: 'unauthorised' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function requireUser(request, env) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  const session = match ? await verifySession(match[1], env.SESSION_SECRET) : null;
  if (!session) throw unauthorised();
  // Sessions are stateless, so the allow-list is checked on every request: removing someone takes effect at once.
  const row = await env.DB.prepare('SELECT name, role, active FROM users WHERE lower(email) = lower(?)')
    .bind(session.email)
    .first();
  if (!row || !row.active) throw unauthorised();
  return { email: session.email, name: row.name ?? session.name, role: row.role };
}
