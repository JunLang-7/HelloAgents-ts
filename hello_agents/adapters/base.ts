import { z } from 'zod';

export const llmMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'system', 'tool', 'summary']),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional()
  })
  .passthrough();
export type LLMMessage = z.output<typeof llmMessageSchema>;

export const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z
    .object({
      type: z.literal('function'),
      function: z.object({ name: z.string().min(1) }).passthrough()
    })
    .passthrough()
]);
export type ToolChoice = z.output<typeof toolChoiceSchema>;

export interface AdapterConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export interface AdapterCallOptions {
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly providerOptions?: Record<string, unknown> | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AdapterRequest {
  readonly messages: readonly LLMMessage[];
  readonly options: AdapterCallOptions;
}

export interface AdapterToolRequest extends AdapterRequest {
  readonly tools: readonly Record<string, unknown>[];
  readonly toolChoice: ToolChoice;
}

/** Provider-neutral adapter contract. Provider implementations belong to #16. */
export interface BaseLLMAdapter {
  readonly config?: AdapterConfig;
  readonly lastStats?: unknown;
  invoke(request: AdapterRequest): Promise<unknown>;
  stream(request: AdapterRequest): AsyncIterable<unknown>;
  invokeWithTools(request: AdapterToolRequest): Promise<unknown>;
}

export type LLMAdapterFactory = (config: AdapterConfig) => BaseLLMAdapter;
