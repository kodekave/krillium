// Find events: search the web and open event lists, then review what was found. Two tabs, Search and Inbox.
import { h, safeUrl } from '../dom.js';
import { emptyState } from '../empty-state.js';
import { FILTER_LABELS, driveRun, groupItems, progressText } from '../find-state.js';
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
  ['priceInPerMtok', 'Model price in (USD per million tokens)', 0.1],
  ['priceOutPerMtok', 'Model price out (USD per million tokens)', 0.1],
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
  let running = false;
  let controller = null;
  let run = null;
  let items = [];
  let inboxCount = 0;
  const admin = () => ctx.session.getUser()?.role === 'admin';
  const selectedTopics = new Set();

  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const query = h('input', { type: 'search', name: 'query', required: true, minlength: 2, maxlength: 200, placeholder: 'Shared services events in Europe this autumn', value: params.get('q') ?? '' });
  const from = h('input', { type: 'date', value: today() });
  const to = h('input', { type: 'date', value: yearAhead() });
  const region = h('input', { type: 'text', maxlength: 60, placeholder: 'Optional, for example Europe' });
  const topicRow = h('div', { class: 'find-topics' });
  const startBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search');
  const stopBtn = h('button', { type: 'button', class: 'btn', hidden: true, onclick: () => controller?.abort() }, 'Stop');
  const status = h('p', { class: 'muted find-status', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'find-results' });
  const form = h('form', { class: 'find-form glass', onsubmit: startSearch },
    h('label', { class: 'field field-grow' }, 'What are you looking for?', query),
    h('div', { class: 'fields' }, h('label', { class: 'field' }, 'From', from), h('label', { class: 'field' }, 'To', to), h('label', { class: 'field' }, 'Region, a hint for the search', region)),
    topicRow, h('div', { class: 'find-actions' }, startBtn, stopBtn));
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
      text: admin()
        ? `Add ${missing.join(' and ')} to the Worker as secrets, then reload this page. DEPLOY.md has the steps.`
        : 'An admin needs to finish setting up search.',
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
    stopBtn.hidden = !busy;
  };

  async function startSearch(ev) {
    ev.preventDefault();
    if (running) return;
    setBusy(true);
    results.replaceChildren();
    status.textContent = 'Starting the search.';
    const body = { query: query.value.trim(), from: from.value || undefined, to: to.value || undefined, topics: [...selectedTopics] };
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

  function card(item) {
    const note = h('p', { class: 'small', role: 'status' });
    const approve = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => act('approve') }, 'Approve');
    const reject = h('button', { type: 'button', class: 'btn', onclick: () => act('reject') }, 'Reject');
    const body = h('article', { class: 'find-card glass' },
      h('h3', {}, item.name),
      h('p', { class: 'muted' }, [where(item), item.organiser].filter(Boolean).join(', ')),
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
    const topics = h('input', { type: 'text', value: settings.topics.join(', '), disabled: !canEdit });
    const paused = h('input', { type: 'checkbox', checked: settings.paused, disabled: !canEdit });
    const note = h('p', { class: 'small', role: 'status' });
    const save = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
      const patch = { paused: paused.checked, topics: topics.value.split(',').map((t) => t.trim()).filter(Boolean) };
      for (const [key] of SETTING_FIELDS) patch[key] = Number(inputs[key].value);
      const res = await ctx.api.put('/api/discovery/settings', patch);
      note.textContent = res.ok ? 'Saved.' : (res.errors?.join(' ') ?? res.error ?? 'That did not save. Try again.');
    } }, 'Save');
    settingsBox.replaceChildren(h('summary', {}, 'Budget and topics'),
      canEdit ? null : h('p', { class: 'muted small' }, 'Only an admin can change these.'),
      h('div', { class: 'fields' }, SETTING_FIELDS.map(([key, label]) => h('label', { class: 'field' }, label, inputs[key])),
        h('label', { class: 'field field-grow' }, 'Topics, separated by commas', topics),
        h('label', { class: 'field' }, h('span', {}, 'Pause all searches'), paused)),
      canEdit ? h('div', { class: 'find-actions' }, save, note) : null);
  }

  function renderTopics(settings) {
    selectedTopics.clear();
    settings.topics.forEach((t) => selectedTopics.add(t));
    topicRow.replaceChildren(...settings.topics.map((topic) => {
      const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', onclick: () => {
        if (selectedTopics.has(topic)) selectedTopics.delete(topic);
        else selectedTopics.add(topic);
        chip.setAttribute('aria-pressed', String(selectedTopics.has(topic)));
      } }, topic);
      return chip;
    }));
  }

  async function loadSettings() {
    const res = await ctx.api.get('/api/discovery/settings');
    if (disposed || !res.ok) return;
    renderTopics(res.data);
    renderSettings(res.data);
    if (res.data.missing?.length) {
      startBtn.disabled = true;
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
