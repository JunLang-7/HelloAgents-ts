import { z } from 'zod';

/** 校验与提供商无关的聊天消息契约。 */
export const llmMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant', 'system', 'tool', 'summary']),
    content: z.string().nullable().optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional()
  })
  .passthrough();
/** 与提供商无关的聊天消息。 */
export type LLMMessage = z.output<typeof llmMessageSchema>;

/** 校验接受的工具选择策略。 */
export const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z
    .object({
      type: z.literal('function'),
      function: z.object({ name: z.string().min(1) }).passthrough()
    })
    .passthrough()
]);
/** 发送给提供商适配器的工具选择策略。 */
export type ToolChoice = z.output<typeof toolChoiceSchema>;

export interface AdapterConfig {
  /** 发送给提供商的模型标识。 */
  readonly model: string;
  /** 提供商凭证。 */
  readonly apiKey: string;
  /** 提供商端点。 */
  readonly baseUrl: string;
  /** 超时时间（毫秒）。 */
  readonly timeoutMs: number;
}

export interface AdapterCallOptions {
  /** 采样温度覆盖值。 */
  readonly temperature?: number | undefined;
  /** 最大生成 token 数覆盖值。 */
  readonly maxTokens?: number | undefined;
  /** 提供商专用请求选项。 */
  readonly providerOptions?: Record<string, unknown> | undefined;
  /** 调用方取消信号。 */
  readonly signal?: AbortSignal | undefined;
}

/** invoke 和 stream 操作共用的标准化请求。 */
export interface AdapterRequest {
  readonly messages: readonly LLMMessage[];
  readonly options: AdapterCallOptions;
}

/** 携带 Function Calling 模式的标准化请求。 */
export interface AdapterToolRequest extends AdapterRequest {
  readonly tools: readonly Record<string, unknown>[];
  readonly toolChoice: ToolChoice;
}

/** 与提供商无关的适配器协议。 */
export interface BaseLLMAdapter {
  /** 实现暴露时可读取的提供商配置。 */
  readonly config?: AdapterConfig;
  /** 最近一次完成流式调用的使用统计。 */
  readonly lastStats?: unknown;
  /** 执行一次文本补全。 */
  invoke(request: AdapterRequest): Promise<unknown>;
  /** 流式返回一次请求的提供商数据块。 */
  stream(request: AdapterRequest): AsyncIterable<unknown>;
  /** 执行一次带 Function Calling 工具的补全。 */
  invokeWithTools(request: AdapterToolRequest): Promise<unknown>;
}

/** 根据标准化提供商配置创建适配器。 */
export type LLMAdapterFactory = (config: AdapterConfig) => BaseLLMAdapter;
