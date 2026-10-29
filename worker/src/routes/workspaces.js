// Workspace management: the operator's approval screen, and loading the sample events into the caller's workspace.
import { error, json, readJson } from '../http.js';
import { remember } from '../memory.js';
import { loadSamples } from '../samples.js';

// A thrown Response is turned into the reply by the handler, like readJson's.
function requireOperator(user) {
  if (!user.operator) throw error(403, 'only the operator can do this');
}

const WORKSPACES_SQL = `
  SELECT w.id, w.name, w.status, w.shared_keys, w.created_at, w.approved_at,
    (SELECT email FROM users WHERE workspace_id = w.id AND role = 'admin' ORDER BY rowid LIMIT 1) AS owner_email,
    EXISTS (SELECT 1 FROM events WHERE workspace_id = w.id) AS has_data
  FROM workspaces w`;

const toWorkspace = (r) => ({
  id: r.id, name: r.name, status: r.status, sharedKeys: Boolean(r.shared_keys), ownerEmail: r.owner_email,
  createdAt: r.created_at, approvedAt: r.approved_at, hasData: Boolean(r.has_data),
});

const readWorkspace = async (env, id) => {
  const r = await env.DB.prepare(`${WORKSPACES_SQL} WHERE w.id = ?`).bind(id).first();
  return r ? toWorkspace(r) : null;
};

// Waiting requests first, then the newest.
export async function listWorkspaces({ env, user }) {
  requireOperator(user);
  const { results } = await env.DB.prepare(`${WORKSPACES_SQL} ORDER BY (w.status = 'pending') DESC, w.created_at DESC, w.id DESC`).all();
  return json(results.map(toWorkspace));
}

export async function approveWorkspace({ env, user, params }) {
  requireOperator(user);
  const id = Number(params[0]);
  const result = await env.DB.prepare("UPDATE workspaces SET status = 'active', approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP) WHERE id = ?").bind(id).run();
  if (result.meta.changes !== 1) return error(404, 'workspace not found');
  return json(await readWorkspace(env, id));
}

export async function suspendWorkspace({ env, user, params }) {
  requireOperator(user);
  const id = Number(params[0]);
  if (id === user.workspaceId) return error(409, 'an operator cannot suspend their own workspace');
  const result = await env.DB.prepare("UPDATE workspaces SET status = 'suspended' WHERE id = ?").bind(id).run();
  if (result.meta.changes !== 1) return error(404, 'workspace not found');
  return json(await readWorkspace(env, id));
}

export async function setSharedKeys({ request, env, user, params }) {
  requireOperator(user);
  const { on } = await readJson(request);
  if (typeof on !== 'boolean') return error(400, 'on must be true or false');
  const id = Number(params[0]);
  const result = await env.DB.prepare('UPDATE workspaces SET shared_keys = ? WHERE id = ?').bind(on ? 1 : 0, id).run();
  if (result.meta.changes !== 1) return error(404, 'workspace not found');
  return json(await readWorkspace(env, id));
}

export async function loadSamplesRoute({ env, user }) {
  if (user.role !== 'admin') return error(403, 'only an admin can load the sample events');
  const result = await loadSamples(env.DB, user.workspaceId);
  if (result.added > 0) await remember(env.DB, user.workspaceId, [{ actor: user.email, kind: 'samples.loaded', detail: { count: result.added } }]);
  return json(result);
}
