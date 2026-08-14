import { z } from 'zod';

/** Validates the provider-neutral chat message contract. */
export const llmMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'system', 'tool', 'summary']),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional()
  })
  .passthrough();
/** Provider-neutral chat message. */
export type LLMMessage = z.output<typeof llmMessageSchema>;

/** Validates accepted tool-choice policies. */
export const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z
    .object({
      type: z.literal('function'),
      function: z.object({ name: z.string().min(1) }).passthrough()
    })
    .passthrough()
]);
/** Tool-choice policy sent to a provider adapter. */
export type ToolChoice = z.output<typeof toolChoiceSchema>;

export interface AdapterConfig {
  /** Model identifier sent to the provider. */
  readonly model: string;
  /** Provider credential. */
  readonly apiKey: string;
  /** Provider endpoint. */
  readonly baseUrl: string;
  /** Abort timeout in milliseconds. */
  readonly timeoutMs: number;
}

export interface AdapterCallOptions {
  /** Sampling temperature override. */
  readonly temperature?: number | undefined;
  /** Maximum completion token override. */
  readonly maxTokens?: number | undefined;
  /** Provider-specific request options. */
  readonly providerOptions?: Record<string, unknown> | undefined;
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal | undefined;
}

/** Normalized request shared by invoke and stream operations. */
export interface AdapterRequest {
  readonly messages: readonly LLMMessage[];
  readonly options: AdapterCallOptions;
}

/** Normalized request carrying function-calling schemas. */
export interface AdapterToolRequest extends AdapterRequest {
  readonly tools: readonly Record<string, unknown>[];
  readonly toolChoice: ToolChoice;
}

/** Provider-neutral adapter contract. Provider implementations belong to #16. */
export interface BaseLLMAdapter {
  /** Provider configuration, when exposed by the implementation. */
  readonly config?: AdapterConfig;
  /** Usage statistics captured by the latest completed stream. */
  readonly lastStats?: unknown;
  /** Performs one text completion. */
  invoke(request: AdapterRequest): Promise<unknown>;
  /** Streams provider chunks for one request. */
  stream(request: AdapterRequest): AsyncIterable<unknown>;
  /** Performs one completion with function-calling tools. */
  invokeWithTools(request: AdapterToolRequest): Promise<unknown>;
}

/** Constructs an adapter from normalized provider configuration. */
export type LLMAdapterFactory = (config: AdapterConfig) => BaseLLMAdapter;
