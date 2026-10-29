import { describe, it, expect } from 'vitest';
import { AGGREGATOR_DOMAINS } from '../../site/js/shared/discovery.js';
import { createConfsFeed } from '../../worker/src/discovery/adapters/confs.js';
import { createExaSearch } from '../../worker/src/discovery/adapters/exa.js';
import { SourceError, planSearches } from '../../worker/src/discovery/plan.js';
import confsData from '../fixtures/discovery/confs-data.json';
import exaResponse from '../fixtures/discovery/exa-response.json';

const query = (over = {}) => ({
  query: 'shared services in europe', from: '2026-11-01', to: '2027-06-30', region: 'Europe',
  topics: ['procure to pay', 'ERP', 'supply chain', 'distribution'], ...over,
});
const settings = (maxSearches = 12) => ({ maxSearches });

describe('planSearches', () => {
  it('plans the user query first and never more than maxSearches', () => {
    const plan = planSearches(query(), settings());
    expect(plan[0]).toEqual({ adapter: 'exa', query: 'shared services in europe' });
    for (const max of [1, 2, 3, 5, 12, 40]) {
      expect(planSearches(query(), settings(max)).length, `max ${max}`).toBeLessThanOrEqual(max);
    }
    expect(planSearches(query(), settings(1))).toEqual([plan[0]]);
  });

  it('runs the user query once more on the aggregator sites for cross-checking', () => {
    const plan = planSearches(query(), settings());
    expect(plan[1]).toEqual({ adapter: 'exa', query: 'shared services in europe', includeDomains: AGGREGATOR_DOMAINS });
  });

  it('alternates aggregator and open-web passes per topic, never both filters on one search', () => {
    const plan = planSearches(query(), settings(40)).filter((s) => s.adapter === 'exa' && s.query.includes('ERP'));
    expect(plan).toHaveLength(2);
    expect(plan.filter((s) => s.includeDomains)).toHaveLength(1);
    expect(plan.filter((s) => s.excludeDomains)).toHaveLength(1);
    expect(plan.find((s) => s.includeDomains).includeDomains).toEqual(AGGREGATOR_DOMAINS);
    expect(plan.find((s) => s.excludeDomains).excludeDomains).toEqual(AGGREGATOR_DOMAINS);
    for (const s of planSearches(query(), settings(40))) expect(Boolean(s.includeDomains && s.excludeDomains)).toBe(false);
  });

  it('puts the years and region into topic searches', () => {
    const topic = planSearches(query(), settings(40)).find((s) => s.adapter === 'exa' && s.query.includes('supply chain'));
    expect(topic.query).toMatch(/2026/);
    expect(topic.query).toMatch(/2027/);
    expect(topic.query).toMatch(/Europe/);
  });

  it('adds one confs search per year in range for data and general, even with a small budget', () => {
    for (const max of [12, 40]) {
      const confs = planSearches(query(), settings(max)).filter((s) => s.adapter === 'confs');
      expect(confs.map((s) => `${s.year}:${s.file}`).sort()).toEqual(['2026:data', '2026:general', '2027:data', '2027:general']);
    }
    const oneYear = planSearches(query({ from: '2027-02-01', to: '2027-05-01' }), settings()).filter((s) => s.adapter === 'confs');
    expect(oneYear.map((s) => `${s.year}:${s.file}`).sort()).toEqual(['2027:data', '2027:general']);
  });

  it('with no topics plans the user query, its aggregator pass and the feeds only', () => {
    const plan = planSearches(query({ topics: [], region: undefined }), settings());
    expect(plan.filter((s) => s.adapter === 'exa')).toHaveLength(2);
  });
});

