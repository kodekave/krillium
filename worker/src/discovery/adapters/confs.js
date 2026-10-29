// Confs.tech open conference data (a software-focused list). Structured, so there is no model step and no quote.
import { countryCode } from '../../../../site/js/shared/cities.js';
import { SourceError } from '../plan.js';

const BASE = 'https://raw.githubusercontent.com/tech-conferences/conference-data/main/conferences';

export function createConfsFeed(fetchImpl = (...args) => fetch(...args)) {
  return {
    name: 'confs',
    async list(spec) {
      const response = await fetchImpl(`${BASE}/${spec.year}/${spec.file}.json`);
      if (response.status === 404) return []; // a year's file may not exist yet
      if (!response.ok) throw new SourceError(response.status, `confs.tech request failed with status ${response.status}`);
      const rows = await response.json();
      return (Array.isArray(rows) ? rows : [])
        .filter((r) => r && r.name && r.startDate && r.url && !r.online)
        .map((r) => ({
          name: r.name, organiser: null, startDate: r.startDate, endDate: r.endDate ?? null, city: r.city ?? null,
          country: countryCode(r.country), online: false, cancelled: false, url: r.url, sourceDomain: 'confs.tech',
          adapter: 'confs', title: r.name, quotes: null, topicHits: 0,
        }));
    },
  };
}
