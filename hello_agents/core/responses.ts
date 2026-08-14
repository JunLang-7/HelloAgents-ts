import { z } from 'zod';
import { LLMError, parseOrThrow } from './errors.js';

const usageSchema = z.record(z.string(), z.number().int()).default({});
/** Validates one provider tool call in normalized form. */
export const toolCallSchema = z
  .object({ id: z.string(), name: z.string(), arguments: z.string() })
  .strict();
/** Validates a text-only normalized LLM response. */
export const llmResponseSchema = z
  .object({
    content: z.string(),
    model: z.string(),
    usage: usageSchema,
    latency_ms: z.number().int().nonnegative().default(0),
    reasoning_content: z.string().nullable().optional()
  })
  .strict();
/** Validates a normalized response that may contain function calls. */
export const llmToolResponseSchema = z
  .object({
    content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema),
    model: z.string(),
    usage: usageSchema,
    latency_ms: z.number().int().nonnegative().default(0)
  })
  .strict();
/** Validates usage statistics reported after a stream. */
export const streamStatsSchema = z
  .object({
    model: z.string(),
    usage: usageSchema,
    latency_ms: z.number().int().nonnegative().default(0),
    reasoning_content: z.string().nullable().optional()
  })
  .strict();
export type ToolCall = z.output<typeof toolCallSchema>;
type LLMResponseData = z.output<typeof llmResponseSchema>;
type LLMToolResponseData = z.output<typeof llmToolResponseSchema>;
type StreamStatsData = z.output<typeof streamStatsSchema>;
/** Serialized shape of a text response. */
export type LLMResponseJSON = Omit<LLMResponseData, 'reasoning_content'> & {
  reasoning_content?: string;
};
/** Serialized shape of stream usage statistics. */
export type StreamStatsJSON = Omit<StreamStatsData, 'reasoning_content'> & {
  reasoning_content?: string;
};
function responseJSON(value: LLMResponseData): LLMResponseJSON {
  const { reasoning_content: reasoningContent, ...rest } = value;
  return reasoningContent ? { ...rest, reasoning_content: reasoningContent } : rest;
}
function streamStatsJSON(value: StreamStatsData): StreamStatsJSON {
  const { reasoning_content: reasoningContent, ...rest } = value;
  return reasoningContent ? { ...rest, reasoning_content: reasoningContent } : rest;
}
/** Validated text response with convenient camelCase accessors. */
export class LLMResponse {
  public constructor(private readonly value: LLMResponseData) {}
  get content() {
    return this.value.content;
  }
  get model() {
    return this.value.model;
  }
  get usage() {
    return this.value.usage;
  }
  get latencyMs() {
    return this.value.latency_ms;
  }
  get reasoningContent() {
    return this.value.reasoning_content ?? null;
  }
  /** Serializes the response using the wire protocol field names. */
  public toJSON(): LLMResponseJSON {
    return responseJSON(this.value);
  }
  public toString() {
    return this.content;
  }
}
/** Validated response containing zero or more tool calls. */
export class LLMToolResponse {
  public constructor(private readonly value: LLMToolResponseData) {}
  get content() {
    return this.value.content;
  }
  get toolCalls() {
    return this.value.tool_calls;
  }
  get model() {
    return this.value.model;
  }
  get usage() {
    return this.value.usage;
  }
  get latencyMs() {
    return this.value.latency_ms;
  }
  /** Serializes the complete tool response. */
  public toJSON() {
    return this.value;
  }
}
/** Usage statistics captured for a completed stream. */
export class StreamStats {
  public constructor(private readonly value: StreamStatsData) {}
  get model() {
    return this.value.model;
  }
  get usage() {
    return this.value.usage;
  }
  get latencyMs() {
    return this.value.latency_ms;
  }
  get reasoningContent() {
    return this.value.reasoning_content ?? null;
  }
  /** Serializes statistics using snake_case field names. */
  public toJSON(): StreamStatsJSON {
    return streamStatsJSON(this.value);
  }
}
/** Validates and wraps an unknown provider response. */
export const parseLLMResponse = (input: unknown) =>
  new LLMResponse(parseOrThrow(llmResponseSchema, input, 'LLMResponse', LLMError));
/** Validates and wraps an unknown provider tool response. */
export const parseLLMToolResponse = (input: unknown) =>
  new LLMToolResponse(parseOrThrow(llmToolResponseSchema, input, 'LLMToolResponse', LLMError));
/** Validates and wraps unknown stream statistics. */
export const parseStreamStats = (input: unknown) =>
  new StreamStats(parseOrThrow(streamStatsSchema, input, 'StreamStats', LLMError));
