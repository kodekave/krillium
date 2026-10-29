import { validateConfig } from '../../../site/js/shared/scoring.js';
import { error, json, readJson } from '../http.js';
import { getActiveConfig, getRankedEvents, saveConfig } from '../db.js';
import { remember } from '../memory.js';

const CONFIG_KEYS = ['weights', 'density', 'thresholds', 'persona', 'eventRole', 'contact', 'homeBases'];
const CHOICES = new Set(['attend', 'watch', 'skip']);
const PREF_KEY = /^[a-z0-9_.-]{1,64}$/;
const MAX_PREF_BYTES = 4096;

export async function putIcp({ request, env, user }) {
  const body = await readJson(request);
  const cfg = Object.fromEntries(CONFIG_KEYS.filter((k) => k in body).map((k) => [k, body[k]]));
  const { ok, errors } = validateConfig(cfg);
  if (!ok) return error(400, 'invalid config', { errors });
  const current = await getActiveConfig(env.DB, user.workspaceId);
  const version = await saveConfig(env.DB, user.workspaceId, cfg, user.email);
  const changed = CONFIG_KEYS.filter((k) => k in cfg && JSON.stringify(cfg[k]) !== JSON.stringify(current[k]));
  await remember(env.DB, user.workspaceId, [{ actor: user.email, kind: 'icp.saved', subject: version, detail: { version, changed } }]);
  return json({ version });
}

export async function postDecision({ request, env, user }) {
  const body = await readJson(request);
  if (!CHOICES.has(body.choice)) return error(400, 'choice must be attend, watch or skip');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (body.choice === 'skip' && !reason) return error(400, 'a reason is required to skip');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : null;

  const { cfg, events } = await getRankedEvents(env.DB, user.workspaceId);
  const event = events.find((e) => e.id === body.eventId);
  if (!event) return error(404, 'event not found');

  const result = await env.DB.prepare(
    `INSERT INTO decisions (workspace_id, event_id, user, choice, reason, note, score_snapshot, config_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(user.workspaceId, event.id, user.email, body.choice, reason || null, note, event.priority, cfg.version)
    .run();
  // The note is free text and may name a person, so memory keeps only the choice, the reason and the event's facts.
  await remember(env.DB, user.workspaceId, [{
    actor: user.email, kind: 'event.decision', subject: event.id,
    detail: {
      choice: body.choice, reason: reason || null, name: event.name, organiser: event.organiser, city: event.city,
      country: event.country, sectors: event.sectors, priority: event.priority, icpVersion: cfg.version,
    },
  }]);
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
