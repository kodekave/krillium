import { h, s } from '../dom.js';
import { emptyState } from '../empty-state.js';
import { buildGraph } from '../graph-data.js';
import { createSimulation } from '../force-layout.js';

const radius = (n) => (n.kind === 'event' ? 7 + Math.min(10, n.priority / 10) : n.kind === 'persona' ? 9 : 4.5);

export function mount(root, ctx) {
  let disposed = false;
  let frame = 0;
  let observer = null;
  const stage = h('div', { class: 'graph-stage' });
  const legend = h('div', { class: 'graph-legend glass' },
    h('h1', {}, 'Graph'),
    h('p', { class: 'muted small' }, 'Events link to the companies attached to them, and companies to the buying roles seen there. Hover to trace a path; click an event for details.'),
    h('div', { class: 'legend-rows' },
      h('span', {}, h('span', { class: 'dot dot-must-attend' }), 'Must-attend event'),
      h('span', {}, h('span', { class: 'dot dot-consider' }), 'Consider'),
      h('span', {}, h('span', { class: 'dot dot-watch' }), 'Watch'),
      h('span', {}, h('span', { class: 'dot dot-company' }), 'Company'),
      h('span', {}, h('span', { class: 'dot dot-persona' }), 'Buying role')));
  const message = h('div', { class: 'hud-panel hud-message glass', hidden: true });
  root.append(h('section', { class: 'graph' }, stage, legend, message));
  let data = null;

  function draw() {
    cancelAnimationFrame(frame);
    stage.replaceChildren();
    const width = Math.max(320, stage.clientWidth);
    const height = Math.max(320, stage.clientHeight);
    const graph = buildGraph(data.events, data.accountsByEvent);
    const sim = createSimulation(graph.nodes, graph.links, { width, height });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const neighbours = new Map(graph.nodes.map((n) => [n.id, new Set([n.id])]));
    for (const l of graph.links) { neighbours.get(l.source).add(l.target); neighbours.get(l.target).add(l.source); }

    const svg = s('svg', { class: 'graph-svg', viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': 'Graph of events, companies and buying roles' });
    const lineEls = graph.links.map((l) => s('line', { class: 'g-link' }));
    const nodeEls = graph.nodes.map((n) => {
      const label = s('text', { class: 'g-label', y: radius(n) + 13, 'text-anchor': 'middle' }, n.label);
      const shape = n.kind === 'persona' ? s('rect', { class: 'g-shape g-persona', x: -radius(n), y: -radius(n), width: radius(n) * 2, height: radius(n) * 2, rx: 4 }) : s('circle', { class: `g-shape g-${n.kind}${n.status ? ` g-${n.status}` : ''}`, r: radius(n) });
      const g = s('g', { class: `g-node g-kind-${n.kind}`, tabindex: n.kind === 'event' ? 0 : null, role: n.kind === 'event' ? 'button' : null, 'aria-label': n.kind === 'event' ? `${n.label}, open details` : null }, shape, label);
      g.addEventListener('mouseenter', () => focusNode(n.id));
      g.addEventListener('mouseleave', () => focusNode(null));
      if (n.kind === 'event') {
        g.addEventListener('focus', () => focusNode(n.id));
        g.addEventListener('blur', () => focusNode(null));
        g.addEventListener('click', () => ctx.openEvent(n.eventId));
        g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ctx.openEvent(n.eventId); } });
      }
      return g;
    });
    svg.append(...lineEls, ...nodeEls);
    stage.append(svg);

    function place() {
      graph.links.forEach((l, i) => {
        const a = byId.get(l.source);
        const b = byId.get(l.target);
        lineEls[i].setAttribute('x1', a.x); lineEls[i].setAttribute('y1', a.y);
        lineEls[i].setAttribute('x2', b.x); lineEls[i].setAttribute('y2', b.y);
      });
      graph.nodes.forEach((n, i) => nodeEls[i].setAttribute('transform', `translate(${n.x} ${n.y})`));
    }

    function focusNode(id) {
      const keep = id ? neighbours.get(id) : null;
      graph.nodes.forEach((n, i) => {
        nodeEls[i].classList.toggle('is-dim', Boolean(keep) && !keep.has(n.id));
        nodeEls[i].classList.toggle('is-near', Boolean(keep) && keep.has(n.id));
      });
      graph.links.forEach((l, i) => {
        const on = Boolean(id) && (l.source === id || l.target === id);
        lineEls[i].classList.toggle('is-on', on);
        lineEls[i].classList.toggle('is-dim', Boolean(id) && !on);
      });
    }

    // Keep the label of the most important node when two labels would overlap.
    function declutter() {
      const placed = [];
      const order = graph.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.kind !== 'company')
        .sort((a, b) => (b.n.kind === 'persona') - (a.n.kind === 'persona') || (b.n.priority ?? 0) - (a.n.priority ?? 0));
      for (const { n, i } of order) {
        const half = n.label.length * 3;
        const box = { x0: n.x - half, x1: n.x + half, y0: n.y + radius(n) + 2, y1: n.y + radius(n) + 15 };
        const clash = placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
        nodeEls[i].querySelector('.g-label').style.display = clash ? 'none' : '';
        if (!clash) placed.push(box);
      }
    }

    if (ctx.prefersReducedMotion()) {
      sim.settle(600);
      place();
      declutter();
    } else {
      let frames = 0;
      const step = () => {
        for (let i = 0; i < 3; i += 1) sim.tick();
        place();
        frames += 1;
        if (frames < 220 && !disposed) frame = requestAnimationFrame(step);
        else declutter();
      };
      step();
    }
  }

  async function load() {
    message.hidden = true;
    const [radar, graph] = await Promise.all([ctx.api.get('/api/radar'), ctx.api.get('/api/graph')]);
    if (disposed) return;
    if (!radar.ok || !graph.ok) {
      if (radar.status === 401 || graph.status === 401) return;
      message.hidden = false;
      message.replaceChildren(emptyState({ art: 'load-error', title: 'The graph could not load', text: 'Check your connection and try again.', action: h('button', { type: 'button', class: 'btn btn-primary', onclick: load }, 'Try again') }));
      return;
    }
    if (!radar.data.length) {
      message.hidden = false;
      message.replaceChildren(emptyState({ art: 'no-events', title: 'No events yet', text: 'Import the case-study Sheet to see the graph.' }));
      return;
    }
    data = { events: radar.data, accountsByEvent: graph.data.accountsByEvent };
    draw();
  }

  let resizeTimer = 0;
  observer = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => data && draw(), 200);
  });
  observer.observe(stage);
  window.addEventListener('radar:reauth', load);
  load();
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    clearTimeout(resizeTimer);
    observer.disconnect();
    window.removeEventListener('radar:reauth', load);
  };
}
