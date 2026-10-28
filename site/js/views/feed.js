import { h, safeUrl } from '../dom.js';
import { daysUntil, formatRange } from '../format.js';

const KIND_LABEL = { imported: 'Imported', lineup: 'Lineup', dates: 'Dates', new_event: 'New event' };
const STATUS_LABEL = { 'must-attend': 'Must-attend', consider: 'Consider', watch: 'Watch' };
const COMING_UP_DAYS = 60;

export function mount(root, ctx) {
  let disposed = false;
  const comingUp = h('section', { class: 'feed-block' });
  const changes = h('section', { class: 'feed-block' });
  root.append(h('section', { class: 'view' }, h('header', {}, h('h1', {}, 'Feed'), h('p', { class: 'muted' }, 'What is coming up, and what changed on the event pages we watch.')), comingUp, changes));

  const link = (id, name) => h('button', { type: 'button', class: 'link-btn', onclick: () => ctx.openEvent(id) }, name);

  async function load() {
    const [radar, feed] = await Promise.all([ctx.api.get('/api/radar'), ctx.api.get('/api/feed')]);
    if (disposed) return;
    if (!radar.ok || !feed.ok) {
      if (radar.status === 401 || feed.status === 401) return;
      comingUp.replaceChildren(h('div', { class: 'empty' }, h('strong', {}, 'The feed could not load'), h('button', { type: 'button', class: 'btn btn-primary', onclick: load }, 'Try again')));
      changes.replaceChildren();
      return;
    }
    const soon = radar.data
      .map((e) => ({ e, d: daysUntil(e.startDate) }))
      .filter((x) => x.d !== null && x.d >= 0 && x.d <= COMING_UP_DAYS)
      .sort((a, b) => a.d - b.d);
    comingUp.replaceChildren(h('h2', {}, `Coming up in the next ${COMING_UP_DAYS} days`),
      soon.length ? h('ul', { class: 'feed-list' }, soon.map(({ e, d }) => h('li', {},
        h('span', { class: 'num feed-when' }, d === 0 ? 'Today' : `${d}d`),
        h('span', { class: 'feed-body' }, link(e.id, e.name), h('span', { class: 'muted small' }, [e.city, formatRange(e.startDate, e.endDate)].filter(Boolean).join(', '))),
        h('span', { class: `pill pill-${e.status}` }, STATUS_LABEL[e.status])))) : h('p', { class: 'muted' }, 'No events start in this window.'));
    changes.replaceChildren(h('h2', {}, 'What changed'),
      feed.data.length ? h('ul', { class: 'feed-list' }, feed.data.map((c) => h('li', {},
        h('span', { class: 'muted small feed-when' }, String(c.at).slice(0, 10)),
        h('span', { class: 'feed-body' }, c.eventId ? link(c.eventId, c.eventName ?? c.eventId) : null, h('span', {}, c.summary ?? c.kind), safeUrl(c.sourceUrl) ? h('a', { class: 'small', href: c.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Source') : null),
        h('span', { class: 'pill pill-watch' }, KIND_LABEL[c.kind] ?? c.kind)))) : h('div', { class: 'empty' }, h('strong', {}, 'Nothing has changed yet'), h('p', { class: 'muted' }, 'When an event page changes, it shows up here with its source.')));
  }

  window.addEventListener('radar:reauth', load);
  load();
  return () => {
    disposed = true;
    window.removeEventListener('radar:reauth', load);
  };
}
