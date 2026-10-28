// Tiny element builders. Text is always set as text, never as HTML, so event data cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

function build(el, attrs, children) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const h = (tag, attrs, ...children) => build(document.createElement(tag), attrs, children);
export const s = (tag, attrs, ...children) => build(document.createElementNS(SVG_NS, tag), attrs, children);

// Links from the database must be plain web URLs: anything else (javascript:, data:) is dropped.
export const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
