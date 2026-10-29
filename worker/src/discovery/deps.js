// What a search run depends on, built from the Worker's secrets. A source without its key is null, and the
// routes report "not set up" instead of failing. Tests pass their own fakes through createHandler({ discovery }).
import { createConfsFeed } from './adapters/confs.js';
import { createExaSearch } from './adapters/exa.js';
import { createAnthropicModel } from './model.js';

export function defaultDeps(env) {
  return {
    pages: env.EXA_API_KEY ? createExaSearch(env) : null,
    feeds: createConfsFeed(),
    model: env.ANTHROPIC_API_KEY ? createAnthropicModel(env) : null,
  };
}

export function missingSecrets(deps) {
  const missing = [];
  if (!deps.pages) missing.push('EXA_API_KEY');
  if (!deps.model) missing.push('ANTHROPIC_API_KEY');
  return missing;
}
