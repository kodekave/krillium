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

export async function readJson(request) {
  try {
    const body = await request.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // fall through to the 400 below
  }
  throw error(400, 'body must be a JSON object');
}
