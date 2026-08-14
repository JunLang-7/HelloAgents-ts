import { z } from 'zod';
import { LLMError, parseOrThrow } from './errors.js';

const usageSchema = z.record(z.string(), z.number().int()).default({});
/** 校验一个标准化的提供商工具调用。 */
export const toolCallSchema = z
  .object({ id: z.string(), name: z.string(), arguments: z.string() })
  .strict();
/** 校验纯文本的标准化 LLM 响应。 */
export const llmResponseSchema = z
  .object({
    content: z.string(),
    model: z.string(),
    usage: usageSchema,
    latency_ms: z.number().int().nonnegative().default(0),
    reasoning_content: z.string().nullable().optional()
  })
  .strict();
/** 校验可能包含函数调用的标准化响应。 */
export const llmToolResponseSchema = z
  .object({
    content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema),
    model: z.string(),
    usage: usageSchema,
    latency_ms: z.number().int().nonnegative().default(0)
  })
  .strict();
/** 校验流式调用结束后报告的使用统计。 */
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
/** 文本响应的序列化格式。 */
export type LLMResponseJSON = Omit<LLMResponseData, 'reasoning_content'> & {
  reasoning_content?: string;
};
/** 流式调用统计的序列化格式。 */
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
/** 校验后的文本响应，提供便捷的 camelCase 访问器。 */
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
  /** 使用线协议字段名序列化响应。 */
  public toJSON(): LLMResponseJSON {
    return responseJSON(this.value);
  }
  public toString() {
    return this.content;
  }
}
/** 校验后的工具调用响应。 */
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
  /** 序列化完整的工具调用响应。 */
  public toJSON() {
    return this.value;
  }
}
/** 已完成流式调用记录的使用统计。 */
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
  /** 使用 snake_case 字段名序列化统计信息。 */
  public toJSON(): StreamStatsJSON {
    return streamStatsJSON(this.value);
  }
}
/** 校验未知的提供商响应并包装为 LLMResponse。 */
export const parseLLMResponse = (input: unknown) =>
  new LLMResponse(parseOrThrow(llmResponseSchema, input, 'LLMResponse', LLMError));
/** 校验未知的提供商工具响应并包装为 LLMToolResponse。 */
export const parseLLMToolResponse = (input: unknown) =>
  new LLMToolResponse(parseOrThrow(llmToolResponseSchema, input, 'LLMToolResponse', LLMError));
/** 校验未知的流式统计并包装为 StreamStats。 */
export const parseStreamStats = (input: unknown) =>
  new StreamStats(parseOrThrow(streamStatsSchema, input, 'StreamStats', LLMError));
