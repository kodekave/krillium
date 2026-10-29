// Confs.tech open conference data (a software-focused list). Structured, so there is no model step and no quote.
import { countryCode } from '../../../../site/js/shared/cities.js';
import { fold } from '../../../../site/js/shared/clean.js';
import { SourceError } from '../plan.js';

const BASE = 'https://raw.githubusercontent.com/tech-conferences/conference-data/main/conferences';
const MAX_ROWS = 25; // one step must stay small: every row becomes database writes

export function createConfsFeed(fetchImpl = (...args) => fetch(...args)) {
  return {
    name: 'confs',
    async list(spec) {
      const response = await fetchImpl(`${BASE}/${spec.year}/${spec.file}.json`);
      if (response.status === 404) return []; // a year's file may not exist yet
      if (!response.ok) throw new SourceError(response.status, `confs.tech request failed with status ${response.status}`);
      const rows = await response.json();
      let kept = (Array.isArray(rows) ? rows : []).filter((r) => r && r.name && r.startDate && r.url && !r.online);
      // The file lists every conference of the year: keep only those in the dates and about the words asked for.
      // Without terms (a caller that does not say what it wants) nothing is filtered by words; an empty list matches nothing.
      if (Array.isArray(spec.terms)) {
        kept = kept.filter((r) => spec.terms.some((term) => fold(`${r.name} ${r.city ?? ''}`).includes(term)));
      }
      if (spec.from) kept = kept.filter((r) => (r.endDate ?? r.startDate) >= spec.from);
      if (spec.to) kept = kept.filter((r) => r.startDate <= spec.to);
      return kept
        .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))
        .slice(0, MAX_ROWS)
        .map((r) => ({
          name: r.name, organiser: null, startDate: r.startDate, endDate: r.endDate ?? null, city: r.city ?? null,
          country: countryCode(r.country), online: false, cancelled: false, url: r.url, sourceDomain: 'confs.tech',
          adapter: 'confs', title: r.name, quotes: null, topicHits: 0,
        }));
    },
  };
}
