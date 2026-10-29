import { describe, it, expect } from 'vitest';
import { defaultDeps, missingSecrets } from '../../worker/src/discovery/deps.js';

describe('what discovery needs from the Worker', () => {
  it('asks for the Exa key alone', () => {
    expect(missingSecrets(defaultDeps({}, { sharedKeys: true }))).toEqual(['EXA_API_KEY']);
    expect(missingSecrets(defaultDeps({ EXA_API_KEY: 'k' }, { sharedKeys: true }))).toEqual([]);
  });

  it('has no Claude reader until an Anthropic key is set, and an Anthropic key alone cannot search', () => {
    expect(defaultDeps({ EXA_API_KEY: 'k' }, { sharedKeys: true }).model).toBeNull();
    expect(defaultDeps({ EXA_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, { sharedKeys: true }).model).not.toBeNull();
    expect(missingSecrets(defaultDeps({ ANTHROPIC_API_KEY: 'a' }, { sharedKeys: true }))).toEqual(['EXA_API_KEY']);
  });

  it('asks Exa for summaries only while Claude is not reading the pages', () => {
    expect(defaultDeps({ EXA_API_KEY: 'k' }, { sharedKeys: true }).pages.summaries).toBe(true);
    expect(defaultDeps({ EXA_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, { sharedKeys: true }).pages.summaries).toBe(false);
  });
});
