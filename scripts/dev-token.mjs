#!/usr/bin/env node
// Prints a dev session token signed with the SESSION_SECRET in .dev.vars, for browser checks without Google.
// Usage: node scripts/dev-token.mjs --email dev@example.test [--workspace 1] [--operator]
// The Worker looks the person up on every request, so --workspace and --operator only set what the page shows; which
// workspace someone really belongs to, and whether they are the operator, comes from the users table (see dev-seed.mjs).
import { readFileSync } from 'node:fs';
import { signSession } from '../worker/src/auth.js';

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const email = flag('email') ?? 'dev@example.test';
const workspaceId = Number(flag('workspace') ?? 1);
if (!Number.isInteger(workspaceId) || workspaceId < 1) throw new Error('--workspace must be a positive whole number');
const operator = process.argv.includes('--operator');
const workspaceName = { 1: 'Main workspace', 2: 'Second workspace' }[workspaceId] ?? `Workspace ${workspaceId}`;
const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
if (!vars.SESSION_SECRET) throw new Error('SESSION_SECRET missing from .dev.vars');
const token = await signSession({ email, name: 'Dev User', role: 'admin' }, vars.SESSION_SECRET);
console.log(JSON.stringify({ token, user: { email, name: 'Dev User', role: 'admin' }, workspace: { id: workspaceId, name: workspaceName }, operator }));
