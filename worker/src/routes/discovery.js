// Event discovery routes: search runs, the review inbox, undo, and the budget settings.
import { MAX_SECTORS, interleaveTopics } from '../../../site/js/shared/sectors.js';
import { error, json, readJson } from '../http.js';
import { diffSettings, remember } from '../memory.js';
import { missingSecrets } from '../discovery/deps.js';
import { ModelError } from '../discovery/model.js';
import { SourceError } from '../discovery/plan.js';
import { cancelRun, getRun, startRun, stepRun } from '../discovery/run.js';
import { SettingsError, getSettings, putSettings } from '../discovery/settings.js';
import { DiscoveryError, approveCandidate, listInbox, rejectCandidate, undoAutoAdd } from '../discovery/store.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

  // The sectors to search: every switched-on sector unless the page picks some. They keep the order of the settings, and
  // the topics come from them one at a time so each sector is reached even when the search has room for only a few.
  const enabled = settings.sectors.filter((s) => s.enabled);
  let chosen = enabled;
  if (body.sectors !== undefined) {
    const ids = Array.isArray(body.sectors) && body.sectors.length <= MAX_SECTORS && body.sectors.every((id) => typeof id === 'string') ? new Set(body.sectors) : null;
    if (!ids) errors.push('sectors must be a list of sector ids');
    else if ([...ids].some((id) => !enabled.some((s) => s.id === id))) errors.push('sectors must be sectors that are switched on');
    else chosen = enabled.filter((s) => ids.has(s.id));
  }
  return errors.length
    ? { errors }
    : { query: { query, from, to, ...(region ? { region } : {}), topics: interleaveTopics(chosen), sectors: chosen.map((s) => s.id) } };
}

const notSetUp = (deps) => {
  const missing = missingSecrets(deps);
  return missing.length ? error(503, 'discovery is not set up', { missing }) : null;
};

export const startSearch = guarded(async ({ request, env, deps, user }) => {
  const unavailable = notSetUp(deps);
  if (unavailable) return unavailable;
  const settings = await getSettings(env.DB, user.workspaceId);
  const parsed = parseQuery(await readJson(request), settings);
  if (parsed.errors) return error(400, 'invalid search', { errors: parsed.errors });
  const run = await startRun(env.DB, user.workspaceId, user.email, parsed.query, settings, Date.now());
  return json(await getRun(env.DB, user.workspaceId, run.id), 201);
});

export const getSearch = guarded(async ({ env, params, user }) => {
  const result = await getRun(env.DB, user.workspaceId, Number(params[0]));
  return result ? json(result) : error(404, 'search not found');
});

export const stepSearch = guarded(async ({ env, params, deps, user }) => {
  const unavailable = notSetUp(deps);
  if (unavailable) return unavailable;
  const settings = await getSettings(env.DB, user.workspaceId);
  const result = await stepRun({ db: env.DB, workspaceId: user.workspaceId, runId: Number(params[0]), deps, settings, now: Date.now() });
  return result ? json(result) : error(404, 'search not found');
});

// Stopping needs no keys: it only ends the run, so it works even if a secret has since been removed.
export const cancelSearch = guarded(async ({ env, params, user }) => {
  const result = await cancelRun(env.DB, user.workspaceId, Number(params[0]), user.email, user.role, Date.now());
  return result ? json(result) : error(404, 'search not found');
});

export const inbox = guarded(async ({ env, user }) => json(await listInbox(env.DB, user.workspaceId, Date.now())));

// Each decision is remembered with the facts the store returns; the response bodies are unchanged.
export const approveInbox = guarded(async ({ env, params, user }) => {
  const id = Number(params[0]);
  const { eventId, facts } = await approveCandidate(env.DB, user.workspaceId, id, user.email, Date.now());
  await remember(env.DB, user.workspaceId, [{ actor: user.email, kind: 'candidate.approved', subject: id, detail: facts }]);
  return json({ eventId });
});

export const rejectInbox = guarded(async ({ env, params, user }) => {
  const id = Number(params[0]);
  const facts = await rejectCandidate(env.DB, user.workspaceId, id, user.email, Date.now());
  await remember(env.DB, user.workspaceId, [{ actor: user.email, kind: 'candidate.rejected', subject: id, detail: facts }]);
  return json({});
});

export const undoAutoAddRoute = guarded(async ({ env, params, user }) => {
  const eventId = decodeURIComponent(params[0]);
  const facts = await undoAutoAdd(env.DB, user.workspaceId, eventId, user.email, Date.now());
  await remember(env.DB, user.workspaceId, [{ actor: user.email, kind: 'autoadd.undone', subject: eventId, detail: facts }]);
  return json({});
});

// The missing list lets the page say "not set up" before anyone runs a search, and the reader says who reads the pages:
// Exa alone, or Claude once an Anthropic key is set. sharedKeys says whether this workspace may use the Worker's own
// keys at all (the page words the "not set up" notice differently when it may not). None of these is a saved setting.
export const getDiscoverySettings = guarded(async ({ env, deps, user }) =>
  json({
    ...(await getSettings(env.DB, user.workspaceId)),
    missing: missingSecrets(deps), reader: deps.model ? 'claude' : 'exa', sharedKeys: user.sharedKeys,
  }));

export const putDiscoverySettings = guarded(async ({ request, env, user }) => {
  if (user.role !== 'admin') return error(403, 'only an admin can change discovery settings');
  const patch = await readJson(request);
  const before = await getSettings(env.DB, user.workspaceId);
  const after = await putSettings(env.DB, user.workspaceId, patch);
  const change = diffSettings(before, after);
  if (change) await remember(env.DB, user.workspaceId, [{ actor: user.email, kind: 'sectors.saved', detail: change }]);
  return json(after);
});
