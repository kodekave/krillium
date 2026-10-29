// Thin client for the Anthropic Messages API. Kept separate from extraction so tests can pass a fake model.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const MODEL_ID = 'claude-haiku-5-5';
const MAX_TOKENS = 2000;

export class ModelError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

export function createAnthropicModel(env, fetchImpl = (...args) => fetch(...args)) {
  return {
    async extract({ system, user }) {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODEL_ID, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!response.ok) throw new ModelError(response.status, `model request failed with status ${response.status}`);
      const body = await response.json();
      const text = (body.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
      return { text, usage: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 } };
    },
  };
}
