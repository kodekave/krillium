export function json(data, status = 200) {
  return new Response(JSON.stringify({ data, generatedAt: new Date().toISOString() }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function error(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
