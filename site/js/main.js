import config from '../config.js';
import { createApi } from './api.js';
import { createSession, mountGoogleButton } from './auth.js';
import { mountDrawer } from './drawer.js';
import { createPrefs } from './prefs.js';
import { createRouter } from './router.js';

const ROUTES = {
  radar: () => import('./views/radar.js'),
  events: () => import('./views/events.js'),
  icp: () => import('./views/icp.js'),
  graph: () => import('./views/graph.js'),
  feed: () => import('./views/feed.js'),
};

const NAV = [
  { name: 'radar', label: 'Radar', icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-6"/>' },
  { name: 'events', label: 'Events', icon: '<path d="M4 6h16M4 12h16M4 18h10"/>' },
  { name: 'icp', label: 'ICP brain', icon: '<path d="M5 8h9M18 8h1M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>' },
  { name: 'graph', label: 'Graph', icon: '<circle cx="6" cy="7" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="13" cy="17" r="2.4"/><path d="M7.7 8l4 7.2M16.4 7.4l-2.6 7.8M8 7h8"/>' },
  { name: 'feed', label: 'Feed', icon: '<path d="M5 6h14M5 11h14M5 16h8"/><circle cx="18" cy="17" r="1.6"/>' },
];

const $ = (id) => document.getElementById(id);
const svg = (paths) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const prefersReducedMotion = () =>
  Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

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

function renderRail() {
  $('rail').innerHTML = `
    <a class="rail-mark" href="#/radar" aria-label="GTM Radar home">
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"><circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".5"/><circle cx="16" cy="16" r="7" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".75"/><circle cx="16" cy="16" r="2.4" fill="var(--amber)"/></svg>
    </a>
    <ul class="rail-list">${NAV.map((n) => `<li><a class="rail-link" data-route="${n.name}" href="#/${n.name}" aria-label="${n.label}" title="${n.label}">${svg(n.icon)}<span class="rail-label">${n.label}</span></a></li>`).join('')}</ul>
    <div class="rail-foot">
      <button class="rail-link" id="theme-toggle" type="button" aria-label="Switch light and dark theme" title="Theme">${svg('<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>')}</button>
      <button class="rail-link" id="sign-out" type="button" aria-label="Sign out" title="Sign out">${svg('<path d="M9 5H6a1 1 0 00-1 1v12a1 1 0 001 1h3M14 8l4 4-4 4M18 12H9"/>')}</button>
    </div>`;
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

function setActive(name) {
  document.querySelectorAll('.rail-link[data-route]').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function showSignIn(message) {
  const overlay = $('signin');
  overlay.hidden = false;
  const error = $('signin-error');
  error.hidden = !message;
  error.textContent = message ?? '';
  const button = $('signin-button');
  button.replaceChildren();
  mountGoogleButton(button, {
    config,
    api,
    onSignedIn(data) {
      session.set(data);
      overlay.hidden = true;
      prefs.load().then(() => prefs.get('theme') && applyTheme(prefs.get('theme')));
      window.dispatchEvent(new CustomEvent('radar:reauth'));
    },
    onError(text) {
      error.hidden = false;
      error.textContent = text;
    },
  });
}

api.onUnauthorised(() => {
  session.clear();
  showSignIn('Your session ended. Sign in again; anything unsaved on this screen is still here.');
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
if (session.getToken()) {
  await prefs.load();
  if (prefs.get('theme')) applyTheme(prefs.get('theme'));
}
const router = createRouter({ root: $('main'), routes: ROUTES, ctx, onRoute: setActive });
router.start();
if (!session.getToken()) showSignIn();