describe('createExaSearch', () => {
  const respond = (status, body = exaResponse) => async () => new Response(JSON.stringify(body), { status });

  it('sends the key header and maps results to pages, dropping the empty one', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(exaResponse), { status: 200 });
    };
    const pages = await createExaSearch({ EXA_API_KEY: 'test-key' }, fetchImpl).search({ adapter: 'exa', query: 'shared services 2027', includeDomains: ['10times.com'] });
    expect(seen.url).toBe('https://api.exa.ai/search');
    expect(seen.init.method).toBe('POST');
    expect(seen.init.headers['x-api-key']).toBe('test-key');
    expect(JSON.parse(seen.init.body)).toEqual({
      query: 'shared services 2027', numResults: 10, type: 'auto', contents: { text: { maxCharacters: 3000 } }, includeDomains: ['10times.com'],
    });
    expect(pages).toHaveLength(2);
    expect(pages[0]).toEqual({
      url: 'https://www.ssonetwork.com/events-ssoweek', title: 'SSOW Orlando 2027 | Shared Services & Outsourcing Week',
      text: exaResponse.results[0].text, adapter: 'exa',
    });
  });

  it('sends excludeDomains for the open-web pass and nothing else', async () => {
    let body;
    const fetchImpl = async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    await createExaSearch({ EXA_API_KEY: 'k' }, fetchImpl).search({ adapter: 'exa', query: 'q', excludeDomains: ['10times.com'] });
    expect(body.excludeDomains).toEqual(['10times.com']);
    expect(body).not.toHaveProperty('includeDomains');
  });

  it('copes with a response that has no results', async () => {
    expect(await createExaSearch({ EXA_API_KEY: 'k' }, respond(200, {})).search({ adapter: 'exa', query: 'q' })).toEqual([]);
  });

  it('throws a retryable SourceError on 429 and 5xx and a non-retryable one on 401', async () => {
    const search = (status) => createExaSearch({ EXA_API_KEY: 'k' }, respond(status, {})).search({ adapter: 'exa', query: 'q' });
    await expect(search(429)).rejects.toMatchObject({ status: 429, retryable: true });
    await expect(search(500)).rejects.toMatchObject({ status: 500, retryable: true });
    await expect(search(401)).rejects.toMatchObject({ status: 401, retryable: false });
    await expect(search(401)).rejects.toBeInstanceOf(SourceError);
  });
});

describe('createConfsFeed', () => {
  const feedOf = (rows, status = 200) => {
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(url);
      return new Response(JSON.stringify(rows), { status });
    };
    return { requested, feed: createConfsFeed(fetchImpl) };
  };

  it('requests the file for the year and maps fields, converting country names', async () => {
    const { feed, requested } = feedOf(confsData);
    const observations = await feed.list({ adapter: 'confs', year: 2027, file: 'data' });
    expect(requested).toEqual(['https://raw.githubusercontent.com/tech-conferences/conference-data/main/conferences/2027/data.json']);
    expect(observations).toHaveLength(confsData.length);
    expect(observations[0]).toMatchObject({
      name: 'AI Conf Asia', startDate: '2027-01-09', endDate: '2027-01-10', city: 'Kathmandu', country: 'NP', online: false,
      cancelled: false, url: 'https://aiconf.asia', sourceDomain: 'confs.tech', adapter: 'confs', topicHits: 0,
    });
    expect(observations[1].country).toBe('AE');
  });

  it('understands dotted country spellings such as U.S.A. and U.K.', async () => {
    const { feed } = feedOf(confsData);
    const observations = await feed.list({ adapter: 'confs', year: 2027, file: 'data' });
    expect(observations.map((o) => o.country)).toEqual(['NP', 'AE', 'US', 'GB']);
  });

  it('skips online events and rows with no url, and gives country null for an unknown country', async () => {
    const rows = [
      { ...confsData[0], online: true },
      { ...confsData[1], url: null },
      { ...confsData[2], country: 'Narnia' },
    ];
    const observations = await feedOf(rows).feed.list({ adapter: 'confs', year: 2027, file: 'data' });
    expect(observations).toHaveLength(1);
    expect(observations[0].country).toBeNull();
  });

  it('treats a missing year file as no events and any other failure as a SourceError', async () => {
    expect(await feedOf({}, 404).feed.list({ adapter: 'confs', year: 2031, file: 'data' })).toEqual([]);
    await expect(feedOf({}, 500).feed.list({ adapter: 'confs', year: 2027, file: 'data' })).rejects.toMatchObject({ status: 500, retryable: true });
  });
});
