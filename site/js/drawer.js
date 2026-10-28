// Event detail drawer: why attend, who is attached, sources, history, and the user's decision.
import { h, safeUrl } from './dom.js';
import { formatRange } from './format.js';
import { countUp } from './motion.js';

const STATUS_LABEL = { 'must-attend': 'Must-attend', consider: 'Consider', watch: 'Watch' };
const CHOICE_LABEL = { attend: 'Attend', watch: 'Watch', skip: 'Skip' };
const TIER_PILL = { A: 'must-attend', B: 'consider' };
const PERSONA = { economic_buyer: 'Economic buyer', champion: 'Champion', influencer: 'Influencer' };

const hostOf = (url) => {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
};

export function mountDrawer(ctx) {
  let opener = null;
  let current = null;
  let hideTimer = 0;
  const backdrop = h('div', { class: 'drawer-backdrop', hidden: true, onclick: () => close() });
  const panel = h('aside', { class: 'drawer glass-strong', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Event details', hidden: true, tabindex: '-1' });
  document.body.append(backdrop, panel);

  const onKey = (ev) => {
    if (ev.key === 'Escape') close();
    if (ev.key !== 'Tab') return;
    const items = [...panel.querySelectorAll('a[href], button:not([disabled]), textarea, input')];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  };

  function close() {
    panel.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    document.removeEventListener('keydown', onKey);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { panel.hidden = true; backdrop.hidden = true; }, 280);
    current = null;
    opener?.focus?.();
  }

  const closeBtn = () => h('button', { type: 'button', class: 'drawer-close', 'aria-label': 'Close details', onclick: close }, '×');

  async function open(id) {
    clearTimeout(hideTimer);
    opener = document.activeElement;
    current = id;
    panel.hidden = false;
    backdrop.hidden = false;
    panel.replaceChildren(closeBtn(), h('p', { class: 'muted' }, 'Loading…'));
    requestAnimationFrame(() => { panel.classList.add('is-open'); backdrop.classList.add('is-open'); });
    document.addEventListener('keydown', onKey);
    panel.querySelector('.drawer-close').focus();
    const result = await ctx.api.get(`/api/events/${encodeURIComponent(id)}`);
    if (current !== id) return;
    if (!result.ok) {
      panel.replaceChildren(closeBtn(), h('h2', {}, 'These details could not load'), h('p', { class: 'muted' }, result.status === 404 ? 'This event no longer exists.' : 'Check your connection and try again.'), h('button', { type: 'button', class: 'btn btn-primary', onclick: () => open(id) }, 'Try again'));
      return;
    }
    render(result.data);
    panel.querySelector('.drawer-close').focus();
  }

  function render(e) {
    const decision = h('div', { class: 'decision' });
    drawDecision(decision, e);
    const cockpit = ctx.config.cockpitUrl && safeUrl(ctx.config.cockpitUrl);
    const score = h('span', { class: 'num big' }, String(Math.round(e.priority)));
    countUp(score, Math.round(e.priority));
    panel.replaceChildren(
      closeBtn(),
      h('header', {}, h('span', { class: `pill pill-${e.status}` }, STATUS_LABEL[e.status]), h('h2', {}, e.name),
        h('p', { class: 'muted' }, [e.city, formatRange(e.startDate, e.endDate)].filter(Boolean).join(', ')),
        h('p', { class: 'drawer-score' }, score, h('span', { class: 'muted' }, ` priority, event score ${e.eventScore20} of 20`))),
      h('section', {}, h('h3', {}, 'Why attend'), h('ul', { class: 'plain' }, e.reasons.map((r) => h('li', {}, r))),
        e.vendorShare !== null ? h('p', { class: 'muted small' }, `${e.vendorCount} vendors or competitors seen, ${Math.round(e.vendorShare * 100)}% of companies listed.`) : null),
      h('section', {}, h('h3', {}, `Who is attached (${e.accounts.length})`),
        e.accounts.length ? h('table', { class: 'mini' }, h('tbody', {}, e.accounts.map((a) => h('tr', {},
          h('td', {}, h('strong', {}, a.company || 'Unknown company'), a.person ? h('div', { class: 'muted small' }, `${a.person}${a.title ? `, ${a.title}` : ''}`) : h('div', { class: 'muted small' }, 'Company only, no named person yet')),
          h('td', {}, a.tier ? h('span', { class: `pill pill-${TIER_PILL[a.tier] ?? 'watch'}` }, `Tier ${a.tier}`) : null, a.persona ? h('div', { class: 'muted small' }, PERSONA[a.persona] ?? a.persona) : null))))) : h('p', { class: 'muted' }, 'No ICP-matching people are public yet.')),
      h('section', {}, h('h3', {}, 'Sources'), h('ul', { class: 'plain' }, e.sources.filter((s) => safeUrl(s.url)).map((s) => h('li', {}, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, `${s.label}: ${hostOf(s.url)}`))))),
      e.history.length ? h('section', {}, h('h3', {}, 'History'), h('ul', { class: 'plain' }, e.history.map((x) => h('li', {}, h('span', { class: 'muted small' }, `${String(x.at).slice(0, 10)}  `), x.summary)))) : null,
      cockpit ? h('p', {}, h('a', { class: 'btn', href: cockpit, target: '_blank', rel: 'noopener noreferrer' }, 'Review leads in the cockpit')) : null,
      decision,
    );
  }

  function drawDecision(box, e) {
    let choice = e.myDecision?.choice ?? null;
    const reason = h('textarea', { rows: '2', 'aria-label': 'Reason', placeholder: 'Why? Required to skip.' }, e.myDecision?.reason ?? '');
    const status = h('p', { class: 'muted small', role: 'status' });
    const buttons = Object.entries(CHOICE_LABEL).map(([value, label]) => h('button', { type: 'button', class: 'seg', 'aria-pressed': String(choice === value), onclick: () => { choice = value; buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.choice === value))); } }, label));
    buttons.forEach((b, i) => { b.dataset.choice = Object.keys(CHOICE_LABEL)[i]; });
    const save = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
      if (!choice) { status.textContent = 'Pick attend, watch or skip first.'; return; }
      if (choice === 'skip' && !reason.value.trim()) { status.textContent = 'Add a reason to skip this event.'; return; }
      save.disabled = true;
      const res = await ctx.api.post('/api/decisions', { eventId: e.id, choice, reason: reason.value });
      save.disabled = false;
      status.textContent = res.ok ? `Saved: ${CHOICE_LABEL[choice].toLowerCase()}.` : res.stale ? 'Cannot reach the service. Your decision was not saved.' : `Not saved: ${res.error ?? 'try again'}.`;
    } }, 'Save decision');
    box.replaceChildren(h('h3', {}, 'Your decision'),
      e.myDecision ? h('p', { class: 'muted small' }, `Last saved: ${CHOICE_LABEL[e.myDecision.choice].toLowerCase()} on ${String(e.myDecision.at).slice(0, 10)}.`) : null,
      h('div', { class: 'seg-row', role: 'group', 'aria-label': 'Decision' }, buttons), reason, h('div', { class: 'row' }, save, status));
  }

  return { open, close };
}
