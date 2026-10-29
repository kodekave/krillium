// Exa web search. One call returns up to 10 pages with their text and a structured summary that Exa's own reader writes
// from each page, so no third-party page is fetched here and no other AI service is needed.
// Request and response shape: POST https://api.exa.ai/search with an x-api-key header; results carry url, title, text and
// summary (a JSON string), and the response carries costDollars.total.
import { MAX_PAGE_CHARS } from '../extract.js';
import { SourceError } from '../plan.js';

const ENDPOINT = 'https://api.exa.ai/search';
const NUM_RESULTS = 10;
// Exa's published prices, used only when a response does not report its own cost: $7 per 1,000 searches, and $1 per
// 1,000 pages for each of text and summaries.
const SEARCH_PRICE_USD = 0.007;
const TEXT_PRICE_USD = 0.001;
const SUMMARY_PRICE_USD = 0.001;

export const SUMMARY_QUERY = [
  'If this page is about one specific upcoming business event such as a conference, summit, expo or trade show,',
  'set isEvent to true and give its facts. If it is not about one specific event, set isEvent to false and give nothing else.',
  'Dates are YYYY-MM-DD. Every quote must be copied exactly from the page. Leave out anything the page does not say.',
].join(' ');

export const EVENT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Event',
  type: 'object',
  properties: {
    isEvent: { type: 'boolean', description: 'true only if the page is about one specific upcoming event' },
    name: { type: 'string', description: 'the name of the event' },
    organiser: { type: 'string', description: 'who organises the event' },
    startDate: { type: 'string', description: 'first day of the event, YYYY-MM-DD' },
    endDate: { type: 'string', description: 'last day of the event, YYYY-MM-DD' },
    city: { type: 'string', description: 'the city it takes place in' },
    country: { type: 'string', description: 'the country it takes place in, in English' },
    online: { type: 'boolean', description: 'true if the event is online only' },
    cancelled: { type: 'boolean', description: 'true if the page says the event is cancelled' },
    quotes: {
      type: 'object',
      description: 'text copied exactly from the page that supports each fact',
      properties: {
        name: { type: 'string', description: 'the words that name the event' },
        dates: { type: 'string', description: 'the words that give the date or dates' },
        city: { type: 'string', description: 'the words that give the city' },
      },
    },
  },
  required: ['isEvent'],
};

// With summaries off, Exa only finds the pages and a Claude model reads them, so Exa is not asked for (or charged for)
// summaries.
export function createExaSearch(env, fetchImpl = (...args) => fetch(...args), { summaries = true } = {}) {
  return {
    name: 'exa',
    summaries,
    // Returns { pages, costUsd }: the pages with text, and what the call cost.
    async search(spec) {
      const contents = { text: { maxCharacters: MAX_PAGE_CHARS } };
      if (summaries) contents.summary = { query: SUMMARY_QUERY, schema: EVENT_SCHEMA };
      const body = { query: spec.query, numResults: NUM_RESULTS, type: 'auto', contents };
      if (spec.includeDomains) body.includeDomains = spec.includeDomains;
      if (spec.excludeDomains) body.excludeDomains = spec.excludeDomains;
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.EXA_API_KEY },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new SourceError(response.status, `exa request failed with status ${response.status}`);
      const data = await response.json();
      const results = data.results ?? [];
      const reported = data.costDollars?.total;
      return {
        pages: results
          .filter((r) => r.url && typeof r.text === 'string' && r.text.trim())
          .map((r) => ({ url: r.url, title: r.title ?? null, text: r.text, summary: r.summary ?? null, adapter: 'exa' })),
        costUsd: Number.isFinite(reported) ? reported : SEARCH_PRICE_USD + results.length * (TEXT_PRICE_USD + (summaries ? SUMMARY_PRICE_USD : 0)),
      };
    },
  };
}
