// Find events: search the web and open event lists, then review what was found. Two tabs, Search and Inbox.
import { h, safeUrl } from '../dom.js';
import { emptyState } from '../empty-state.js';
import { FILTER_LABELS, driveFill, driveRun, groupItems, keysNotice, mergeItems, progressText } from '../find-state.js';
import { formatRange } from '../format.js';

const today = () => new Date().toISOString().slice(0, 10);
const yearAhead = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
};
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return String(u ?? '');
  }
};
const where = (e) => [e.city, e.startDate ? formatRange(e.startDate, e.endDate ?? null) : null].filter(Boolean).join(', ');

const SETTING_FIELDS = [
  ['runCapUsd', 'Spend cap per search (USD)', 0.1],
  ['dayCapUsd', 'Spend cap per day (USD)', 0.5],
  ['maxSearches', 'Searches per run', 1],
  ['maxPages', 'Pages per run', 10],
  ['priceInPerMtok', 'Claude price in (USD per million tokens)', 0.1],
  ['priceOutPerMtok', 'Claude price out (USD per million tokens)', 0.1],
];

// The grouped results of a run. Exported so the page can be checked with sample data.
export function renderResults(items, { openEvent, undo, goToInbox }) {
  const { added, review, tracked, filtered } = groupItems(items);
  const link = (item) => (item.eventId
    ? h('button', { type: 'button', class: 'link-btn', onclick: () => openEvent(item.eventId) }, item.name)
    : h('strong', {}, item.name));
  const group = (title, rows, after = null) => (rows.length
    ? h('section', { class: 'find-group' }, h('h2', {}, `${title} (${rows.length})`), h('ul', { class: 'feed-list' }, rows), after)
    : null);

  const addedRows = added.map((item) => {
    const note = h('span', { class: 'muted small', role: 'status' });
    const undoBtn = h('button', { type: 'button', class: 'btn', onclick: async () => {
      undoBtn.disabled = true;
      note.textContent = await undo(item);
    } }, 'Undo');
    return h('li', {}, h('span', { class: 'feed-body' }, link(item), h('span', { class: 'muted small' }, where(item)),
      h('span', { class: 'muted small' }, `Listed on ${item.domains.join(', ')}`), note), undoBtn);
  });
  const reviewRows = review.map((item) => h('li', {}, h('span', { class: 'feed-body' }, h('strong', {}, item.name),
    h('span', { class: 'muted small' }, where(item))), h('span', { class: 'pill pill-watch' }, item.reason ?? 'Needs a look')));
  const trackedRows = tracked.map((item) => h('li', {}, h('span', { class: 'feed-body' }, link(item), h('span', { class: 'muted small' }, where(item)),
    h('span', { class: 'muted small' }, `Also listed on ${item.domains.join(', ')}`))));
  const filteredRows = filtered.map((item) => h('li', {}, h('span', { class: 'feed-body' }, h('strong', {}, item.name ?? hostOf(item.url)),
    h('span', { class: 'muted small' }, FILTER_LABELS[item.reason] ?? 'It did not pass the checks.'))));

  const toInbox = h('button', { type: 'button', class: 'btn', onclick: goToInbox }, 'Open the inbox');
  const out = [
    group('Added to your radar', addedRows),
    group('Needs your review', reviewRows, toInbox),
    group('Already on your radar', trackedRows),
    filtered.length
      ? h('details', { class: 'find-group find-filtered' }, h('summary', {}, `Filtered out (${filtered.length})`), h('ul', { class: 'feed-list' }, filteredRows))
      : null,
  ].filter(Boolean);
  return out.length ? h('div', {}, out) : null;
}

