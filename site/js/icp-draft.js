// Pure helpers for the ICP brain: immutable edits, a live re-rank preview, and draft validity.
import { rankEvents, validateConfig } from './shared/scoring.js';

export function applyEdit(cfg, path, value) {
  const next = structuredClone(cfg);
  const keys = path.split('.');
  const last = keys.pop();
  let node = next;
  for (const key of keys) node = node[key];
  node[last] = value;
  return next;
}

export function setDensityShare(cfg, share) {
  const next = structuredClone(cfg);
  next.weights.icpDensityShare = share;
  next.weights.eventScoreShare = Number((1 - share).toFixed(10));
  return next;
}

export function describeDraft(saved, draft) {
  const { ok, errors } = validateConfig(draft);
  const strip = ({ version, ...rest }) => JSON.stringify(rest);
  return { dirty: strip(saved) !== strip(draft), valid: ok, errors };
}

export function previewRanking(events, saved, draft) {
  const before = rankEvents(events, saved);
  const previous = new Map(before.map((e, i) => [e.id, { rank: i + 1, status: e.status, priority: e.priority }]));
  return rankEvents(events, draft).map((e, i) => {
    const prev = previous.get(e.id);
    return {
      id: e.id, name: e.name, city: e.city, priority: e.priority, status: e.status, rank: i + 1,
      previousRank: prev.rank, delta: prev.rank - (i + 1), previousPriority: prev.priority,
      previousStatus: prev.status, statusChanged: prev.status !== e.status,
    };
  });
}

// Module memory only: a draft survives a sign-in interruption and screen changes, never touches disk.
export function createDraftStore() {
  let draft = null;
  return { get: () => draft, set: (d) => { draft = d; }, clear: () => { draft = null; } };
}
