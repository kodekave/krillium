// Logic behind the Find events screen that needs no DOM: grouping results, progress wording, and stepping a run.

// A plain sentence for every reason an event can be filtered out.
export const FILTER_LABELS = {
  past: 'The event has already happened.',
  cancelled: 'The event is cancelled.',
  online_only: 'The event is online only.',
  entertainment: 'It looks like entertainment, not a business event.',
  no_date: 'The page gives no exact start date.',
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
