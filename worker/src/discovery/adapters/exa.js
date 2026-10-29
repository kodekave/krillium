// Exa web search with page text. One call returns up to 10 pages with their text, so no third-party page is fetched here.
// Request and response shape: POST https://api.exa.ai/search with an x-api-key header; results carry url, title and text.
import { SourceError } from '../plan.js';

const ENDPOINT = 'https://api.exa.ai/search';
const NUM_RESULTS = 10;
const TEXT_CHARS = 3000;

export function createExaSearch(env, fetchImpl = (...args) => fetch(...args)) {
  return {
    name: 'exa',
    async search(spec) {
      const body = { query: spec.query, numResults: NUM_RESULTS, type: 'auto', contents: { text: { maxCharacters: TEXT_CHARS } } };
      if (spec.includeDomains) body.includeDomains = spec.includeDomains;
      if (spec.excludeDomains) body.excludeDomains = spec.excludeDomains;
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.EXA_API_KEY },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new SourceError(response.status, `exa request failed with status ${response.status}`);
      const data = await response.json();
      return (data.results ?? [])
        .filter((r) => r.url && typeof r.text === 'string' && r.text.trim())
        .map((r) => ({ url: r.url, title: r.title ?? null, text: r.text, adapter: 'exa' }));
    },
  };
}
