// One consistent block for every empty, error and no-result moment: drawing, a plain title, one line of direction, an optional action.
import { h } from './dom.js';
import { artElement } from './art.js';

export function emptyState({ art, title, text = null, action = null }) {
  return h('div', { class: 'empty-state' }, artElement(art), h('strong', {}, title), text ? h('p', { class: 'muted' }, text) : null, action);
}
