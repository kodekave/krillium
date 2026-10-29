import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHandler } from '../../worker/src/index.js';
import { addEvent, addUser, addWorkspace, call, resetData, tokenFor } from './helpers.js';

let handler;
let operator;
let member;

const asOperator = (path, opts = {}) => call(handler, path, { token: operator, ...opts });
const row = (id) => env.DB.prepare('SELECT status, shared_keys, approved_at FROM workspaces WHERE id = ?').bind(id).first();

beforeEach(async () => {
  await resetData();
  handler = createHandler();
  await addUser({ email: 'op@example.test', role: 'admin', operator: 1 });
  await addUser({ email: 'member@example.test' });
  operator = await tokenFor({ email: 'op@example.test', role: 'admin' });
  member = await tokenFor({ email: 'member@example.test' });
});

describe('operator routes', () => {
  it('lists workspaces with owner email, status, shared keys and whether they hold data, pending first', async () => {
    const pending = await addWorkspace({ name: 'Waiting team', status: 'pending' });
    await addUser({ email: 'p@example.test', role: 'admin', workspaceId: pending });
    const active = await addWorkspace({ name: 'Busy team', status: 'active', shared_keys: 1 });
    await addUser({ email: 'a@example.test', role: 'admin', workspaceId: active });
    await addEvent({ id: 'busy-1', workspaceId: active });

    const res = await asOperator('/api/operator/workspaces');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data[0]).toMatchObject({ id: pending, name: 'Waiting team', status: 'pending', ownerEmail: 'p@example.test', sharedKeys: false, hasData: false });
    expect(data.find((w) => w.id === active)).toMatchObject({ status: 'active', ownerEmail: 'a@example.test', sharedKeys: true, hasData: true });
    expect(data.find((w) => w.id === 1)).toMatchObject({ name: 'Main workspace', status: 'active', sharedKeys: true });
    expect(data.find((w) => w.id === pending).createdAt).toBeTruthy();
  });

  it('refuses every operator route to a non-operator with 403', async () => {
    const other = await addWorkspace({ status: 'pending' });
    const tries = [
      call(handler, '/api/operator/workspaces', { token: member }),
      call(handler, `/api/operator/workspaces/${other}/approve`, { method: 'POST', token: member }),
      call(handler, `/api/operator/workspaces/${other}/suspend`, { method: 'POST', token: member }),
      call(handler, `/api/operator/workspaces/${other}/shared-keys`, { method: 'PUT', token: member, body: { on: true } }),
    ];
    for (const res of await Promise.all(tries)) expect(res.status).toBe(403);
    expect((await row(other)).status).toBe('pending');
  });

  it('approves a pending workspace: status active and approved_at set; 404 for an unknown id', async () => {
    const pending = await addWorkspace({ status: 'pending' });
    const res = await asOperator(`/api/operator/workspaces/${pending}/approve`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: pending, status: 'active' });
    const after = await row(pending);
    expect(after.status).toBe('active');
    expect(after.approved_at).toBeTruthy();
    expect((await asOperator('/api/operator/workspaces/9999/approve', { method: 'POST' })).status).toBe(404);
  });

  it('suspends an active or pending workspace', async () => {
    const active = await addWorkspace({ status: 'active' });
    const pending = await addWorkspace({ status: 'pending' });
    for (const id of [active, pending]) {
      expect((await asOperator(`/api/operator/workspaces/${id}/suspend`, { method: 'POST' })).status).toBe(200);
      expect((await row(id)).status).toBe('suspended');
    }
    expect((await asOperator('/api/operator/workspaces/9999/suspend', { method: 'POST' })).status).toBe(404);
  });

  it("refuses to suspend the operator's own workspace with 409", async () => {
    const res = await asOperator('/api/operator/workspaces/1/suspend', { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await row(1)).status).toBe('active');
  });

  it('switches shared keys on and off, and rejects a non-boolean with 400', async () => {
    const id = await addWorkspace({ status: 'active', shared_keys: 0 });
    const put = (body) => asOperator(`/api/operator/workspaces/${id}/shared-keys`, { method: 'PUT', body });
    expect((await put({ on: true })).status).toBe(200);
    expect((await row(id)).shared_keys).toBe(1);
    expect((await put({ on: false })).status).toBe(200);
    expect((await row(id)).shared_keys).toBe(0);
    expect((await put({ on: 'yes' })).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await asOperator('/api/operator/workspaces/9999/shared-keys', { method: 'PUT', body: { on: true } })).status).toBe(404);
  });
});
