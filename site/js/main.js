import config from '../config.js';
import { createApi } from './api.js';
import { createSession, mountGoogleButton, sessionEndedMessage } from './auth.js';
import { mountAsk } from './ask.js';
import { markElement } from './brand.js';
import { mountDrawer } from './drawer.js';
import { prefersReducedMotion } from './motion.js';
import { createPrefs } from './prefs.js';
import { createRouter } from './router.js';

const ROUTES = {
  radar: () => import('./views/radar.js'),
  events: () => import('./views/events.js'),
  find: () => import('./views/find.js'),
  icp: () => import('./views/icp.js'),
  graph: () => import('./views/graph.js'),
  feed: () => import('./views/feed.js'),
};

const NAV = [
  { name: 'radar', label: 'Radar', icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-6"/>' },
  { name: 'events', label: 'Events', icon: '<path d="M4 6h16M4 12h16M4 18h10"/>' },
  { name: 'find', label: 'Find events', icon: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M11 8.5v5M8.5 11h5"/>' },
  { name: 'icp', label: 'ICP brain', icon: '<path d="M5 8h9M18 8h1M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>' },
  { name: 'graph', label: 'Graph', icon: '<circle cx="6" cy="7" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="13" cy="17" r="2.4"/><path d="M7.7 8l4 7.2M16.4 7.4l-2.6 7.8M8 7h8"/>' },
  { name: 'feed', label: 'Feed', icon: '<path d="M5 6h14M5 11h14M5 16h8"/><circle cx="18" cy="17" r="1.6"/>' },
];

const $ = (id) => document.getElementById(id);
const svg = (paths) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

function readTheme() {
  try {
    return localStorage.getItem('gtm-radar.theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('gtm-radar.theme', theme);
  } catch {
    // a blocked store only means the choice is not remembered
  }
}

const session = createSession();
const api = createApi(config, { getToken: session.getToken });
const prefs = createPrefs(api);
const ctx = { api, config, session, prefs, openEvent: () => {}, prefersReducedMotion };
ctx.openEvent = mountDrawer(ctx).open;
const ask = mountAsk(ctx);
addEventListener('keydown', (ev) => {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    if (session.getToken()) ask.toggle();
  }
});

function renderRail() {
  $('rail').innerHTML = `
    <a class="rail-mark" href="#/radar" aria-label="Krillium home"></a>
    <ul class="rail-list">${NAV.map((n) => `<li><a class="rail-link" data-route="${n.name}" href="#/${n.name}" aria-label="${n.label}" title="${n.label}">${svg(n.icon)}<span class="rail-label">${n.label}</span>${n.name === 'find' ? '<span class="rail-badge" id="inbox-badge" hidden></span>' : ''}</a></li>`).join('')}</ul>
    <div class="rail-foot">
      <button class="rail-link" id="ask-open" type="button" aria-label="Ask the radar" title="Ask (Cmd or Ctrl K)">${svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>')}</button>
      <button class="rail-link" id="theme-toggle" type="button" aria-label="Switch light and dark theme" title="Theme">${svg('<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>')}</button>
      <button class="rail-link" id="sign-out" type="button" aria-label="Sign out" title="Sign out">${svg('<path d="M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h3M14 8l4 4-4 4M18 12H9"/>')}</button>
    </div>`;
  $('rail').querySelector('.rail-mark').append(markElement({ size: 30 }));
  $('ask-open').addEventListener('click', () => ask.open());
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    prefs.set('theme', next);
  });
  $('sign-out').addEventListener('click', () => {
    session.clear();
    showSignIn();
  });
}

// The number of events waiting for review, shown on the Find item. The Find view reports changes with a window event.
function setInboxBadge(count) {
  const badge = $('inbox-badge');
  const link = document.querySelector('.rail-link[data-route="find"]');
  if (!badge || !link) return;
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count);
  const label = count ? `Find events, ${count} waiting for review` : 'Find events';
  link.setAttribute('aria-label', label);
  link.title = label;
}

async function refreshInbox() {
  const res = await api.get('/api/inbox');
  if (res.ok) setInboxBadge(res.data.length);
}

addEventListener('radar:inbox', (ev) => setInboxBadge(ev.detail?.count ?? 0));

function setActive(name) {
  document.querySelectorAll('.rail-link[data-route]').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

let buttonMounted = false;
function showSignIn(message) {
  const overlay = $('signin');
  overlay.hidden = false;
  const error = $('signin-error');
  if (message !== undefined) {
    error.hidden = !message;
    error.textContent = message;
  }
  if (buttonMounted) return;
  buttonMounted = true;
  mountGoogleButton($('signin-button'), {
    config,
    api,
    onSignedIn(data) {
      session.set(data);
      overlay.hidden = true;
      error.hidden = true;
      // Load the saved preferences, then re-render the current screen so it starts with them.
      prefs.load().then(() => {
        if (prefs.get('theme')) applyTheme(prefs.get('theme'));
        router.start();
        refreshInbox();
      });
    },
    onError(text) {
      buttonMounted = false;
      error.hidden = false;
      error.textContent = text;
    },
  });
}

api.onUnauthorised(() => {
  const hadSession = Boolean(session.getToken());
  session.clear();
  showSignIn(sessionEndedMessage(hadSession));
});
api.onStale(() => {
  const banner = $('stale');
  banner.hidden = false;
  banner.textContent = `Cannot reach the radar service. Showing what was loaded at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
});
api.onFresh(() => {
  $('stale').hidden = true;
});

applyTheme(readTheme());
renderRail();
$('signin-mark').append(markElement({ size: 40 }));
document.querySelector('.skip-link')?.addEventListener('click', (ev) => {
  ev.preventDefault();
  $('main').focus();
});
if (session.getToken()) {
  await prefs.load();
  if (prefs.get('theme')) applyTheme(prefs.get('theme'));
}
const router = createRouter({ root: $('main'), routes: ROUTES, ctx, onRoute: setActive });
router.start();
if (session.getToken()) refreshInbox();
else showSignIn();
