import type { AdapterConfig, BaseLLMAdapter } from './base.js';
import { AnthropicAdapter } from './anthropic.js';
import type { FetchLike } from './fetch-adapter.js';
import { GeminiAdapter } from './gemini.js';
import { OpenAIAdapter } from './openai.js';

export { AnthropicAdapter } from './anthropic.js';
export type { FetchLike } from './fetch-adapter.js';
export { GeminiAdapter } from './gemini.js';
export { OpenAIAdapter } from './openai.js';

export function createAdapter(config: AdapterConfig, fetchImpl?: FetchLike): BaseLLMAdapter {
  const baseUrl = config.baseUrl.toLowerCase();
  if (baseUrl.includes('anthropic.com')) return new AnthropicAdapter(config, fetchImpl);
  if (baseUrl.includes('googleapis.com') || baseUrl.includes('generativelanguage'))
    return new GeminiAdapter(config, fetchImpl);
  return new OpenAIAdapter(config, fetchImpl);
}
