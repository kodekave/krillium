#!/usr/bin/env node
// Prints a dev session token signed with the SESSION_SECRET in .dev.vars, for browser checks without Google.
// Usage: node scripts/dev-token.mjs --email dev@example.test
import { readFileSync } from 'node:fs';
import { signSession } from '../worker/src/auth.js';

const email = process.argv[process.argv.indexOf('--email') + 1] ?? 'dev@example.test';
const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
if (!vars.SESSION_SECRET) throw new Error('SESSION_SECRET missing from .dev.vars');
const token = await signSession({ email, name: 'Dev User', role: 'admin' }, vars.SESSION_SECRET);
console.log(JSON.stringify({ token, user: { email, name: 'Dev User', role: 'admin' } }));
