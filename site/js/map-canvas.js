// SVG world map: dotted land, arcs from the home bases, status-coloured pins. Pins keep a constant
// on-screen size at every zoom because each one is drawn in pixel units inside a scaled group.
import { WORLD, arcPath, fitView, nearestBase, pinRadius, project } from './map-geometry.js';
import { s } from './dom.js';

const LAND_DOT_PX = 4;
const PRESET_BOXES = {
  world: [[-170, 72], [190, -52]],
  europe: [[-14, 62], [34, 34]],
  us: [[-128, 50], [-64, 22]],
};

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export async function createMap(container, { bases, reducedMotion, onSelect, onHover }) {
  const land = await (await fetch(new URL('../data/land-dots.json', import.meta.url))).json();
  const svg = s('svg', { class: 'map-svg', role: 'group', 'aria-label': 'Map of upcoming events' });
  const landPath = s('path', { class: 'land' });
  const arcLayer = s('g', { class: 'arcs' });
  const baseLayer = s('g', { class: 'bases' });
  const cityLayer = s('g', { class: 'cities' });
  const pinLayer = s('g', { class: 'pins' });
  svg.append(landPath, arcLayer, baseLayer, cityLayer, pinLayer);
  container.append(svg);

  landPath.setAttribute('d', Array.from({ length: land.dots.length / 2 }, (_, i) => `M${land.dots[2 * i] * land.step} ${land.dots[2 * i + 1] * land.step}h0`).join(''));

  let view = { x: 0, y: 0, w: WORLD.width, h: WORLD.height };
  const first = container.getBoundingClientRect();
  let width = Math.max(1, first.width);
  let height = Math.max(1, first.height);
  let current = null;
  let pins = [];
  let cities = [];
  let animation = 0;
  let insets = { left: 0, right: 0, top: 0, bottom: 0 };
  const baseNodes = bases.map((b) => {
    const [x, y] = project(b.lat, b.lon, WORLD);
    const node = s('g', { class: 'base' }, s('title', {}, `Home base: ${b.name}`), s('rect', { class: 'base-mark', x: -4, y: -4, width: 8, height: 8, transform: 'rotate(45)' }));
    baseLayer.append(node);
    return { node, x, y };
  });

  const unit = () => view.w / width;

  function apply() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const u = unit();
    // Dots grow when zoomed in so the land stays readable between grid points.
    const dot = Math.min(18, Math.max(LAND_DOT_PX, (0.5 * land.step) / u));
    landPath.setAttribute('stroke-width', String(dot * u));
    svg.style.setProperty('--arc-w', String(1.3 * u));
    for (const b of baseNodes) b.node.setAttribute('transform', `translate(${b.x} ${b.y}) scale(${u})`);
    for (const p of pins) p.node.setAttribute('transform', `translate(${p.x} ${p.y}) scale(${u})`);
    for (const c of cities) c.node.setAttribute('transform', `translate(${c.x} ${c.y}) scale(${u})`);
    hideCollidingLabels(u);
  }

  // Keep the label of the highest-priority location when two labels would overlap on screen.
  function hideCollidingLabels(u) {
    const placed = [];
    const ranked = [...cities].sort((a, b) => b.top - a.top);
    for (const c of ranked) {
      const sx = (c.x - view.x) / u;
      const sy = (c.y - view.y) / u + c.offset;
      const box = { x0: sx - c.chars * 3.6, x1: sx + c.chars * 3.6, y0: sy - 11, y1: sy + 4 };
      const clash = placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
      c.node.style.display = clash ? 'none' : '';
      if (!clash) placed.push(box);
    }
  }

  // Fit points into the area not covered by floating panels, then widen the view to the full container.
  function fitInside(points, padding) {
    const ew = Math.max(1, width - insets.left - insets.right);
    const eh = Math.max(1, height - insets.top - insets.bottom);
    const v = fitView(points, ew / eh, padding);
    const k = v.w / ew;
    return { x: v.x - insets.left * k, y: v.y - insets.top * k, w: width * k, h: height * k };
  }

  function boxView(name) {
    return fitInside(PRESET_BOXES[name].map(([lon, lat]) => project(lat, lon, WORLD)), 6);
  }

  function eventsView() {
    const pts = pins.filter((p) => !p.node.classList.contains('is-dim')).map((p) => [p.x, p.y]);
    if (!pts.length) return boxView('world');
    const v = fitInside(pts, 90);
    return v.w > WORLD.width * 1.15 ? boxView('world') : v;
  }

  function goTo(target, animate = true) {
    cancelAnimationFrame(animation);
    if (!animate || reducedMotion()) {
      view = target;
      apply();
      return;
    }
    const from = { ...view };
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 750);
      const k = ease(t);
      view = { x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k, w: from.w + (target.w - from.w) * k, h: from.h + (target.h - from.h) * k };
      apply();
      if (t < 1) animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
  }

  const viewFor = (name) => (name === 'events' ? eventsView() : boxView(name));

  const resize = new ResizeObserver(([entry]) => {
    width = Math.max(1, entry.contentRect.width);
    height = Math.max(1, entry.contentRect.height);
    if (current) {
      view = viewFor(current);
    } else {
      const center = { x: view.x + view.w / 2, y: view.y + view.h / 2 };
      const w = view.h * (width / height);
      view = { x: center.x - w / 2, y: view.y, w, h: view.h };
    }
    apply();
  });
  resize.observe(container);

  function pinRect(pin) {
    const box = pin.node.getBoundingClientRect();
    const host = container.getBoundingClientRect();
    return { x: box.left - host.left + box.width / 2, y: box.top - host.top + box.height / 2 };
  }

  function setEvents(events) {
    pinLayer.replaceChildren();
    arcLayer.replaceChildren();
    cityLayer.replaceChildren();
    pins = [];
    cities = [];
    const groups = new Map();
    for (const e of events) {
      const at = project(e.lat, e.lon, WORLD);
      if (!at) continue;
      const key = `${e.lat},${e.lon}`;
      groups.set(key, [...(groups.get(key) ?? []), { e, at }]);
    }
    let order = 0;
    for (const members of groups.values()) {
      const [x, y] = members[0].at;
      const fan = members.length > 1 ? 10 + 3 * members.length : 0;
      const label = s('text', { class: 'city-label', x: 0, y: fan + pinRadius(100) + 15, 'text-anchor': 'middle' }, members[0].e.city ?? '');
      const cityNode = s('g', { class: 'city' }, label);
      cityLayer.append(cityNode);
      cities.push({ node: cityNode, x, y, offset: fan + pinRadius(100) + 15, chars: (members[0].e.city ?? '').length, top: Math.max(...members.map((m) => m.e.priority)) });
      members.forEach(({ e }, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / members.length;
        const dx = fan * Math.cos(angle);
        const dy = fan * Math.sin(angle);
        const r = pinRadius(e.priority);
        const aria = `${e.name}, ${e.status}, priority ${Math.round(e.priority)}`;
        const node = s('g', { class: `pin pin-${e.status}`, tabindex: 0, role: 'button', 'aria-label': aria, 'data-id': e.id },
          e.status === 'must-attend' ? s('circle', { class: 'pin-pulse', cx: dx, cy: dy, r }) : null,
          s('circle', { class: 'pin-ring', cx: dx, cy: dy, r: r + 4 }),
          s('circle', { class: 'pin-dot', cx: dx, cy: dy, r }),
        );
        const pin = { id: e.id, event: e, x, y, node };
        node.addEventListener('mouseenter', () => onHover(e, pinRect(pin)));
        node.addEventListener('focus', () => onHover(e, pinRect(pin)));
        node.addEventListener('mouseleave', () => onHover(null));
        node.addEventListener('blur', () => onHover(null));
        node.addEventListener('click', () => onSelect(e.id));
        node.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            onSelect(e.id);
          }
        });
        pinLayer.append(node);
        pins.push(pin);

        const base = nearestBase(e, bases);
        if (base) {
          const [bx, by] = project(base.lat, base.lon, WORLD);
          const arc = s('path', { class: 'arc', d: arcPath([bx, by], [x, y]), pathLength: 1, 'data-id': e.id, style: `animation-delay:${0.25 + order * 0.12}s` });
          arcLayer.append(arc);
          pin.arc = arc;
        }
        order += 1;
      });
    }
    apply();
  }

  return {
    setEvents,
    setInsets(next) {
      insets = { left: 0, right: 0, top: 0, bottom: 0, ...next };
    },
    setWindow(visible) {
      for (const p of pins) {
        const on = visible.has(p.id);
        p.node.classList.toggle('is-dim', !on);
        p.arc?.classList.toggle('is-dim', !on);
      }
    },
    highlight(id) {
      for (const p of pins) {
        const on = p.id === id;
        p.node.classList.toggle('is-active', on);
        p.arc?.classList.toggle('is-active', on);
      }
    },
    setView(name, animate = true) {
      current = name;
      goTo(viewFor(name), animate);
    },
    destroy() {
      cancelAnimationFrame(animation);
      resize.disconnect();
      svg.remove();
    },
  };
}
