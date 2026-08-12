import { z } from 'zod';
import { LLMError, parseOrThrow } from './errors.js';

const usageSchema = z.record(z.string(), z.number().int()).default({});
export const toolCallSchema = z
  .object({ id: z.string(), name: z.string(), arguments: z.string() })
  .strict();
export const llmResponseSchema = z
  .object({
    content: z.string(),
    model: z.string(),
    usage: usageSchema,
    latency_ms: z.number().int().nonnegative().default(0),
    reasoning_content: z.string().nullable().optional()
  })
  .strict();
export const llmToolResponseSchema = z
  .object({
    content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema),
    model: z.string(),
    usage: usageSchema,
    latency_ms: z.number().int().nonnegative().default(0)
  })
  .strict();
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
export type LLMResponseJSON = Omit<LLMResponseData, 'reasoning_content'> & {
  reasoning_content?: string;
};
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
  public toJSON(): LLMResponseJSON {
    return responseJSON(this.value);
  }
  public toString() {
    return this.content;
  }
}
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
  public toJSON() {
    return this.value;
  }
}
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
  public toJSON(): StreamStatsJSON {
    return streamStatsJSON(this.value);
  }
}
export const parseLLMResponse = (input: unknown) =>
  new LLMResponse(parseOrThrow(llmResponseSchema, input, 'LLMResponse', LLMError));
export const parseLLMToolResponse = (input: unknown) =>
  new LLMToolResponse(parseOrThrow(llmToolResponseSchema, input, 'LLMToolResponse', LLMError));
export const parseStreamStats = (input: unknown) =>
  new StreamStats(parseOrThrow(streamStatsSchema, input, 'StreamStats', LLMError));
