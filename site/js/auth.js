// Session storage and Google sign-in. The token lives in memory and sessionStorage only.

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

function loadGoogleScript() {
  return new Promise((resolve, reject) => {
    if (globalThis.google?.accounts?.id) return resolve();
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google sign-in could not be loaded'));
    document.head.append(script);
  });
}

export async function mountGoogleButton(container, { config, api, onSignedIn, onError }) {
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
      if (result.ok) onSignedIn(result.data);
      else if (result.status === 403) onError('This Google account is not on the team list. Ask an admin to add it.');
      else if (result.stale) onError('Cannot reach the radar service. Check your connection and try again.');
      else onError('Sign-in could not be verified. Try again.');
    },
  });
  globalThis.google.accounts.id.renderButton(container, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' });
}
