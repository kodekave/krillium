// Discovery settings: spend caps, search limits, Claude prices, sectors and the pause switch. Spend is what Exa reports
// for a search plus, when an Anthropic key is set, what Claude's reading costs at the prices below.
// Stored as JSON values in the settings table, one set per workspace; anything not stored falls back to DEFAULT_SETTINGS.
import { DEFAULT_SECTORS, cleanSectors, validateSectors } from '../../../site/js/shared/sectors.js';
import { wsId } from '../scope.js';

export const DEFAULT_SETTINGS = Object.freeze({
  paused: false,
  runCapUsd: 0.5,
  dayCapUsd: 2,
  maxSearches: 12,
  maxPages: 120,
  // Assumed Haiku-class prices in USD per million tokens, used only while an Anthropic key is set. Confirm against
  // current Anthropic pricing.
  priceInPerMtok: 1,
  priceOutPerMtok: 5,
  // The kinds of event the team looks for: named bundles of topics, each of which can be switched off.
  sectors: DEFAULT_SECTORS,
});

const MONEY_AND_PRICES = ['runCapUsd', 'dayCapUsd', 'priceInPerMtok', 'priceOutPerMtok'];
const COUNTS = { maxSearches: 40, maxPages: 1000 };

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
    } else if (key === 'sectors') {
      errors.push(...validateSectors(value));
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function getSettings(db, workspaceId) {
  wsId(workspaceId);
  const { results } = await db.prepare('SELECT key, value FROM settings WHERE workspace_id = ?').bind(workspaceId).all();
  const stored = {};
  for (const row of results) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, row.key)) continue;
    try {
      const value = JSON.parse(row.value);
      // a stored value that no longer passes its check falls back to the default, like one that cannot be read
      if (row.key === 'sectors' && validateSectors(value).length) continue;
      stored[row.key] = value;
    } catch {
      // an unreadable stored value falls back to the default
    }
  }
  return { ...DEFAULT_SETTINGS, ...stored, sectors: cleanSectors(stored.sectors ?? DEFAULT_SETTINGS.sectors) };
}

export async function putSettings(db, workspaceId, patch) {
  wsId(workspaceId);
  const { ok, errors } = validateSettings(patch);
  if (!ok) throw new SettingsError(errors);
  const clean = { ...patch };
  if (clean.sectors) clean.sectors = cleanSectors(clean.sectors);
  const writes = Object.entries(clean).map(([key, value]) =>
    db
      .prepare('INSERT INTO settings (workspace_id, key, value) VALUES (?, ?, ?) ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value')
      .bind(workspaceId, key, JSON.stringify(value)),
  );
  if (writes.length) await db.batch(writes);
  return getSettings(db, workspaceId);
}

// Search spend so far today (UTC) across this workspace's runs, for its daily cap. Another workspace's spend never counts.
export async function daySpend(db, workspaceId, now) {
  wsId(workspaceId);
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await db
    .prepare('SELECT COALESCE(SUM(model_spend), 0) AS spend FROM search_runs WHERE workspace_id = ? AND date(started) = ?')
    .bind(workspaceId, day)
    .first();
  return row?.spend ?? 0;
}
