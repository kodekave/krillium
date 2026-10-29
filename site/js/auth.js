// Session storage and Google sign-in. The token lives in memory and sessionStorage only.
import { signInOutcome } from './workspace-state.js';

const KEY = 'gtm-radar.session';

export function createSession(storage = globalThis.sessionStorage) {
  let current = null;
  try {
    current = JSON.parse(storage?.getItem(KEY) ?? 'null');
  } catch {
    current = null;
  }
  return {
    getToken: () => current?.token ?? null,
    getUser: () => current?.user ?? null,
    // The sign-in answer carries the workspace and whether this person is the operator. The Worker decides both on every
    // request; these only decide what the page shows.
    getWorkspace: () => current?.workspace ?? null,
    isOperator: () => Boolean(current?.operator),
    set(session) {
      current = session;
      try {
        storage?.setItem(KEY, JSON.stringify(session));
      } catch {
        // storage blocked: the in-memory session still works for this tab
      }
    },
    clear() {
      current = null;
      try {
        storage?.removeItem(KEY);
      } catch {
        // nothing to clear
      }
    },
  };
}

export const sessionEndedMessage = (hadSession) =>
  hadSession ? 'Your session ended. Sign in again; anything unsaved on this screen is still here.' : undefined;

let googleScript = null;
function loadGoogleScript() {
  if (globalThis.google?.accounts?.id) return Promise.resolve();
  googleScript ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      googleScript = null;
      script.remove();
      reject(new Error('Google sign-in could not be loaded'));
    };
    document.head.append(script);
  });
  return googleScript;
}

export async function mountGoogleButton(container, { config, api, onSignedIn, onPending, onError }) {
  if (!config.googleClientId) {
    onError('Google sign-in is not set up yet. Add the Google client ID to site/config.js.');
    return;
  }
  try {
    await loadGoogleScript();
  } catch (e) {
    onError(e.message);
    return;
  }
  globalThis.google.accounts.id.initialize({
    client_id: config.googleClientId,
    callback: async ({ credential }) => {
      const result = await api.post('/auth/google', { idToken: credential });
      const outcome = signInOutcome(result);
      // A 202 is "ok" to the api layer but is not a session: only a signed-in answer starts one.
      if (outcome.kind === 'signed-in') onSignedIn(result.data);
      else if (outcome.kind === 'pending' && onPending) onPending(outcome.message);
      else onError(outcome.message);
    },
  });
  globalThis.google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' });
}
