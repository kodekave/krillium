// The dashboard's memory: small per-user settings saved through /api/prefs, with debounced writes.
const MAX_BYTES = 4096;

export function createPrefs(api, { delay = 600 } = {}) {
  let values = {};
  const timers = new Map();
  return {
    async load() {
      const result = await api.get('/api/prefs');
      values = result.ok && result.data ? { ...result.data } : {};
      return values;
    },
    get: (key) => (key in values ? values[key] : null),
    getJson(key) {
      const raw = this.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    set(key, value) {
      values[key] = value;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(async () => {
        timers.delete(key);
        if (new TextEncoder().encode(value).length > MAX_BYTES) return;
        await api.put('/api/prefs', { key, value });
      }, delay));
    },
    setJson(key, object) {
      this.set(key, JSON.stringify(object));
    },
  };
}
