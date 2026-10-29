// Logic behind the Find events screen that needs no DOM: grouping results, progress wording, and stepping a run.

// A plain sentence for every reason an event can be filtered out.
export const FILTER_LABELS = {
  past: 'The event has already happened.',
  cancelled: 'The event is cancelled.',
  online_only: 'The event is online only.',
  entertainment: 'It looks like entertainment, not a business event.',
  no_date: 'The page gives no exact start date.',
  outside_dates: 'The event is outside the dates you chose.',
  rejected: 'Your team rejected this event before.',
  unverified: 'The page text did not confirm the name or dates.',
};

const MATCHES = new Set(['auto_added', 'inbox', 'tracked']);

export function groupItems(items = []) {
  const pick = (outcome) => items.filter((i) => i.outcome === outcome);
  return { added: pick('auto_added'), review: pick('inbox'), tracked: pick('tracked'), filtered: pick('filtered') };
}

export function progressText(run, items) {
  const pages = run.pages ?? 0;
  const read = `${pages} ${pages === 1 ? 'page' : 'pages'} read`;
  if (!items) return read;
  const matches = items.filter((i) => MATCHES.has(i.outcome)).length;
  return `${read}, ${matches} ${matches === 1 ? 'match' : 'matches'}`;
}

// The same event can be reported by several runs; shown together it appears once, with its latest outcome.
function itemKey(item) {
  if (item.candidateId) return `c:${item.candidateId}`;
  if (item.outcome === 'tracked') return `e:${item.eventId}`;
  return `f:${item.reason}:${item.name ?? item.url}:${item.startDate}`;
}

export function mergeItems(...lists) {
  const byKey = new Map();
  for (const list of lists) for (const item of list ?? []) byKey.set(itemKey(item), item);
  return [...byKey.values()];
}

// The words a Fill the map search uses for a sector.
export const fillQuery = (sector) => `${sector.name} conferences and trade shows`;

// What Find events says when search is not set up. A workspace that may not use the Worker's own keys (the operator
// switches that on per workspace) is told it needs its own; an older Worker that does not say is treated as sharing.
export function keysNotice({ missing = [], sharedKeys = true, admin = true } = {}) {
  if (!missing.length) return null;
  if (sharedKeys === false) {
    return 'Search needs an Exa key for this workspace. Per-workspace keys arrive in the next update; the operator can switch on the shared key meanwhile.';
  }
  return admin
    ? `Add ${missing.join(' and ')} to the Worker as a secret, then reload this page. An Anthropic key is optional: with it, Claude reads the pages instead of Exa. DEPLOY.md has the steps.`
    : 'An admin needs to finish setting up search.';
}

// Fill the map: one search per sector, in turn, so each sector gets the whole search budget. Each run goes to its end
// before the next starts, because a person may have only one search running. It stops at the first run that does not
// finish normally (a budget cap, a pause, a failure) or search that cannot start, and says why; what finished before is
// kept in `done`. An aborted fill hands back the run it was in the middle of, so the page can end it on the server.
export async function driveFill({ api, sectors, from, to, region, onSector = () => {}, onUpdate = () => {}, signal }) {
  const done = [];
  for (const [index, sector] of sectors.entries()) {
    if (signal?.aborted) return { ok: true, stopped: true, done };
    onSector({ sector, index, total: sectors.length });
    const started = await api.post('/api/search', { query: fillQuery(sector), from, to, ...(region ? { region } : {}), sectors: [sector.id] });
    if (!started.ok) {
      if (started.stale) return { ok: false, error: 'Cannot reach the service. Check your connection and try again.', done };
      return { ok: false, status: started.status, error: started.error ?? 'The search could not start.', errors: started.errors, missing: started.missing, done };
    }
    const result = await driveRun({ api, runId: started.data.run.id, onUpdate: (data) => onUpdate({ sector, index, ...data }), signal });
    if (!result.ok) return { ...result, done };
    if (result.stopped) return { ok: true, stopped: true, run: result.run, done };
    if (result.run.status !== 'done') return { ok: true, ended: result.run.status, run: result.run, done };
    done.push({ sector, run: result.run });
  }
  return { ok: true, done };
}

// Calls the step route until the run stops running. Stops early, without an error, when the signal is aborted.
export async function driveRun({ api, runId, onUpdate = () => {}, signal }) {
  let last = null;
  for (;;) {
    if (signal?.aborted) return { ok: true, stopped: true, ...(last ? { run: last } : {}) };
    const response = await api.post(`/api/search/${runId}/step`, {});
    if (!response.ok) {
      if (response.stale) return { ok: false, error: 'Cannot reach the service. Check your connection and try again.' };
      return { ok: false, status: response.status, error: response.error ?? 'The search could not continue.' };
    }
    last = response.data.run;
    onUpdate(response.data);
    if (last.status !== 'running') return { ok: true, run: last };
  }
}
