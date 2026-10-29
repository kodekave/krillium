// A workspace's memory: an append-only log of facts about what it decided or did (spec section 15). Each entry
// snapshots the facts of that moment, so it still means something after the event or candidate it describes is gone.
// It holds no personal data about leads, never blocks the action it records, and costs at most one statement per request.
import { registrableDomain } from '../../site/js/shared/names.js';
import { wsId } from './scope.js';

const MAX_DETAIL_BYTES = 2048;
const MAX_STRING = 200;
const ROWS_PER_STATEMENT = 19; // 5 bound values per row; D1 allows 100 per statement
const encoder = new TextEncoder();
const size = (value) => encoder.encode(JSON.stringify(value)).length;

function trimStrings(value, limit) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…` : value;
  if (Array.isArray(value)) return value.map((v) => trimStrings(v, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimStrings(v, limit)]));
  return value;
}

// Valid JSON of at most 2048 bytes. Long strings are cut; the longest list is halved until it fits and a
// `<list>More` count keeps what was left out.
export function fitDetail(detail) {
  let fitted = trimStrings(JSON.parse(JSON.stringify(detail ?? {})), MAX_STRING);
  while (size(fitted) > MAX_DETAIL_BYTES) {
    const lists = Object.entries(fitted).filter(([, v]) => Array.isArray(v) && v.length > 0);
    if (!lists.length) break;
    const [key, list] = lists.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    const keep = Math.floor(list.length / 2);
    fitted = { ...fitted, [key]: list.slice(0, keep), [`${key}More`]: (fitted[`${key}More`] ?? 0) + (list.length - keep) };
  }
  if (size(fitted) > MAX_DETAIL_BYTES) fitted = trimStrings(fitted, 40);
  if (size(fitted) > MAX_DETAIL_BYTES) fitted = { truncated: true };
  return fitted;
}

// Appends entries in one multi-row statement. A failed write is logged and reported as false, never thrown: memory must
// not stop the action it records.
export async function remember(db, workspaceId, entries) {
  try {
    wsId(workspaceId);
    const rows = (entries ?? []).filter(Boolean);
    for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
      const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
      await db
        .prepare(`INSERT INTO memory (workspace_id, actor, kind, subject, detail) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}`)
        .bind(...chunk.flatMap((e) => [workspaceId, e.actor, e.kind, e.subject === undefined || e.subject === null ? null : String(e.subject), JSON.stringify(fitDetail(e.detail ?? {}))]))
        .run();
    }
    return true;
  } catch (e) {
    console.error('memory write failed', e);
    return false;
  }
}

const parseDetail = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

// The newest entries first, and how many there are in all.
export async function listMemory(db, workspaceId, { limit = 20 } = {}) {
  wsId(workspaceId);
  const take = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 100);
  const total = await db.prepare('SELECT COUNT(*) AS n FROM memory WHERE workspace_id = ?').bind(workspaceId).first();
  const { results } = await db
    .prepare('SELECT id, at, actor, kind, subject, detail FROM memory WHERE workspace_id = ? ORDER BY id DESC LIMIT ?')
    .bind(workspaceId, take)
    .all();
  return { total: total.n, items: results.map((r) => ({ ...r, detail: parseDetail(r.detail) })) };
}

// The facts of a finished run: what it searched, found and cost, and which sources earned their keep. A source is
// "wasted" only if some filtered result came from it and nothing new did.
export function summariseRun({ run, items, query }) {
  const counts = { auto_added: 0, inbox: 0, tracked: 0, filtered: 0 };
  const filteredBy = {};
  const productive = new Set();
  const filteredFrom = new Set();
  const autoAdded = [];
  for (const item of items) {
    if (item.outcome in counts) counts[item.outcome] += 1;
    if (item.outcome === 'filtered') {
      filteredBy[item.reason ?? 'other'] = (filteredBy[item.reason ?? 'other'] ?? 0) + 1;
      const domain = registrableDomain(item.url);
      if (domain) filteredFrom.add(domain);
    }
    if (item.outcome === 'auto_added' || item.outcome === 'inbox') for (const domain of item.domains ?? []) productive.add(domain);
    if (item.outcome === 'auto_added' && item.name) autoAdded.push(item.name);
  }
  return {
    status: run.status,
    sectors: query?.sectors ?? [],
    searches: run.searchCalls,
    spendUsd: Math.round(run.spendUsd * 10000) / 10000,
    pages: run.pages,
    counts,
    filteredBy,
    productive: [...productive].sort(),
    wasted: [...filteredFrom].filter((domain) => !productive.has(domain)).sort(),
    autoAdded,
  };
}

// What a settings save changed, or null when it changed nothing. Sectors are compared by id.
export function diffSettings(before, after) {
  const byId = (list) => new Map((list ?? []).map((s) => [s.id, s]));
  const was = byId(before.sectors);
  const now = byId(after.sectors);
  const added = [...now.keys()].filter((id) => !was.has(id));
  const removed = [...was.keys()].filter((id) => !now.has(id));
  const edited = [...now.keys()].filter((id) => was.has(id) && JSON.stringify(was.get(id)) !== JSON.stringify(now.get(id)));
  const changed = Object.keys(after).filter((key) => key !== 'sectors' && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return added.length || removed.length || edited.length || changed.length ? { added, removed, edited, changed } : null;
}
