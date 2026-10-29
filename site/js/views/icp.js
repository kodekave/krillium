import { h } from '../dom.js';
import { emptyState } from '../empty-state.js';
import { applyEdit, createDraftStore, describeDraft, previewRanking, setDensityShare } from '../icp-draft.js';
import { addSector, describeSectors, parseTopics, removeSector, topicsText, updateSector } from '../sector-draft.js';
import { timeAgo } from '../format.js';
import { describeMemory } from '../shared/memory.js';
import { MAX_NAME_LENGTH, MAX_SECTORS } from '../shared/sectors.js';

const STATUS_LABEL = { 'must-attend': 'Must-attend', consider: 'Consider', watch: 'Watch' };
const store = createDraftStore();

const SECTIONS = [
  { title: 'Status cut-offs', note: 'Priority needed for each status.', rows: [['thresholds.mustAttend', 'Must-attend from', 0, 100, 1], ['thresholds.consider', 'Consider from', 0, 100, 1]] },
  { title: 'Lead tiers', note: 'Lead score needed for each tier.', rows: [['thresholds.tierA', 'Tier A from', 0, 100, 1], ['thresholds.tierB', 'Tier B from', 0, 100, 1]] },
  { title: 'Buyer density', note: 'How much each attached person counts toward an event.', rows: [['density.tierA', 'Tier A person', 0, 20, 0.5], ['density.tierB', 'Tier B person', 0, 20, 0.5], ['density.accountOnly', 'Company with no named person', 0, 20, 0.5]] },
  { title: 'Persona points', note: 'Added to a lead score by buying role.', rows: [['persona.economic_buyer', 'Economic buyer', 0, 40, 1], ['persona.champion', 'Champion', 0, 40, 1], ['persona.influencer', 'Influencer', 0, 40, 1]] },
  { title: 'Event role points', note: 'Added to a lead score by what they do at the event.', rows: [['eventRole.speaker', 'Speaker, keynote, panelist', 0, 40, 1], ['eventRole.exhibitor', 'Exhibitor or sponsor', 0, 40, 1], ['eventRole.attendee', 'Named attendee', 0, 40, 1], ['eventRole.company_only', 'Company only', 0, 40, 1]] },
  { title: 'Contactability points', note: 'Added when a way to reach them is known.', rows: [['contact.verified_email', 'Verified email', 0, 20, 1], ['contact.linkedin', 'LinkedIn only', 0, 20, 1], ['contact.none', 'Neither', 0, 20, 1]] },
];

const getIn = (obj, path) => path.split('.').reduce((n, k) => n?.[k], obj);

