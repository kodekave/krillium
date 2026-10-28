import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  AuthError,
  verifyGoogleIdToken,
  signSession,
  verifySession,
  requireUser,
} from '../../worker/src/auth.js';

const enc = new TextEncoder();
const b64url = (input) => {
  const bytes = typeof input === 'string' ? enc.encode(input) : new Uint8Array(input);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateKey: pair.privateKey, jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }, kid };
}

async function makeIdToken({ privateKey, kid }, overrides = {}) {
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

describe('verifyGoogleIdToken', () => {
  it('returns the email and name for a valid token', async () => {
    const keys = await makeKeyPair('k1');
    const token = await makeIdToken(keys);
    const user = await verifyGoogleIdToken(token, env, async () => keys.jwks);
    expect(user).toEqual({ email: 'member@example.test', name: 'Team Member' });
  });

  it('rejects an expired token', async () => {
    const keys = await makeKeyPair('k1');
    const token = await makeIdToken(keys, { exp: Math.floor(Date.now() / 1000) - 10 });
    await expect(verifyGoogleIdToken(token, env, async () => keys.jwks)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token for another audience', async () => {
    const keys = await makeKeyPair('k1');
    const token = await makeIdToken(keys, { aud: 'someone-else.apps.googleusercontent.com' });
    await expect(verifyGoogleIdToken(token, env, async () => keys.jwks)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an unverified email', async () => {
    const keys = await makeKeyPair('k1');
    const token = await makeIdToken(keys, { email_verified: false });
    await expect(verifyGoogleIdToken(token, env, async () => keys.jwks)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token signed by a different key', async () => {
    const real = await makeKeyPair('k1');
    const attacker = await makeKeyPair('k1');
    const token = await makeIdToken(attacker);
    await expect(verifyGoogleIdToken(token, env, async () => real.jwks)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token from another issuer', async () => {
    const keys = await makeKeyPair('k1');
    const token = await makeIdToken(keys, { iss: 'https://evil.example.test' });
    await expect(verifyGoogleIdToken(token, env, async () => keys.jwks)).rejects.toBeInstanceOf(AuthError);
  });
});

describe('sessions', () => {
  const secret = 'unit-test-secret';
  const user = { email: 'member@example.test', name: 'Team Member', role: 'member' };

  it('round-trips a signed session', async () => {
    const token = await signSession(user, secret);
    expect(await verifySession(token, secret)).toMatchObject(user);
  });

  it('returns null for a tampered token', async () => {
    const token = await signSession(user, secret);
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ ...user, role: 'admin', exp: 9999999999 }))}.${s}`;
    expect(await verifySession(forged, secret)).toBeNull();
  });

  it('returns null for a token signed with another secret', async () => {
    const token = await signSession(user, 'other-secret');
    expect(await verifySession(token, secret)).toBeNull();
  });

  it('returns null once the 8 hour life has passed', async () => {
    const issuedAt = Date.now() - (8 * 3600 + 1) * 1000;
    const token = await signSession(user, secret, issuedAt);
    expect(await verifySession(token, secret)).toBeNull();
  });

  it('is still valid just inside the 8 hour life', async () => {
    const issuedAt = Date.now() - (8 * 3600 - 60) * 1000;
    const token = await signSession(user, secret, issuedAt);
    expect(await verifySession(token, secret)).not.toBeNull();
  });
});

describe('requireUser', () => {
  const thrown = async (request) => {
    try {
      await requireUser(request, env);
    } catch (e) {
      return e;
    }
    return null;
  };

  it('throws a 401 response when there is no Authorization header', async () => {
    const err = await thrown(new Request('https://api.test/api/radar'));
    expect(err).toBeInstanceOf(Response);
    expect(err.status).toBe(401);
  });

  it('throws a 401 response for a malformed bearer token', async () => {
    const err = await thrown(new Request('https://api.test/api/radar', { headers: { authorization: 'Bearer nonsense' } }));
    expect(err.status).toBe(401);
  });

  it('returns the user for a valid session token', async () => {
    const token = await signSession({ email: 'member@example.test', name: 'Team Member', role: 'member' }, env.SESSION_SECRET);
    const user = await requireUser(new Request('https://api.test/api/radar', { headers: { authorization: `Bearer ${token}` } }), env);
    expect(user.email).toBe('member@example.test');
  });
});
