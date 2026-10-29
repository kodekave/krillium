// Ask bar (Cmd or Ctrl + K): plain-English questions answered by the fixed /api/ask intents.
import { h } from './dom.js';
import { formatRange } from './format.js';
import { parseAsk } from './ask-parse.js';

const SUGGESTIONS = ['Which events have the most Tier A buyers?', 'What changed this week?', 'Events in the next 60 days', 'Find events about shared services in Europe'];
const STATUS_LABEL = { 'must-attend': 'Must-attend', consider: 'Consider', watch: 'Watch' };

export function mountAsk(ctx) {
  let opener = null;
  const input = h('input', { type: 'text', placeholder: 'Ask about events, for example: events in March', 'aria-label': 'Ask the radar', autocomplete: 'off' });
  const results = h('div', { class: 'ask-results', role: 'status' });
  const form = h('form', { class: 'ask-form', onsubmit: (ev) => { ev.preventDefault(); run(input.value); } }, input);
  const panel = h('div', { class: 'ask glass-strong', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ask the radar', hidden: true },
    form, h('div', { class: 'ask-chips' }, SUGGESTIONS.map((q) => h('button', { type: 'button', class: 'chip', onclick: () => { input.value = q; run(q); } }, q))), results);
  const backdrop = h('div', { class: 'drawer-backdrop', hidden: true, onclick: () => close() });
  document.body.append(backdrop, panel);

  const onKey = (ev) => { if (ev.key === 'Escape') close(); };

  function open() {
    if (!panel.hidden) return;
    opener = document.activeElement;
    panel.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add('is-open'));
    document.addEventListener('keydown', onKey);
    input.focus();
    input.select();
  }

  function close() {
    panel.hidden = true;
    backdrop.classList.remove('is-open');
    backdrop.hidden = true;
    document.removeEventListener('keydown', onKey);
    opener?.focus?.();
  }

  const row = (id, title, sub, right) => h('li', {}, h('button', { type: 'button', class: 'ask-row', onclick: () => { close(); ctx.openEvent(id); } },
    h('span', { class: 'ask-main' }, h('span', {}, title), h('span', { class: 'muted small' }, sub)), right));

  async function run(text) {
    const parsed = parseAsk(text);
    if (!parsed) {
      results.replaceChildren(h('p', { class: 'muted' }, 'I can answer questions about Tier A buyers, what changed this week, and events in a month, quarter or the next few weeks. Start with find to search for new events. Try one of the suggestions.'));
      return;
    }
    if (parsed.intent === 'find_events') {
      close();
      location.hash = `#/find?q=${encodeURIComponent(parsed.params.query)}`;
      return;
    }
    results.replaceChildren(h('p', { class: 'muted' }, 'Looking…'));
    const query = new URLSearchParams({ intent: parsed.intent, ...parsed.params });
    const res = await ctx.api.get(`/api/ask?${query}`);
    if (!res.ok) {
      results.replaceChildren(h('p', { class: 'muted' }, res.stale ? 'Cannot reach the service. Try again when you are back online.' : `That did not work: ${res.error ?? 'try again'}.`));
      return;
    }
    const rows = res.data.rows;
    if (!rows.length) {
      results.replaceChildren(h('p', { class: 'muted' }, 'Nothing matches that question yet.'));
      return;
    }
    const range = parsed.params.from ? ` between ${formatRange(parsed.params.from, parsed.params.to)}` : '';
    results.replaceChildren(
      h('p', { class: 'muted small' }, `${rows.length} ${rows.length === 1 ? 'result' : 'results'}${range}`),
      h('ul', { class: 'plain' }, rows.map((r) => {
        if (parsed.intent === 'top_events_in_range') return row(r.id, r.name, [r.city, formatRange(r.startDate, r.endDate)].filter(Boolean).join(', '), h('span', { class: `pill pill-${r.status}` }, STATUS_LABEL[r.status]));
        if (parsed.intent === 'tier_a_by_event') return row(r.id, r.name, `${r.tierA} Tier A ${r.tierA === 1 ? 'person' : 'people'}`, h('span', { class: 'num muted' }, String(Math.round(r.priority))));
        return row(r.eventId, r.eventName ?? r.eventId, r.summary ?? r.kind, h('span', { class: 'muted small' }, String(r.at).slice(0, 10)));
      })));
  }

  return { open, close, toggle: () => (panel.hidden ? open() : close()) };
}
