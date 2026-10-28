// Only the configured site origin may read responses from the browser.
export function corsHeaders(origin, env) {
  if (!origin || origin !== env.ALLOWED_ORIGIN) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}