export function mount(root, ctx) {
  let disposed = false;
  let saved = null;
  let events = [];
  let draft = null;

  const status = h('p', { class: 'muted small', role: 'status' });
  const errors = h('ul', { class: 'errors', role: 'alert', hidden: true });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true, onclick: save }, 'Save');
  const resetBtn = h('button', { type: 'button', class: 'btn', disabled: true, onclick: reset }, 'Discard changes');
  const form = h('div', { class: 'icp-form' });
  const preview = h('aside', { class: 'icp-preview glass' });

  // Sectors are saved on their own, through the discovery settings, not as a version of the ranking above.
  const admin = () => ctx.session.getUser()?.role === 'admin';
  let sectorsSaved = [];
  let sectorsDraft = [];
  const sectorsBox = h('section', { class: 'icp-card glass icp-sectors' });
  // What this workspace has decided and done, from its first day. Read-only for now.
  const memoryBox = h('section', { class: 'icp-card glass icp-memory' });
  const sectorList = h('div', { class: 'sector-list' });
  const sectorErrors = h('ul', { class: 'errors', role: 'alert', hidden: true });
  const sectorStatus = h('p', { class: 'muted small', role: 'status' });
  const sectorSave = h('button', { type: 'button', class: 'btn btn-primary', disabled: true, onclick: () => saveSectors() }, 'Save sectors');
  const sectorReset = h('button', { type: 'button', class: 'btn', disabled: true, onclick: () => resetSectors() }, 'Discard changes');
  const head = h('header', {}, h('h1', {}, 'ICP brain'), h('p', { class: 'muted' }, 'Change what a good event looks like. The ranking on the right updates as you type; nothing changes for the team until you save.'));
  root.append(h('section', { class: 'view' }, head, h('div', { class: 'icp-actions' }, saveBtn, resetBtn, status), errors, h('div', { class: 'icp-grid' }, form, preview), sectorsBox, memoryBox));

  function edit(path, value) {
    draft = path === 'weights.icpDensityShare' ? setDensityShare(draft, value) : applyEdit(draft, path, value);
    store.set(draft);
    refresh();
  }

  const numberField = ([path, label, min, max, step]) => h('label', { class: 'field row-field' }, label,
    h('input', { type: 'number', min, max, step, value: getIn(draft, path), 'data-path': path, onchange: (ev) => {
      const n = Number(ev.target.value);
      if (Number.isFinite(n)) edit(path, n);
    } }));

  function renderForm() {
    const share = draft.weights.icpDensityShare;
    const label = h('span', { class: 'num share-label' });
    const slider = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: share, 'aria-label': 'Weight of buyer density against event score', oninput: (ev) => {
      edit('weights.icpDensityShare', Number(ev.target.value));
      label.textContent = shareText(draft);
    } });
    label.textContent = shareText(draft);
    form.replaceChildren(
      h('section', { class: 'icp-card glass' }, h('h2', {}, 'Ranking mix'), h('p', { class: 'muted small' }, 'How much an event\'s own quality counts against the buyers attached to it.'), slider, label),
      ...SECTIONS.map((s) => h('section', { class: 'icp-card glass' }, h('h2', {}, s.title), h('p', { class: 'muted small' }, s.note), h('div', { class: 'fields' }, s.rows.map(numberField)))),
      h('section', { class: 'icp-card glass' }, h('h2', {}, 'Home bases'), h('p', { class: 'muted small' }, 'Where your team travels from. Map arcs start at the nearest one.'),
        draft.homeBases.map((b, i) => h('div', { class: 'base-row' },
          h('label', { class: 'field' }, 'Name', h('input', { type: 'text', value: b.name, onchange: (ev) => edit(`homeBases.${i}.name`, ev.target.value) })),
          h('label', { class: 'field' }, 'Latitude', h('input', { type: 'number', min: -90, max: 90, step: 0.0001, value: b.lat, onchange: (ev) => Number.isFinite(Number(ev.target.value)) && edit(`homeBases.${i}.lat`, Number(ev.target.value)) })),
          h('label', { class: 'field' }, 'Longitude', h('input', { type: 'number', min: -180, max: 180, step: 0.0001, value: b.lon, onchange: (ev) => Number.isFinite(Number(ev.target.value)) && edit(`homeBases.${i}.lon`, Number(ev.target.value)) }))))),
    );
  }

  const shareText = (cfg) => `Event score ${Math.round(cfg.weights.eventScoreShare * 100)}%, buyer density ${Math.round(cfg.weights.icpDensityShare * 100)}%`;

  function refresh() {
    const state = describeDraft(saved, draft);
    saveBtn.disabled = !state.dirty || !state.valid;
    resetBtn.disabled = !state.dirty;
    saveBtn.textContent = `Save as version ${saved.version + 1}`;
    errors.hidden = state.valid;
    errors.replaceChildren(...state.errors.map((e) => h('li', {}, e)));
    const rows = previewRanking(events, saved, draft);
    const must = rows.filter((r) => r.status === 'must-attend').length;
    const mustBefore = rows.filter((r) => r.previousStatus === 'must-attend').length;
    preview.replaceChildren(
      h('h2', {}, 'Preview ranking'),
      h('p', { class: 'muted small' }, `${must} must-attend${must !== mustBefore ? ` (was ${mustBefore})` : ''}. Arrows compare with version ${saved.version}.`),
      h('ol', { class: 'preview-list' }, rows.map((r) => h('li', { class: 'preview-row' },
        h('span', { class: 'num preview-rank' }, String(r.rank)),
        h('span', { class: 'preview-name' }, h('span', {}, r.name), h('span', { class: 'muted small' }, r.statusChanged ? `${STATUS_LABEL[r.previousStatus]} becomes ${STATUS_LABEL[r.status]}` : STATUS_LABEL[r.status])),
        h('span', { class: `delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}`, 'aria-label': r.delta === 0 ? 'same rank' : `${Math.abs(r.delta)} ${r.delta > 0 ? 'up' : 'down'}` }, r.delta === 0 ? '·' : `${r.delta > 0 ? '▲' : '▼'}${Math.abs(r.delta)}`),
        h('span', { class: 'num' }, String(Math.round(r.priority)))))),
    );
  }

  function refreshSectors() {
    const state = describeSectors(sectorsSaved, sectorsDraft);
    sectorSave.disabled = !state.dirty || !state.valid;
    sectorReset.disabled = !state.dirty;
    sectorErrors.hidden = state.valid;
    sectorErrors.replaceChildren(...state.errors.map((e) => h('li', {}, e)));
  }

  function editSector(index, patch) {
    sectorsDraft = updateSector(sectorsDraft, index, patch);
    refreshSectors();
  }

  function renderSectorRows() {
    const canEdit = admin();
    sectorList.replaceChildren(...sectorsDraft.map((s, i) => h('div', { class: 'sector-row' },
      h('label', { class: 'field' }, 'Name', h('input', { type: 'text', value: s.name, maxlength: MAX_NAME_LENGTH, disabled: !canEdit, oninput: (ev) => editSector(i, { name: ev.target.value }) })),
      h('label', { class: 'field sector-topics' }, 'Topics, separated by commas', h('input', { type: 'text', value: topicsText(s.topics), disabled: !canEdit, oninput: (ev) => editSector(i, { topics: parseTopics(ev.target.value) }) })),
      h('label', { class: 'field sector-on' }, h('span', {}, 'On'), h('input', { type: 'checkbox', checked: s.enabled, disabled: !canEdit, onchange: (ev) => editSector(i, { enabled: ev.target.checked }) })),
      canEdit ? h('button', { type: 'button', class: 'btn', 'aria-label': `Remove ${s.name}`, onclick: () => { sectorsDraft = removeSector(sectorsDraft, i); renderSectorRows(); refreshSectors(); } }, 'Remove') : null)));
  }

  function renderSectors() {
    const canEdit = admin();
    const add = h('button', { type: 'button', class: 'btn', disabled: sectorsDraft.length >= MAX_SECTORS, onclick: () => { sectorsDraft = addSector(sectorsDraft); renderSectorRows(); refreshSectors(); } }, 'Add a sector');
    // replaceChildren() prints a null argument as the text "null", so the empty slots are filtered out first.
    sectorsBox.replaceChildren(...[
      h('h2', {}, 'Sectors'),
      h('p', { class: 'muted small' }, 'The kinds of event you look for. A search uses the topics of each sector, and an event is tagged with the sectors whose topics its page mentions. Sectors are saved on their own, apart from the ranking above, and searches use them as soon as they are saved.'),
      canEdit ? null : h('p', { class: 'muted small' }, 'Only an admin can change sectors.'),
      sectorList,
      sectorErrors,
      canEdit ? h('div', { class: 'icp-actions' }, add, sectorSave, sectorReset, sectorStatus) : null,
    ].filter(Boolean));
    renderSectorRows();
    refreshSectors();
  }

  function showSectors() {
    const list = ctx.sectors.list();
    if (!list.length) {
      sectorsBox.replaceChildren(h('h2', {}, 'Sectors'), h('p', { class: 'muted small' }, 'The sectors could not load. Reload the page to try again.'));
      return;
    }
    sectorsSaved = structuredClone(list);
    sectorsDraft = structuredClone(list);
    renderSectors();
  }

  function resetSectors() {
    sectorsDraft = structuredClone(sectorsSaved);
    sectorStatus.textContent = '';
    renderSectors();
  }

  async function saveSectors() {
    sectorSave.disabled = true;
    const result = await ctx.api.put('/api/discovery/settings', { sectors: sectorsDraft });
    if (disposed) return;
    if (result.ok) {
      ctx.sectors.set(result.data.sectors);
      sectorsSaved = structuredClone(result.data.sectors);
      sectorsDraft = structuredClone(sectorsSaved);
      sectorStatus.textContent = 'Saved. New searches use these sectors now.';
      renderSectors();
      loadMemory();
    } else {
      sectorStatus.textContent = result.stale ? 'Cannot reach the service. Your changes are kept here; try again.'
        : result.status === 401 ? 'Your session ended. Sign in and save again; your changes are kept.'
          : result.status === 403 ? 'Only an admin can change sectors.'
            : `Not saved: ${result.errors?.join(' ') ?? result.error ?? 'try again'}.`;
      refreshSectors();
    }
  }

  async function save() {
    saveBtn.disabled = true;
    const result = await ctx.api.put('/api/icp', draft);
    if (disposed) return;
    if (result.ok) {
      saved = { ...draft, version: result.data.version };
      draft = structuredClone(saved);
      store.clear();
      status.textContent = `Saved as version ${saved.version}. The radar uses it now.`;
      renderForm();
      refresh();
      loadMemory();
    } else {
      status.textContent = result.stale ? 'Cannot reach the service. Your changes are kept here; try again.' : result.status === 401 ? 'Your session ended. Sign in and save again; your changes are kept.' : `Not saved: ${result.error ?? 'try again'}.`;
      if (result.errors) errors.replaceChildren(...result.errors.map((e) => h('li', {}, e)));
      errors.hidden = !result.errors;
      refresh();
    }
  }

  function reset() {
    draft = structuredClone(saved);
    store.clear();
    status.textContent = '';
    renderForm();
    refresh();
  }

  // The newest entries of the workspace's memory, in plain words. A failure here never blocks the rest of the screen.
  async function loadMemory() {
    const res = await ctx.api.get('/api/memory?limit=20');
    if (disposed) return;
    if (!res.ok) {
      if (res.status === 401) return;
      memoryBox.replaceChildren(h('h2', {}, 'Memory'), h('p', { class: 'muted small' }, 'The memory could not load. Reload the page to try again.'));
      return;
    }
    const { total, items } = res.data;
    // replaceChildren() prints a null argument as the text "null", so the empty slots are filtered out first.
    memoryBox.replaceChildren(...[
      h('h2', {}, 'Memory'),
      h('p', { class: 'muted small' }, 'What this workspace has decided and done, from its first day. It is private to this workspace, and nothing here changes how events are ranked yet.'),
      total
        ? h('p', { class: 'small' }, `${total} ${total === 1 ? 'thing' : 'things'} remembered${total > items.length ? `. The latest ${items.length}:` : ':'}`)
        : h('p', { class: 'muted small' }, 'Nothing yet. Decisions you make from here on are recorded.'),
      items.length
        ? h('ul', { class: 'memory-list' }, items.map((item) => h('li', {},
          h('span', {}, describeMemory(item)),
          h('span', { class: 'muted small' }, [timeAgo(item.at), item.actor && item.actor !== 'system' ? item.actor : null].filter(Boolean).join(' · ')))))
        : null,
    ].filter(Boolean));
  }

  async function load() {
    const [icp, radar] = await Promise.all([ctx.api.get('/api/icp'), ctx.api.get('/api/radar'), ctx.sectors.load()]);
    if (disposed) return;
    if (!icp.ok || !radar.ok) {
      if (icp.status === 401 || radar.status === 401) return;
      form.replaceChildren(emptyState({ art: 'load-error', title: 'The ICP settings could not load', text: 'Check your connection and try again.', action: h('button', { type: 'button', class: 'btn btn-primary', onclick: load }, 'Try again') }));
      return;
    }
    saved = icp.data;
    events = radar.data;
    draft = store.get() && store.get().version === saved.version ? store.get() : structuredClone(saved);
    renderForm();
    refresh();
    showSectors();
    loadMemory();
  }

  window.addEventListener('radar:reauth', load);
  load();
  return () => {
    disposed = true;
    window.removeEventListener('radar:reauth', load);
  };
}
