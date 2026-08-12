/**
 * Public package entry point.
 *
 * Concrete exports are added by their owning compatibility Issues. Keeping the
 * entry point present from the first commit makes the package contract testable.
 */
export {
  AgentError,
  ConfigError,
  HelloAgentsError,
  LLMAbortError,
  LLMError,
  LLMTimeoutError,
  ToolError
} from './core/errors.js';
export { HelloAgentsLLM } from './core/llm.js';
export type { HelloAgentsLLMOptions, LLMInvokeOptions } from './core/llm.js';
export { MockAdapter } from './adapters/mock.js';
export { llmMessageSchema, toolChoiceSchema } from './adapters/base.js';
export type {
  AdapterCallOptions,
  AdapterConfig,
  AdapterRequest,
  AdapterToolRequest,
  BaseLLMAdapter,
  LLMAdapterFactory,
  LLMMessage,
  ToolChoice
} from './adapters/base.js';
export {
  Config,
  configSchema,
  createConfig,
  createConfigFromEnv,
  parseConfig
} from './core/config.js';
export type { ConfigInput, ConfigValues, ResolvedConfig } from './core/config.js';
export { Message, messageRoleSchema, messageSchema } from './core/message.js';
export type { MessageJSON, MessageRole } from './core/message.js';
export {
  LLMResponse,
  LLMToolResponse,
  StreamStats,
  llmResponseSchema,
  llmToolResponseSchema,
  parseLLMResponse,
  parseLLMToolResponse,
  parseStreamStats,
  streamStatsSchema,
  toolCallSchema
} from './core/responses.js';
export type { LLMResponseJSON, StreamStatsJSON, ToolCall } from './core/responses.js';
export {
  AgentEvent,
  ExecutionContext,
  agentEventSchema,
  eventTypeSchema
} from './core/lifecycle.js';
export type { AgentEventJSON, EventType, LifecycleHook } from './core/lifecycle.js';
export { SessionData, parseSessionData, sessionDataSchema } from './core/session-data.js';
export type { SessionDataJSON } from './core/session-data.js';

export const version = '0.0.0-development';

export const metadata = Object.freeze({
  name: '@junlang-7/helloagents',
  upstream: 'https://github.com/jjyaoao/HelloAgents',
  license: 'CC-BY-NC-SA-4.0'
});
