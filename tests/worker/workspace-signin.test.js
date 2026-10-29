import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { requireUser, signSession } from '../../worker/src/auth.js';
import { createHandler } from '../../worker/src/index.js';
import { addUser, addWorkspace, call, makeIdToken, makeKeyPair, resetData } from './helpers.js';

let handler;
let keys;

const signIn = async (email, name = 'Some Person') => {
  const idToken = await makeIdToken(keys, { email, name });
  return call(handler, '/auth/google', { method: 'POST', body: { idToken } });
};
const count = async (sql, ...values) => (await env.DB.prepare(sql).bind(...values).first()).n;
const tokenOf = (email, role = 'member') => signSession({ email, name: 'X', role }, env.SESSION_SECRET);
const radarStatus = async (email) => (await call(handler, '/api/radar', { token: await tokenOf(email) })).status;

beforeEach(async () => {
  await resetData();
  keys = await makeKeyPair('k1');
  handler = createHandler({ getJwks: async () => keys.jwks });
});

describe('sign-in with workspaces', () => {
  it('signs in an active user of an active workspace with token, workspace and operator flag', async () => {
    await addUser({ email: 'op@example.test', name: 'Op', role: 'admin', operator: 1 });
    const res = await signIn('op@example.test');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(typeof data.token).toBe('string');
    expect(data.user).toEqual({ email: 'op@example.test', name: 'Op', role: 'admin' });
    expect(data.workspace).toEqual({ id: 1, name: 'Main workspace' });
    expect(data.operator).toBe(true);
  });

  it('reports the operator flag as false for an ordinary user', async () => {
    await addUser({ email: 'plain@example.test' });
    const { data } = await (await signIn('plain@example.test')).json();
    expect(data.operator).toBe(false);
  });

  it('answers 202 pending with no token when the workspace is pending', async () => {
    const ws = await addWorkspace({ status: 'pending' });
    await addUser({ email: 'wait@example.test', workspaceId: ws });
    const res = await signIn('wait@example.test');
    expect(res.status).toBe(202);
    const { data } = await res.json();
    expect(data).toEqual({ status: 'pending' });
  });

  it('answers 403 when the workspace is suspended', async () => {
    const ws = await addWorkspace({ status: 'suspended' });
    await addUser({ email: 'off@example.test', workspaceId: ws });
    expect((await signIn('off@example.test')).status).toBe(403);
  });

  it('answers 403 for an inactive user', async () => {
    await addUser({ email: 'gone@example.test', active: 0 });
    expect((await signIn('gone@example.test')).status).toBe(403);
  });

  it('answers 403 for a user with no workspace', async () => {
    await addUser({ email: 'lost@example.test', workspaceId: null });
    expect((await signIn('lost@example.test')).status).toBe(403);
  });

  it('creates a pending workspace named after the person and an admin user for an unknown verified email, and answers 202', async () => {
    const res = await signIn('new@example.test', 'Priya Shah');
    expect(res.status).toBe(202);
    expect((await res.json()).data).toEqual({ status: 'pending' });
    const user = await env.DB.prepare('SELECT role, active, operator, workspace_id FROM users WHERE email = ?').bind('new@example.test').first();
    expect(user).toMatchObject({ role: 'admin', active: 1, operator: 0 });
    const ws = await env.DB.prepare('SELECT name, status, shared_keys FROM workspaces WHERE id = ?').bind(user.workspace_id).first();
    expect(ws).toEqual({ name: "Priya Shah's workspace", status: 'pending', shared_keys: 0 });
  });

  it('creates nothing new when the same unknown email signs in again', async () => {
    await signIn('new@example.test', 'Priya Shah');
    const before = [await count('SELECT COUNT(*) AS n FROM workspaces'), await count('SELECT COUNT(*) AS n FROM users')];
    expect((await signIn('new@example.test', 'Priya Shah')).status).toBe(202);
    expect([await count('SELECT COUNT(*) AS n FROM workspaces'), await count('SELECT COUNT(*) AS n FROM users')]).toEqual(before);
  });

  it('answers 503 and creates nothing when 50 workspaces are already pending', async () => {
    for (let i = 0; i < 50; i += 1) await addWorkspace({ status: 'pending', name: `Waiting ${i}` });
    const before = await count('SELECT COUNT(*) AS n FROM workspaces');
    const res = await signIn('late@example.test', 'Late Person');
    expect(res.status).toBe(503);
    expect(await count('SELECT COUNT(*) AS n FROM workspaces')).toBe(before);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE email = 'late@example.test'")).toBe(0);
  });

  it('still lets an existing user in when 50 workspaces are pending', async () => {
    for (let i = 0; i < 50; i += 1) await addWorkspace({ status: 'pending', name: `Waiting ${i}` });
    await addUser({ email: 'old@example.test' });
    expect((await signIn('old@example.test')).status).toBe(200);
  });
});

describe('requireUser with workspaces', () => {
  const thrownStatus = async (email) => {
    const request = new Request('https://api.test/api/radar', { headers: { authorization: `Bearer ${await tokenOf(email)}` } });
    try {
      await requireUser(request, env);
      return 200;
    } catch (e) {
      return e.status;
    }
  };

  it('returns the workspace, the shared-keys flag and the operator flag', async () => {
    const ws = await addWorkspace({ name: 'Acme team', shared_keys: 1 });
    await addUser({ email: 'a@example.test', workspaceId: ws, operator: 1 });
    const request = new Request('https://api.test/api/radar', { headers: { authorization: `Bearer ${await tokenOf('a@example.test')}` } });
    expect(await requireUser(request, env)).toMatchObject({
      email: 'a@example.test', operator: true, workspaceId: ws, workspaceName: 'Acme team', sharedKeys: true,
    });
  });

  it('refuses an existing token on the next request once its workspace is suspended', async () => {
    await addUser({ email: 'a@example.test' });
    expect(await radarStatus('a@example.test')).toBe(200);
    await env.DB.prepare("UPDATE workspaces SET status = 'suspended' WHERE id = 1").run();
    expect(await radarStatus('a@example.test')).toBe(401);
  });

  it('refuses a token whose workspace is pending', async () => {
    const ws = await addWorkspace({ status: 'pending' });
    await addUser({ email: 'wait@example.test', workspaceId: ws });
    expect(await thrownStatus('wait@example.test')).toBe(401);
  });

  it('refuses a user with no workspace', async () => {
    await addUser({ email: 'lost@example.test', workspaceId: null });
    expect(await thrownStatus('lost@example.test')).toBe(401);
  });
});
