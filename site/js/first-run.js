// The card a new, empty workspace sees on Radar and Events instead of an empty table: three things to do, in any order.
import { h } from './dom.js';

export const FIRST_RUN_STEPS = [
  {
    id: 'sectors', title: 'Set your sectors',
    text: 'Choose the kinds of event and buyer you care about. Five starter sectors are ready to edit.',
    href: '#/icp', label: 'Open the ICP brain',
  },
  {
    id: 'samples', title: 'Load the sample events',
    text: 'Ten public events to look around with. They have no people or companies attached.',
    label: 'Load sample events',
  },
  {
    id: 'find', title: 'Find events',
    text: 'Search the web and event lists for events that fit your sectors.',
    href: '#/find', label: 'Find events',
  },
];

// Asks the Worker to add the sample events to this workspace and says, in plain words, what happened.
export async function loadSamples(api) {
  const res = await api.post('/api/workspace/samples');
  if (res.ok) {
    const added = res.data?.added ?? 0;
    return { ok: true, added, message: added ? `Loaded ${added} sample ${added === 1 ? 'event' : 'events'}.` : 'The sample events are already loaded.' };
  }
  if (res.stale) return { ok: false, message: 'Cannot reach the radar service. Check your connection and try again.' };
  if (res.status === 403) return { ok: false, message: 'Only an admin of this workspace can load the sample events.' };
  return { ok: false, message: 'The sample events could not be loaded. Try again.' };
}

export function firstRunCard(ctx, { onLoaded = () => {} } = {}) {
  const status = h('p', { class: 'muted small', role: 'status' });
  async function load(button) {
    button.disabled = true;
    status.textContent = 'Loading the sample events…';
    const result = await loadSamples(ctx.api);
    status.textContent = result.message;
    if (result.ok) onLoaded();
    else button.disabled = false;
  }
  return h('section', { class: 'first-run glass' },
    h('h2', {}, 'Your workspace is empty'),
    h('p', { class: 'muted' }, 'Three things to get going. Do them in any order.'),
    h('ul', { class: 'first-run-steps' }, FIRST_RUN_STEPS.map((step) => h('li', {},
      h('div', {}, h('strong', {}, step.title), h('p', { class: 'muted small' }, step.text)),
      step.href
        ? h('a', { class: 'btn', href: step.href }, step.label)
        : h('button', { type: 'button', class: 'btn btn-primary', onclick: (ev) => load(ev.currentTarget) }, step.label)))),
    status);
}
