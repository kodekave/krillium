import { h } from '../dom.js';
import { formatRange } from '../format.js';
import { filterEvents } from '../filters.js';

const STATUS_LABEL = { 'must-attend': 'Must-attend', consider: 'Consider', watch: 'Watch' };
const FRESH_LABEL = { verified: 'Verified', 'needs-check': 'Needs check', changed: 'Changed' };
const DEFAULTS = { query: '', region: 'all', status: 'all', minScore: '' };

export function mount(root, ctx) {
  let disposed = false;
  let events = [];
  const filters = { ...DEFAULTS, ...(ctx.prefs?.getJson('filters') ?? {}) };

  const count = h('p', { class: 'muted' });
  const body = h('div', { class: 'events-body' });
  const select = (key, label, options) => h('label', { class: 'field' }, label,
    h('select', { 'aria-label': label, onchange: (ev) => update(key, ev.target.value) },
      options.map(([value, text]) => h('option', { value, selected: String(filters[key]) === value }, text))));
  const search = h('input', { type: 'search', placeholder: 'Search name, city, organiser', 'aria-label': 'Search events', value: filters.query, oninput: (ev) => update('query', ev.target.value) });
  const bar = h('div', { class: 'filter-bar' },
    h('label', { class: 'field field-grow' }, 'Search', search),
    select('region', 'Region', [['all', 'Everywhere'], ['europe', 'Europe'], ['americas', 'Americas']]),
    select('status', 'Status', [['all', 'Any status'], ['must-attend', 'Must-attend'], ['consider', 'Consider'], ['watch', 'Watch']]),
    select('minScore', 'Priority', [['', 'Any priority'], ['45', '45 or more'], ['70', '70 or more']]),
  );
  root.append(h('section', { class: 'view' }, h('header', {}, h('h1', {}, 'Events'), count), bar, body));

  function update(key, value) {
    filters[key] = value;
    ctx.prefs?.setJson('filters', filters);
    render();
  }

  function render() {
    const list = filterEvents(events, { ...filters, minScore: filters.minScore === '' ? undefined : filters.minScore });
    count.textContent = `${list.length} of ${events.length} events, ranked by how many ICP buyers are publicly attached.`;
    if (!list.length) {
      body.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, events.length ? 'No events match these filters' : 'No events yet'),
        events.length ? h('button', { type: 'button', class: 'btn', onclick: () => { Object.assign(filters, DEFAULTS); search.value = ''; bar.querySelectorAll('select').forEach((s) => { s.selectedIndex = 0; }); ctx.prefs?.setJson('filters', filters); render(); } }, 'Clear filters')
          : h('p', { class: 'muted' }, 'Import the case-study Sheet to fill this table. DEPLOY.md lists the steps.')));
      return;
    }
    body.replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Event', 'Where and when', 'Priority', 'Status', 'Page', 'Buyers'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, list.map((e) => h('tr', { 'data-id': e.id, onclick: () => ctx.openEvent(e.id) },
        h('td', {}, h('button', { type: 'button', class: 'link-btn', onclick: (ev) => { ev.stopPropagation(); ctx.openEvent(e.id); } }, e.name), e.organiser ? h('div', { class: 'muted small' }, e.organiser) : null),
        h('td', {}, [e.city ?? (e.lat === null ? 'Location TBC' : null), formatRange(e.startDate, e.endDate)].filter(Boolean).join(', ')),
        h('td', {}, h('div', { class: 'score' }, h('span', { class: 'num' }, String(Math.round(e.priority))), h('span', { class: 'bar' }, h('span', { class: `bar-fill bar-${e.status}`, style: `width:${Math.max(2, Math.min(100, e.priority))}%` })))),
        h('td', {}, h('span', { class: `pill pill-${e.status}` }, STATUS_LABEL[e.status])),
        h('td', {}, h('span', { class: `pill pill-${e.freshness}` }, FRESH_LABEL[e.freshness])),
        h('td', { class: 'num' }, `${e.counts.tierA} A, ${e.counts.tierB} B`, e.counts.accountOnly ? h('span', { class: 'muted' }, ` + ${e.counts.accountOnly} cos`) : null),
      ))))));
  }

  async function load() {
    const result = await ctx.api.get('/api/radar');
    if (disposed) return;
    if (!result.ok) {
      if (result.status === 401) return;
      body.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'The events could not load'), h('p', { class: 'muted' }, result.stale ? 'The service is not reachable. Check your connection and try again.' : 'The service returned an error. Try again in a moment.'), h('button', { type: 'button', class: 'btn btn-primary', onclick: load }, 'Try again')));
      return;
    }
    events = result.data;
    render();
  }

  window.addEventListener('radar:reauth', load);
  load();
  return () => {
    disposed = true;
    window.removeEventListener('radar:reauth', load);
  };
}
