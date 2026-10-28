// Pure event filtering for the table. Search ignores case and accents.
import { fold } from './shared/clean.js';

const regionOf = (lon) => {
  if (!Number.isFinite(lon)) return null;
  if (lon < -30) return 'americas';
  return lon <= 70 ? 'europe' : 'other';
};

export function filterEvents(events, f = {}) {
  const query = f.query ? fold(f.query) : '';
  return events.filter((e) => {
    if (f.minScore !== undefined && f.minScore !== '' && !(e.priority >= Number(f.minScore))) return false;
    if (f.status && f.status !== 'all' && e.status !== f.status) return false;
    if (f.region && f.region !== 'all' && regionOf(e.lon) !== f.region) return false;
    if ((f.from || f.to) && e.startDate) {
      const end = e.endDate ?? e.startDate;
      if (f.to && e.startDate > f.to) return false;
      if (f.from && end < f.from) return false;
    }
    if (query) {
      const haystack = fold([e.name, e.city, e.country, e.organiser].filter(Boolean).join(' '));
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