export function mount(root, ctx) {
  let disposed = false;
  let sharedKeys = true; // whether this workspace may use the Worker's own search keys (from the settings answer)
  let running = false;
  let controller = null;
  let run = null;
  let items = [];
  let inboxCount = 0;
  const admin = () => ctx.session.getUser()?.role === 'admin';
  const selectedSectors = new Set();

  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const query = h('input', { type: 'search', name: 'query', required: true, minlength: 2, maxlength: 200, placeholder: 'Shared services events in Europe this autumn', value: params.get('q') ?? '' });
  const from = h('input', { type: 'date', value: today() });
  const to = h('input', { type: 'date', value: yearAhead() });
  const region = h('input', { type: 'text', maxlength: 60, placeholder: 'Optional, for example Europe' });
  const sectorRow = h('div', { class: 'find-topics', role: 'group', 'aria-label': 'Sectors to search' });
  const startBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search');
  const fillBtn = h('button', { type: 'button', class: 'btn', title: 'Search each ticked sector in turn, with the dates and region above', onclick: () => fillMap() }, 'Fill the map');
  const stopBtn = h('button', { type: 'button', class: 'btn', hidden: true, onclick: () => controller?.abort() }, 'Stop');
  const status = h('p', { class: 'muted find-status', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'find-results' });
  const form = h('form', { class: 'find-form glass', onsubmit: startSearch },
    h('label', { class: 'field field-grow' }, 'What are you looking for?', query),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, 'From', from), h('label', { class: 'field' }, 'To', to), h('label', { class: 'field' }, 'Region, a hint for the search', region)),
    sectorRow, h('div', { class: 'find-actions' }, startBtn, fillBtn, stopBtn));
  const settingsBox = h('details', { class: 'find-settings glass' });

  const searchPane = h('div', {}, form, status, results, settingsBox);
  const inboxList = h('div', { class: 'find-inbox' });
  const inboxPane = h('div', { hidden: true }, inboxList);
  const searchTab = h('button', { type: 'button', role: 'tab', class: 'find-tab', 'aria-selected': 'true', onclick: () => setTab('search') }, 'Search');
  const inboxTab = h('button', { type: 'button', role: 'tab', class: 'find-tab', 'aria-selected': 'false', onclick: () => setTab('inbox') }, 'Inbox');
  root.append(h('section', { class: 'view find' },
    h('header', {}, h('h1', {}, 'Find events'), h('p', { class: 'muted' }, 'Search the web and open event lists. Krillium checks every match across sites before it adds anything.')),
    h('div', { class: 'find-tabs', role: 'tablist' }, searchTab, inboxTab), searchPane, inboxPane));

  function setTab(name) {
    searchPane.hidden = name !== 'search';
    inboxPane.hidden = name !== 'inbox';
    searchTab.setAttribute('aria-selected', String(name === 'search'));
    inboxTab.setAttribute('aria-selected', String(name === 'inbox'));
    if (name === 'inbox') loadInbox();
  }

  function setInboxCount(n) {
    inboxCount = n;
    inboxTab.textContent = n ? `Inbox (${n})` : 'Inbox';
    window.dispatchEvent(new CustomEvent('radar:inbox', { detail: { count: n } }));
  }

  const handlers = {
    openEvent: (id) => ctx.openEvent(id),
    goToInbox: () => setTab('inbox'),
    async undo(item) {
      const res = await ctx.api.post(`/api/events/${encodeURIComponent(item.eventId)}/undo-auto-add`, {});
      return res.ok ? 'Removed. It will not come back.' : (res.error ?? 'That did not work. Try again.');
    },
  };

  function paint(finished = false) {
    const parts = [progressText(run, items)];
    if (run.note) parts.push(run.note);
    if (finished && run.status === 'done') parts.push('Search finished.');
    status.textContent = parts.join('. ').replace(/\.\./g, '.');
    const shown = renderResults(items, handlers);
    if (shown) results.replaceChildren(shown);
    else if (finished) results.replaceChildren(emptyState({ art: 'no-matches', title: 'No events matched', text: 'Try different words, a wider date range or another region.' }));
  }

  function notSetUp(missing = []) {
    return emptyState({
      art: 'load-error',
      title: 'Search is not set up yet',
      // A workspace the operator has not given the shared keys is told it needs its own; see keysNotice.
      text: keysNotice({ missing, sharedKeys, admin: admin() }),
    });
  }

  function showStartError(res) {
    if (res.status === 503) results.replaceChildren(notSetUp(res.missing));
    else if (res.status === 409) status.textContent = 'You already have a search running. Wait for it to finish, then try again.';
    else if (res.status === 423) status.textContent = 'Searches are paused by an admin.';
    else if (res.errors) status.textContent = res.errors.join(' ');
    else if (res.stale) status.textContent = 'Cannot reach the service. Check your connection and try again.';
    else if (res.status !== 401) status.textContent = res.error ?? 'The search could not start. Try again.';
  }

  const setBusy = (busy) => {
    running = busy;
    startBtn.disabled = busy;
    fillBtn.disabled = busy;
    stopBtn.hidden = !busy;
  };

  async function startSearch(ev) {
    ev.preventDefault();
    if (running) return;
    setBusy(true);
    results.replaceChildren();
    status.textContent = 'Starting the search.';
    const body = { query: query.value.trim(), from: from.value || undefined, to: to.value || undefined, sectors: [...selectedSectors] };
    if (region.value.trim()) body.region = region.value.trim();
    const started = await ctx.api.post('/api/search', body);
    if (disposed) return;
    if (!started.ok) {
      setBusy(false);
      showStartError(started);
      return;
    }
    run = started.data.run;
    items = started.data.items;
    controller = new AbortController();
    const outcome = await driveRun({
      api: ctx.api, runId: run.id, signal: controller.signal,
      onUpdate: (data) => {
        if (disposed) return;
        run = data.run;
        items = data.items;
        paint();
      },
    });
    // A run that stopped or failed here would stay "running" on the server and block the next search for a quarter of an hour.
    if (!outcome.ok || outcome.stopped) ctx.api.post(`/api/search/${run.id}/cancel`, {});
    if (disposed) return;
    setBusy(false);
    if (!outcome.ok) status.textContent = `The search stopped. ${outcome.error}`;
    else if (outcome.stopped) status.textContent = `Stopped. ${progressText(run, items)}.`;
    else paint(true);
    loadInbox();
  }

  // Fill the map: one search per ticked sector, in turn. Results from all of them are shown together, once each.
  async function fillMap() {
    if (running) return;
    const chosen = ctx.sectors.list().filter((s) => s.enabled && selectedSectors.has(s.id));
    if (!chosen.length) {
      status.textContent = 'Tick at least one sector to fill the map.';
      return;
    }
    setBusy(true);
    results.replaceChildren();
    status.textContent = 'Starting.';
    const kept = [];
    let pagesBefore = 0;
    let active = null;
    let label = '';
    const pagesRead = () => pagesBefore + (active?.status === 'running' ? active.pages : 0);
    controller = new AbortController();
    const outcome = await driveFill({
      api: ctx.api, sectors: chosen, from: from.value || undefined, to: to.value || undefined, region: region.value.trim() || undefined, signal: controller.signal,
      onSector: ({ sector, index, total }) => {
        label = `${sector.name}, ${index + 1} of ${total}`;
        status.textContent = `Searching ${label}.`;
      },
      onUpdate: ({ run: current, items: found }) => {
        if (disposed) return;
        active = current;
        if (current.status !== 'running') {
          kept.push(...found);
          pagesBefore += current.pages;
        }
        items = mergeItems(kept, found);
        status.textContent = `${label}. ${progressText({ pages: pagesRead() }, items)}.`;
        const shown = renderResults(items, handlers);
        if (shown) results.replaceChildren(shown);
      },
    });
    // A run that stopped or failed here would stay "running" on the server and block the next search for a quarter of an hour.
    if ((!outcome.ok || outcome.stopped) && active?.status === 'running') ctx.api.post(`/api/search/${active.id}/cancel`, {});
    if (disposed) return;
    setBusy(false);
    const summary = progressText({ pages: pagesRead() }, items);
    if (!outcome.ok) {
      if ([409, 423, 503].includes(outcome.status) || outcome.errors) showStartError(outcome);
      else status.textContent = `Fill the map stopped. ${outcome.error} ${summary}.`;
    } else if (outcome.stopped) {
      status.textContent = `Stopped. ${summary}.`;
    } else if (outcome.ended) {
      status.textContent = `Stopped after ${outcome.done.length} of ${chosen.length} sectors. ${outcome.run.note ?? ''} ${summary}.`.replace(/\s+/g, ' ');
    } else {
      status.textContent = `Filled the map from ${chosen.length} ${chosen.length === 1 ? 'sector' : 'sectors'}. ${summary}.`;
      if (!results.hasChildNodes()) results.replaceChildren(emptyState({ art: 'no-matches', title: 'No events matched', text: 'Try a wider date range or another region.' }));
    }
    loadInbox();
  }

  function card(item) {
    const note = h('p', { class: 'small', role: 'status' });
    const approve = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => act('approve') }, 'Approve');
    const reject = h('button', { type: 'button', class: 'btn', onclick: () => act('reject') }, 'Reject');
    const body = h('article', { class: 'find-card glass' },
      h('h3', {}, item.name),
      h('p', { class: 'muted' }, [where(item), item.organiser].filter(Boolean).join(', ')),
      item.sectors?.length ? h('p', { class: 'muted small' }, `Sectors: ${item.sectors.map(ctx.sectors.name).join(', ')}`) : null,
      item.conflict ? h('p', { class: 'find-conflict' }, `${item.conflict[0].toUpperCase()}${item.conflict.slice(1)}.`) : h('p', { class: 'muted small' }, item.reason),
      h('div', { class: 'find-sources' }, item.sources.map((s) => (safeUrl(s.url)
        ? h('a', { class: 'chip', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.quote ?? s.domain }, s.domain)
        : h('span', { class: 'chip' }, s.domain)))),
      h('p', { class: 'muted small' }, `Suggested score: fit ${item.suggested.fit}, timing ${item.suggested.timing}, distance ${item.suggested.distance}. Public names stay at 0 until a lineup is read.`),
      h('div', { class: 'find-actions' }, approve, reject), note);

    async function act(kind) {
      approve.disabled = true;
      reject.disabled = true;
      const res = await ctx.api.post(`/api/inbox/${item.id}/${kind}`, {});
      if (disposed) return;
      if (!res.ok) {
        note.textContent = res.error ?? 'That did not work. Try again.';
        approve.disabled = false;
        reject.disabled = false;
        return;
      }
      setInboxCount(Math.max(0, inboxCount - 1));
      body.replaceChildren(kind === 'approve'
        ? h('p', {}, `${item.name} is on your radar. `, h('button', { type: 'button', class: 'link-btn', onclick: () => ctx.openEvent(res.data.eventId) }, 'Open it'))
        : h('p', { class: 'muted' }, `${item.name} was rejected and will not come back.`));
    }
    return body;
  }

  async function loadInbox() {
    await ctx.sectors.load();
    const res = await ctx.api.get('/api/inbox');
    if (disposed || res.status === 401) return;
    if (!res.ok) {
      inboxList.replaceChildren(emptyState({ art: 'load-error', title: 'The inbox could not load', text: 'Check your connection and try again.',
        action: h('button', { type: 'button', class: 'btn btn-primary', onclick: loadInbox }, 'Try again') }));
      return;
    }
    setInboxCount(res.data.length);
    inboxList.replaceChildren(...(res.data.length
      ? res.data.map(card)
      : [emptyState({ art: 'no-events', title: 'Nothing is waiting for review', text: 'Events that need a second look appear here after a search.' })]));
  }

  function renderSettings(settings) {
    const canEdit = admin();
    const inputs = Object.fromEntries(SETTING_FIELDS.map(([key, , step]) => [key, h('input', { type: 'number', min: 0, step, value: settings[key], disabled: !canEdit })]));
    const paused = h('input', { type: 'checkbox', checked: settings.paused, disabled: !canEdit });
    const note = h('p', { class: 'small', role: 'status' });
    const save = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
      const patch = { paused: paused.checked };
      for (const [key] of SETTING_FIELDS) patch[key] = Number(inputs[key].value);
      const res = await ctx.api.put('/api/discovery/settings', patch);
      note.textContent = res.ok ? 'Saved.' : (res.errors?.join(' ') ?? res.error ?? 'That did not save. Try again.');
    } }, 'Save');
    // replaceChildren turns a null into the text "null", so the empty slots are filtered out.
    settingsBox.replaceChildren(...[h('summary', {}, 'Budget'),
      canEdit ? null : h('p', { class: 'muted small' }, 'Only an admin can change these.'),
      h('p', { class: 'muted small' }, settings.reader === 'claude'
        ? 'Claude reads the pages, so the Claude prices below apply.'
        : 'Exa reads the pages. If an Anthropic key is added to the Worker, Claude reads them instead and the Claude prices below apply.'),
      h('p', { class: 'muted small' }, 'Sectors and their topics are edited in the ', h('a', { href: '#/icp' }, 'ICP brain'), '.'),
      h('div', { class: 'fields' }, SETTING_FIELDS.map(([key, label]) => h('label', { class: 'field' }, label, inputs[key])),
        h('label', { class: 'field' }, h('span', {}, 'Pause all searches'), paused)),
      canEdit ? h('div', { class: 'find-actions' }, save, note) : null].filter(Boolean));
  }

  // One chip per switched-on sector, all ticked to begin with. Each shows its topics when hovered.
  function renderSectors() {
    const enabled = ctx.sectors.list().filter((s) => s.enabled);
    selectedSectors.clear();
    enabled.forEach((s) => selectedSectors.add(s.id));
    sectorRow.replaceChildren(...enabled.map((sector) => {
      const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', title: sector.topics.join(', '), onclick: () => {
        if (selectedSectors.has(sector.id)) selectedSectors.delete(sector.id);
        else selectedSectors.add(sector.id);
        chip.setAttribute('aria-pressed', String(selectedSectors.has(sector.id)));
      } }, sector.name);
      return chip;
    }));
  }

  async function loadSettings() {
    const res = await ctx.api.get('/api/discovery/settings');
    if (disposed || !res.ok) return;
    ctx.sectors.set(res.data.sectors);
    sharedKeys = res.data.sharedKeys !== false;
    renderSectors();
    renderSettings(res.data);
    if (res.data.missing?.length) {
      startBtn.disabled = true;
      fillBtn.disabled = true;
      results.replaceChildren(notSetUp(res.data.missing));
    }
  }

  const reload = () => {
    loadSettings();
    loadInbox();
  };
  window.addEventListener('radar:reauth', reload);
  reload();
  return () => {
    disposed = true;
    controller?.abort();
    if (running && run) ctx.api.post(`/api/search/${run.id}/cancel`, {});
    window.removeEventListener('radar:reauth', reload);
  };
}
