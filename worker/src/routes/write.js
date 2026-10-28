import { validateConfig } from '../../../site/js/shared/scoring.js';
import { error, json, readJson } from '../http.js';
import { getRankedEvents, saveConfig } from '../db.js';

const CONFIG_KEYS = ['weights', 'density', 'thresholds', 'persona', 'eventRole', 'contact', 'homeBases'];
const CHOICES = new Set(['attend', 'watch', 'skip']);
const PREF_KEY = /^[a-z0-9_.-]{1,64}$/;
const MAX_PREF_BYTES = 4096;

export async function putIcp({ request, env, user }) {
  const body = await readJson(request);
  const cfg = Object.fromEntries(CONFIG_KEYS.filter((k) => k in body).map((k) => [k, body[k]]));
  const { ok, errors } = validateConfig(cfg);
  if (!ok) return error(400, 'invalid config', { errors });
  return json({ version: await saveConfig(env.DB, cfg, user.email) });
}

export async function postDecision({ request, env, user }) {
  const body = await readJson(request);
  if (!CHOICES.has(body.choice)) return error(400, 'choice must be attend, watch or skip');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (body.choice === 'skip' && !reason) return error(400, 'a reason is required to skip');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : null;

  const { cfg, events } = await getRankedEvents(env.DB);
  const event = events.find((e) => e.id === body.eventId);
  if (!event) return error(404, 'event not found');

  const result = await env.DB.prepare(
    `INSERT INTO decisions (event_id, user, choice, reason, note, score_snapshot, config_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(event.id, user.email, body.choice, reason || null, note, event.priority, cfg.version)
    .run();
  return json({ id: result.meta.last_row_id }, 201);
}

export async function getPrefs({ env, user }) {
  const { results } = await env.DB.prepare('SELECT key, value FROM prefs WHERE user = ?').bind(user.email).all();
  return json(Object.fromEntries(results.map((r) => [r.key, r.value])));
}

export async function putPref({ request, env, user }) {
  const { key, value } = await readJson(request);
  if (typeof key !== 'string' || !PREF_KEY.test(key)) return error(400, 'invalid key');
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > MAX_PREF_BYTES) {
    return error(400, 'value must be a string of at most 4 KB');
  }
  await env.DB.prepare(
    'INSERT INTO prefs (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) DO UPDATE SET value = excluded.value',
  )
    .bind(user.email, key, value)
    .run();
  return json({ key });
}
