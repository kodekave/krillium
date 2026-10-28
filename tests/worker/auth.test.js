import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import {
  AuthError,
  verifyGoogleIdToken,
  signSession,
  verifySession,
  requireUser,
} from '../../worker/src/auth.js';
import { b64url, makeKeyPair, makeIdToken } from './helpers.js';

const b64 = b64url;

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
    const forged = `${h}.${b64(JSON.stringify({ ...user, role: 'admin', exp: 9999999999 }))}.${s}`;
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
