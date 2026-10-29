// Public values only. Secrets live in the Worker (wrangler secret), never here.
// On a developer's machine the page talks to the local Worker (npm run dev:worker), never the live one.
const local = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);

export default {
  apiBase: local ? 'http://localhost:8787' : 'https://gtm-radar-api.gtm-radar.workers.dev',
  googleClientId: '7387324361-t8ba6mbdthhr8vrgotmvivfr7vumu2ns.apps.googleusercontent.com',
  // Optional: link to the lead-review cockpit shown in the event drawer.
  cockpitUrl: '',
};
