// Plain-language sentences for the entries in a workspace's memory log (spec section 15). Shared so the page and the
// tests read an entry the same way. It never throws: an entry of a kind this version does not know still gets a line.
export const MEMORY_KINDS = [
  'event.decision', 'candidate.approved', 'candidate.rejected', 'autoadd.undone', 'search.finished', 'icp.saved', 'sectors.saved', 'samples.loaded',
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const money = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const STATUS_WORDS = { done: 'finished', capped: 'stopped at the budget', stopped: 'stopped', paused: 'paused', failed: 'failed' };

const sites = (d) => (d.siteCount === undefined ? '' : `, ${plural(d.siteCount, 'site')}`);

const DESCRIBE = {
  'event.decision': (d) => {
    const name = d.name ?? 'an event';
    if (d.choice === 'skip') return d.reason ? `Skipped ${name}: ${d.reason}` : `Skipped ${name}`;
    if (d.choice === 'watch') return `Put ${name} on watch`;
    return `Chose to attend ${name}`;
  },
  'candidate.approved': (d) => `Approved ${d.name ?? 'an event'} from the inbox${sites(d)}`,
  'candidate.rejected': (d) => `Rejected ${d.name ?? 'an event'} from the inbox${sites(d)}`,
  'autoadd.undone': (d) => `Removed the automatically added ${d.name ?? 'event'}`,
  'search.finished': (d) => {
    const counts = d.counts ?? {};
    const where = d.sectors?.length ? ` for ${plural(d.sectors.length, 'sector')}` : '';
    return `Search ${STATUS_WORDS[d.status] ?? d.status ?? 'ended'}${where}: ${counts.auto_added ?? 0} added, ${counts.inbox ?? 0} for review, ${counts.filtered ?? 0} filtered (${money(d.spendUsd)})`;
  },
  'icp.saved': (d) => `Saved ICP version ${d.version}${d.changed?.length ? ` (changed ${d.changed.join(', ')})` : ''}`,
  'sectors.saved': (d) => {
    const parts = [
      d.added?.length ? `added ${d.added.join(', ')}` : null,
      d.removed?.length ? `removed ${d.removed.join(', ')}` : null,
      d.edited?.length ? `edited ${d.edited.join(', ')}` : null,
    ].filter(Boolean);
    const settings = d.changed?.length ? `changed ${d.changed.join(', ')}` : null;
    if (!parts.length) return `Changed settings: ${d.changed?.join(', ') ?? 'none'}`;
    return `Changed sectors: ${parts.join(', ')}${settings ? `; ${settings}` : ''}`;
  },
  'samples.loaded': (d) => `Loaded ${plural(d.count ?? 0, 'sample event')}`,
};

export function describeMemory(entry) {
  const describe = DESCRIBE[entry?.kind];
  if (!describe) return entry?.kind ? `Recorded ${entry.kind}` : 'Recorded an event';
  const detail = entry.detail ?? {};
  const text = describe(detail);
  return detail.backfilled ? `${text} (from earlier history)` : text;
}
