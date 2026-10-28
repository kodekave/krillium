// Thin fetch wrapper: bearer token, stale detection, 401 hand-off. Never caches lead data.

export function createApi(config, { fetchImpl = (...a) => fetch(...a), getToken = () => null } = {}) {
  const base = String(config.apiBase ?? '').replace(/\/$/, '');
  const unauthorised = new Set();
  const staleHandlers = new Set();
  const freshHandlers = new Set();
  let isStale = false;

  async function request(method, path, body) {
    const headers = {};
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      if (!isStale) {
        isStale = true;
        staleHandlers.forEach((cb) => cb());
      }
      return { ok: false, stale: true };
    }
    if (isStale) {
      isStale = false;
      freshHandlers.forEach((cb) => cb());
    }
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      // empty or non-JSON body: fall through with an empty payload
    }
    if (res.status === 401) unauthorised.forEach((cb) => cb());
    if (res.ok) return { ok: true, status: res.status, data: payload.data };
    return { ok: false, status: res.status, error: payload.error, ...(payload.errors ? { errors: payload.errors } : {}) };
  }

  return {
    get: (path) => request('GET', path),
    put: (path, body) => request('PUT', path, body),
    post: (path, body) => request('POST', path, body),
    onUnauthorised: (cb) => unauthorised.add(cb),
    onStale: (cb) => staleHandlers.add(cb),
    onFresh: (cb) => freshHandlers.add(cb),
  };
}
