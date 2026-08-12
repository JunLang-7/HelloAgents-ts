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
export {
  AnthropicAdapter,
  GeminiAdapter,
  OpenAIAdapter,
  createAdapter
} from './adapters/providers.js';
export type { FetchLike } from './adapters/providers.js';
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
export { StreamBuffer, streamToJsonLines, streamToSse } from './core/streaming.js';
export { SessionData, parseSessionData, sessionDataSchema } from './core/session-data.js';
export type { SessionDataJSON } from './core/session-data.js';
export { ToolErrorCode, getAllToolErrorCodes, isToolErrorCode } from './tools/errors.js';
export type { ToolErrorCode as ToolErrorCodeValue } from './tools/errors.js';
export { ToolResponse, ToolStatus, toolResponseSchema } from './tools/response.js';
export type {
  ToolErrorInfo,
  ToolResponseJSON,
  ToolStatus as ToolStatusValue
} from './tools/response.js';
export {
  FunctionTool,
  Tool,
  expandableTool,
  toolAction,
  toolParameterSchema
} from './tools/tool.js';
export type {
  ExpandableTool,
  FunctionToolOptions,
  OpenAIToolSchema,
  ToolOptions,
  ToolParameter
} from './tools/tool.js';
export { ToolRegistry, globalRegistry } from './tools/registry.js';
export { CircuitBreaker } from './tools/circuit-breaker.js';
export type {
  CircuitBreakerOptions,
  CircuitState,
  CircuitStatus
} from './tools/circuit-breaker.js';
export type { ToolRegistryOptions } from './tools/registry.js';
export { TokenCounter } from './context/token-counter.js';
export type { TokenCounterOptions, TokenCounterStats } from './context/token-counter.js';
export { HistoryManager } from './context/history-manager.js';
export type { HistoryManagerOptions } from './context/history-manager.js';
export { ObservationTruncator } from './context/observation-truncator.js';
export type {
  ObservationTruncatorOptions,
  TruncationReason,
  TruncationResult
} from './context/observation-truncator.js';
export { WorkingMemory } from './context/working-memory.js';
export type { WorkingMemoryItem, WorkingMemoryOptions } from './context/working-memory.js';
export { ContextBuilder } from './context/context-builder.js';
export type {
  BuildContextOptions,
  ContextBuilderOptions,
  ContextPacket
} from './context/context-builder.js';
export { SimpleAgent } from './agents/simple-agent.js';
export type {
  AgentInvocationOptions,
  AgentLifecycleOptions,
  SimpleAgentOptions
} from './agents/simple-agent.js';
export { DEFAULT_REACT_SYSTEM_PROMPT, ReActAgent } from './agents/react-agent.js';
export type { ReActAgentOptions, ReActSessionMetadata } from './agents/react-agent.js';

export const version = '0.0.0-development';

export const metadata = Object.freeze({
  name: '@junlang-7/helloagents',
  upstream: 'https://github.com/jjyaoao/HelloAgents',
  license: 'CC-BY-NC-SA-4.0'
});
