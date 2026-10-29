// What a search run depends on, built from the Worker's secrets. A source without its key is null, and the
// routes report "not set up" instead of failing. Tests pass their own fakes through createHandler({ discovery }).
import { createConfsFeed } from './adapters/confs.js';
import { createExaSearch } from './adapters/exa.js';
import { createAnthropicModel } from './model.js';

// Exa finds the pages and, by default, reads them too, so its key is the only one discovery needs. With an Anthropic key
// as well, Claude reads the pages instead and Exa is not asked for (or charged for) summaries. Claude cannot search, so
// an Anthropic key alone does not switch the feature on.
// The Worker's own keys are the operator's, so they serve only a workspace the operator has switched `sharedKeys` on for;
// any other workspace has no search or model reader. The Confs.tech feed needs no key and is always available.
export function defaultDeps(env, { sharedKeys = false } = {}) {
  const shared = sharedKeys === true;
  return {
    pages: shared && env.EXA_API_KEY ? createExaSearch(env, (...args) => fetch(...args), { summaries: !env.ANTHROPIC_API_KEY }) : null,
    feeds: createConfsFeed(),
    model: shared && env.ANTHROPIC_API_KEY ? createAnthropicModel(env) : null,
  };
}

export function missingSecrets(deps) {
  return deps.pages ? [] : ['EXA_API_KEY'];
}
