import { h } from '../dom.js';
import { emptyState } from '../empty-state.js';
import { daysUntil, formatRange, monthsSpan } from '../format.js';
import { createMap } from '../map-canvas.js';
import { dateWindow } from '../map-geometry.js';

const STATUS_LABEL = { 'must-attend': 'Must-attend', consider: 'Consider', watch: 'Watch' };
const PRESETS = [['events', 'All events'], ['world', 'World'], ['europe', 'Europe'], ['us', 'United States']];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');

export function mount(root, ctx) {
  let disposed = false;
  let events = [];
  let months = [];
  let range = [0, 0];
  let map = null;
  let view = 'events';

  const stage = h('div', { class: 'radar' });
  const hud = h('div', { class: 'radar-hud' });
  const card = h('div', { class: 'hover-card glass', hidden: true, role: 'status' });
  const summary = h('div', { class: 'hud-panel hud-summary glass' });
  const presets = h('div', { class: 'hud-panel hud-presets glass', role: 'group', 'aria-label': 'Map view' },
    PRESETS.map(([id, label]) => h('button', { type: 'button', class: 'seg', 'data-view': id, 'aria-pressed': id === view, onclick: () => setView(id) }, label)));
  const rank = h('aside', { class: 'hud-panel hud-rank glass', 'aria-label': 'Ranked events' });
  const timeline = h('div', { class: 'hud-panel hud-timeline glass' });
  const message = h('div', { class: 'hud-panel hud-message glass', hidden: true });
  hud.append(summary, presets, rank, timeline, card, message);
  stage.append(hud);
  root.append(stage);

  function setView(id) {
    view = id;
    presets.querySelectorAll('.seg').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === id)));
    map?.setView(id);
  }

  const windowBounds = () => {
    if (!months.length) return ['0000-01-01', '9999-12-31'];
    const a = months[range[0]];
    const b = months[range[1]];
    return [`${a.y}-${pad(a.m)}-01`, `${b.y}-${pad(b.m)}-31`];
  };

  function renderSummary(visible) {
    const must = visible.filter((e) => e.status === 'must-attend');
    const next = must.map((e) => ({ e, d: daysUntil(e.startDate) })).filter((x) => x.d !== null && x.d >= 0).sort((a, b) => a.d - b.d)[0];
    summary.replaceChildren(
      h('h1', {}, 'Radar'),
      h('p', { class: 'muted' }, `${visible.length} ${visible.length === 1 ? 'event' : 'events'} in view, ${must.length} must-attend.`),
      next ? h('button', { type: 'button', class: 'next-up', onclick: () => ctx.openEvent(next.e.id) },
        h('span', { class: 'next-up-label' }, 'Next must-attend'),
        h('span', {}, `${next.e.name}, ${next.d === 0 ? 'starts today' : `in ${next.d} ${next.d === 1 ? 'day' : 'days'}`}`)) : null,
    );
  }

  function renderRank(visible) {
    rank.replaceChildren(
      h('h2', {}, 'Ranked'),
      h('ol', { class: 'rank-list' }, visible.map((e) => h('li', {},
        h('button', { type: 'button', class: 'rank-item', onclick: () => ctx.openEvent(e.id), onmouseenter: () => map?.highlight(e.id), onmouseleave: () => map?.highlight(null), onfocus: () => map?.highlight(e.id), onblur: () => map?.highlight(null) },
          h('span', { class: `dot dot-${e.status}`, title: STATUS_LABEL[e.status] }),
          h('span', { class: 'rank-name' }, h('span', {}, e.name), h('span', { class: 'muted' }, [e.city ?? (e.lat === null ? 'Location TBC' : null), formatRange(e.startDate, e.endDate)].filter(Boolean).join(', '))),
          h('span', { class: 'num rank-score' }, String(Math.round(e.priority))))))),
    );
  }

  function renderTimeline() {
    if (months.length < 2) {
      timeline.hidden = true;
      return;
    }
    timeline.hidden = false;
    const label = h('span', { class: 'num tl-label' });
    const draw = () => {
      const a = months[range[0]];
      const b = months[range[1]];
      label.textContent = range[0] === range[1] ? `${MONTH[a.m - 1]} ${a.y}` : `${MONTH[a.m - 1]} ${a.y} to ${MONTH[b.m - 1]} ${b.y}`;
    };
    const make = (which, name) => h('input', { type: 'range', min: 0, max: months.length - 1, step: 1, value: range[which], 'aria-label': name, oninput: (ev) => {
      range[which] = Number(ev.target.value);
      if (range[0] > range[1]) range[which === 0 ? 1 : 0] = range[which];
      from.value = range[0];
      to.value = range[1];
      draw();
      refresh();
    } });
    const from = make(0, 'Show events from month');
    const to = make(1, 'Show events up to month');
    draw();
    timeline.replaceChildren(
      h('div', { class: 'tl-head' }, h('span', {}, 'Timeline'), label),
      h('div', { class: 'tl-track' }, from, to),
      h('div', { class: 'legend' }, ['must-attend', 'consider', 'watch'].map((s) => h('span', {}, h('span', { class: `dot dot-${s}` }), STATUS_LABEL[s]))),
    );
  }

  function refresh() {
    const [a, b] = windowBounds();
    const visible = dateWindow(events, a, b);
    map?.setWindow(new Set(visible.map((e) => e.id)));
    renderSummary(visible);
    renderRank(visible);
  }

  function showCard(e, at) {
    if (!e) {
      card.hidden = true;
      return;
    }
    card.replaceChildren(
      h('div', { class: 'card-head' }, h('strong', {}, e.name), h('span', { class: `pill pill-${e.status}` }, STATUS_LABEL[e.status])),
      h('p', { class: 'muted' }, [e.city, formatRange(e.startDate, e.endDate)].filter(Boolean).join(', ')),
      h('p', { class: 'card-stats' }, h('span', { class: 'num' }, String(Math.round(e.priority))), h('span', { class: 'muted' }, ` priority, ${e.counts.tierA} Tier A and ${e.counts.tierB} Tier B people attached`)),
      h('p', { class: 'muted card-hint' }, 'Click for the full picture'),
    );
    card.hidden = false;
    const w = card.offsetWidth;
    const hostW = stage.clientWidth;
    card.style.left = `${at.x + 22 + w > hostW - 12 ? at.x - 22 - w : at.x + 22}px`;
    card.style.top = `${Math.max(72, Math.min(at.y - 24, stage.clientHeight - card.offsetHeight - 90))}px`;
  }

  async function load() {
    message.hidden = true;
    const [result, icp] = await Promise.all([ctx.api.get('/api/radar'), ctx.api.get('/api/icp')]);
    if (disposed) return;
    if (!result.ok) {
      if (result.status === 401) return;
      message.hidden = false;
      message.replaceChildren(emptyState({ art: 'load-error', title: 'The radar could not load', text: result.stale ? 'The service is not reachable. Check your connection and try again.' : 'The service returned an error. Try again in a moment.', action: h('button', { type: 'button', class: 'btn btn-primary', onclick: load }, 'Try again') }));
      return;
    }
    events = result.data;
    if (!events.length) {
      message.hidden = false;
      message.replaceChildren(emptyState({ art: 'no-events', title: 'No events yet', text: 'Import the case-study Sheet to fill the radar. DEPLOY.md lists the steps.' }));
      return;
    }
    months = monthsSpan(events);
    range = [0, Math.max(0, months.length - 1)];
    if (!map) {
      try {
        map = await createMap(stage, { bases: icp.ok && icp.data.homeBases?.length ? icp.data.homeBases : DEFAULT_BASES, reducedMotion: ctx.prefersReducedMotion, onSelect: (id) => ctx.openEvent(id), onHover: showCard });
      } catch {
        if (disposed) return;
        message.hidden = false;
        message.replaceChildren(emptyState({ art: 'load-error', title: 'The map could not load', text: 'The map files did not load. Check your connection and try again.', action: h('button', { type: 'button', class: 'btn btn-primary', onclick: load }, 'Try again') }));
        renderSummary(events);
        renderRank(events);
        return;
      }
      if (disposed) {
        map.destroy();
        return;
      }
      stage.prepend(stage.querySelector('.map-svg'));
    }
    map.setEvents(events);
    applyInsets();
    renderTimeline();
    refresh();
    map.setView(view, false);
    stage.classList.add('is-ready');
  }

  const wide = window.matchMedia('(min-width: 1101px)');
  const applyInsets = () => map?.setInsets({ right: wide.matches ? 340 : 0, bottom: 110 });
  const onWide = () => {
    applyInsets();
    map?.setView(view, false);
  };
  wide.addEventListener('change', onWide);

  const DEFAULT_BASES = [{ name: 'Berlin', lat: 52.52, lon: 13.405 }, { name: 'New York', lat: 40.7128, lon: -74.006 }];
  window.addEventListener('radar:reauth', load);
  load();

  return () => {
    disposed = true;
    window.removeEventListener('radar:reauth', load);
    wide.removeEventListener('change', onWide);
    map?.destroy();
  };
}
