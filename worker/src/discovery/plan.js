// Turns one search request into the list of searches a run will step through, and defines the error sources raise.
import { AGGREGATOR_DOMAINS } from '../../../site/js/shared/discovery.js';

export class SourceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

const CONFS_FILES = ['data', 'general'];
const MAX_CONFS_YEARS = 3;

function yearsIn(from, to) {
  const a = Number(String(from).slice(0, 4));
  const b = Number(String(to).slice(0, 4));
  if (!Number.isInteger(a) || !Number.isInteger(b)) return [];
  const first = Math.min(a, b);
  const last = Math.min(Math.max(a, b), first + MAX_CONFS_YEARS - 1);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

// Order matters when the budget is small: the user's own query and its aggregator pass come first, then the feeds
// (cheap and independent of the search budget's topics), then topic searches, an aggregator and an open-web pass each.
// Exa cannot combine include and exclude filters, so no search carries both.
export function planSearches(q, settings) {
  const years = yearsIn(q.from, q.to);
  const place = q.region ? ` ${q.region}` : '';
  const own = [
    { adapter: 'exa', query: q.query },
    { adapter: 'exa', query: q.query, includeDomains: [...AGGREGATOR_DOMAINS] },
  ];
  const feeds = years.flatMap((year) => CONFS_FILES.map((file) => ({ adapter: 'confs', file, year })));
  const topics = (q.topics ?? []).flatMap((topic) => {
    const text = `${topic} conference ${years.join(' ')}${place}`;
    return [
      { adapter: 'exa', query: text, includeDomains: [...AGGREGATOR_DOMAINS] },
      { adapter: 'exa', query: text, excludeDomains: [...AGGREGATOR_DOMAINS] },
    ];
  });
  return [...own, ...feeds, ...topics].slice(0, settings.maxSearches);
}
