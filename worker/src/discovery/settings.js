// Discovery settings: spend caps, search limits, model prices, topics and the pause switch.
// Stored as JSON values in the settings table; anything not stored falls back to DEFAULT_SETTINGS.

export const DEFAULT_SETTINGS = Object.freeze({
  paused: false,
  runCapUsd: 0.5,
  dayCapUsd: 2,
  maxSearches: 12,
  maxPages: 120,
  // Assumed Haiku-class prices in USD per million tokens. Confirm against current Anthropic pricing.
  priceInPerMtok: 1,
  priceOutPerMtok: 5,
  topics: Object.freeze(['procure to pay', 'order to cash', 'shared services', 'ERP', 'finance automation', 'supply chain', 'distribution']),
});

const MONEY_AND_PRICES = ['runCapUsd', 'dayCapUsd', 'priceInPerMtok', 'priceOutPerMtok'];
const COUNTS = { maxSearches: 40, maxPages: 1000 };
const MAX_TOPICS = 8;
const MAX_TOPIC_LENGTH = 60;

export class SettingsError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'SettingsError';
    this.errors = errors;
  }
}

export function validateSettings(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: ['settings must be an object'] };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
      errors.push(`${key} is not a setting`);
    } else if (key === 'paused') {
      if (typeof value !== 'boolean') errors.push('paused must be true or false');
    } else if (MONEY_AND_PRICES.includes(key)) {
      if (!Number.isFinite(value) || value < 0) errors.push(`${key} must be a number of 0 or more`);
    } else if (key in COUNTS) {
      if (!Number.isInteger(value) || value < 1 || value > COUNTS[key]) errors.push(`${key} must be a whole number from 1 to ${COUNTS[key]}`);
    } else if (key === 'topics') {
      const clean = Array.isArray(value) ? value.map((t) => (typeof t === 'string' ? t.trim() : null)) : null;
      if (!clean || clean.length > MAX_TOPICS || clean.some((t) => !t || t.length > MAX_TOPIC_LENGTH)) {
        errors.push(`topics must be a list of at most ${MAX_TOPICS} phrases of 1 to ${MAX_TOPIC_LENGTH} characters`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const stored = {};
  for (const row of results) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, row.key)) continue;
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // an unreadable stored value falls back to the default
    }
  }
  return { ...DEFAULT_SETTINGS, ...stored, topics: [...(stored.topics ?? DEFAULT_SETTINGS.topics)] };
}

export async function putSettings(db, patch) {
  const { ok, errors } = validateSettings(patch);
  if (!ok) throw new SettingsError(errors);
  const clean = { ...patch };
  if (clean.topics) clean.topics = clean.topics.map((t) => t.trim());
  const writes = Object.entries(clean).map(([key, value]) =>
    db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .bind(key, JSON.stringify(value)),
  );
  if (writes.length) await db.batch(writes);
  return getSettings(db);
}

// Model spend so far today (UTC), across every run, for the daily cap.
export async function daySpend(db, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await db.prepare('SELECT COALESCE(SUM(model_spend), 0) AS spend FROM search_runs WHERE date(started) = ?').bind(day).first();
  return row?.spend ?? 0;
}
