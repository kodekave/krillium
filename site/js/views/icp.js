import { h } from '../dom.js';
import { applyEdit, createDraftStore, describeDraft, previewRanking, setDensityShare } from '../icp-draft.js';

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
  const head = h('header', {}, h('h1', {}, 'ICP brain'), h('p', { class: 'muted' }, 'Change what a good event looks like. The ranking on the right updates as you type; nothing changes for the team until you save.'));
  root.append(h('section', { class: 'view' }, head, h('div', { class: 'icp-actions' }, saveBtn, resetBtn, status), errors, h('div', { class: 'icp-grid' }, form, preview)));

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

  async function load() {
    const [icp, radar] = await Promise.all([ctx.api.get('/api/icp'), ctx.api.get('/api/radar')]);
    if (disposed) return;
    if (!icp.ok || !radar.ok) {
      if (icp.status === 401 || radar.status === 401) return;
      form.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'The ICP settings could not load'), h('button', { type: 'button', class: 'btn btn-primary', onclick: load }, 'Try again')));
      return;
    }
    saved = icp.data;
    events = radar.data;
    draft = store.get() && store.get().version === saved.version ? store.get() : structuredClone(saved);
    renderForm();
    refresh();
  }

  window.addEventListener('radar:reauth', load);
  load();
  return () => {
    disposed = true;
    window.removeEventListener('radar:reauth', load);
  };
}
