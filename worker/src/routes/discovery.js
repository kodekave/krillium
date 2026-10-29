// Event discovery routes: search runs, the review inbox, undo, and the budget settings.
import { error, json, readJson } from '../http.js';
import { missingSecrets } from '../discovery/deps.js';
import { ModelError } from '../discovery/model.js';
import { SourceError } from '../discovery/plan.js';
import { getRun, startRun, stepRun } from '../discovery/run.js';
import { SettingsError, getSettings, putSettings } from '../discovery/settings.js';
import { DiscoveryError, approveCandidate, listInbox, rejectCandidate, undoAutoAdd } from '../discovery/store.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TOPICS = 8;

function validDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Domain errors become their own status. An upstream error is never passed on as-is: a 401 from a search or
// model provider would look like an expired session to the page and sign the user out.
const guarded = (handler) => async (context) => {
  try {
    return await handler(context);
  } catch (e) {
    if (e instanceof DiscoveryError) return error(e.status, e.message);
    if (e instanceof SettingsError) return error(400, 'invalid settings', { errors: e.errors });
    if (e instanceof SourceError || e instanceof ModelError) return error(502, e.message);
    throw e;
  }
};

function parseQuery(body, settings) {
  const errors = [];
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query.length < 2 || query.length > 200) errors.push('query must be 2 to 200 characters');

  const today = new Date();
  const yearAhead = new Date(today);
  yearAhead.setUTCFullYear(today.getUTCFullYear() + 1);
  const from = body.from ?? today.toISOString().slice(0, 10);
  const to = body.to ?? yearAhead.toISOString().slice(0, 10);
  if (!validDate(from) || !validDate(to)) errors.push('from and to must be dates like 2027-03-08');
  else if (from > to) errors.push('from must not be after to');

  const region = body.region === undefined || body.region === null ? undefined : String(body.region).trim();
  if (region !== undefined && region.length > 60) errors.push('region must be at most 60 characters');

  let topics = settings.topics;
  if (body.topics !== undefined) {
    const list = Array.isArray(body.topics) ? body.topics.map((t) => (typeof t === 'string' ? t.trim() : null)) : null;
    if (!list || list.length > MAX_TOPICS || list.some((t) => !t || t.length > 60)) errors.push('topics must be at most 8 phrases of 1 to 60 characters');
    else topics = list;
  }
  return errors.length ? { errors } : { query: { query, from, to, ...(region ? { region } : {}), topics } };
}

const notSetUp = (deps) => {
  const missing = missingSecrets(deps);
  return missing.length ? error(503, 'discovery is not set up', { missing }) : null;
};

export const startSearch = guarded(async ({ request, env, deps, user }) => {
  const unavailable = notSetUp(deps);
  if (unavailable) return unavailable;
  const settings = await getSettings(env.DB);
  const parsed = parseQuery(await readJson(request), settings);
  if (parsed.errors) return error(400, 'invalid search', { errors: parsed.errors });
  const run = await startRun(env.DB, user.email, parsed.query, settings, Date.now());
  return json(await getRun(env.DB, run.id), 201);
});

export const getSearch = guarded(async ({ env, params }) => {
  const result = await getRun(env.DB, Number(params[0]));
  return result ? json(result) : error(404, 'search not found');
});

export const stepSearch = guarded(async ({ env, params, deps }) => {
  const unavailable = notSetUp(deps);
  if (unavailable) return unavailable;
  const result = await stepRun({ db: env.DB, runId: Number(params[0]), deps, settings: await getSettings(env.DB), now: Date.now() });
  return result ? json(result) : error(404, 'search not found');
});

export const inbox = guarded(async ({ env }) => json(await listInbox(env.DB, Date.now())));

export const approveInbox = guarded(async ({ env, params, user }) =>
  json(await approveCandidate(env.DB, Number(params[0]), user.email, Date.now())));

export const rejectInbox = guarded(async ({ env, params, user }) => {
  await rejectCandidate(env.DB, Number(params[0]), user.email, Date.now());
  return json({});
});

export const undoAutoAddRoute = guarded(async ({ env, params, user }) => {
  await undoAutoAdd(env.DB, decodeURIComponent(params[0]), user.email, Date.now());
  return json({});
});

// The missing list lets the page say "not set up" before anyone runs a search. It is not a setting and is not saved.
export const getDiscoverySettings = guarded(async ({ env, deps }) => json({ ...(await getSettings(env.DB)), missing: missingSecrets(deps) }));

export const putDiscoverySettings = guarded(async ({ request, env, user }) => {
  if (user.role !== 'admin') return error(403, 'only an admin can change discovery settings');
  return json(await putSettings(env.DB, await readJson(request)));
});
