import { describe, it, expect } from 'vitest';
import { createSectors } from '../../site/js/sectors.js';

const list = [
  { id: 'pharma', name: 'Pharma and life sciences', topics: ['clinical supply'], enabled: true },
  { id: 'banking', name: 'Banking and insurance operations', topics: ['fintech'], enabled: false },
];

function apiOf(...answers) {
  const gets = [];
  return { gets, get: async (path) => { gets.push(path); return answers[Math.min(gets.length - 1, answers.length - 1)]; } };
}
const ok = (sectors) => ({ ok: true, status: 200, data: { sectors } });

describe('createSectors', () => {
  it('loads the sectors from the discovery settings once and shares the result', async () => {
    const api = apiOf(ok(list));
    const sectors = createSectors(api);
    expect(sectors.list()).toEqual([]);
    const [a, b] = await Promise.all([sectors.load(), sectors.load()]);
    expect(a).toEqual(list);
    expect(b).toEqual(list);
    await sectors.load();
    expect(api.gets).toEqual(['/api/discovery/settings']);
    expect(sectors.list()).toEqual(list);
  });

  it('names a sector, falling back to its id when it is not known', async () => {
    const sectors = createSectors(apiOf(ok(list)));
    expect(sectors.name('pharma')).toBe('pharma');
    await sectors.load();
    expect(sectors.name('pharma')).toBe('Pharma and life sciences');
    expect(sectors.name('retired')).toBe('retired');
  });

  it('tries again after a failed load instead of remembering the failure', async () => {
    const api = apiOf({ ok: false, status: 500 }, ok(list));
    const sectors = createSectors(api);
    expect(await sectors.load()).toEqual([]);
    expect(await sectors.load()).toEqual(list);
    expect(api.gets).toHaveLength(2);
  });

  it('set replaces the list without asking again, and reload asks again', async () => {
    const api = apiOf(ok(list), ok([list[0]]));
    const sectors = createSectors(api);
    await sectors.load();
    sectors.set([list[1]]);
    expect(sectors.list()).toEqual([list[1]]);
    expect(await sectors.load()).toEqual([list[1]]);
    expect(api.gets).toHaveLength(1);
    expect(await sectors.reload()).toEqual([list[0]]);
    expect(api.gets).toHaveLength(2);
  });

  it('copes with a response that has no sectors', async () => {
    expect(await createSectors(apiOf({ ok: true, data: {} })).load()).toEqual([]);
  });
});
