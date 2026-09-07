import { z } from 'zod';

import type {
  AdapterCallOptions,
  AdapterConfig,
  AdapterRequest,
  BaseLLMAdapter,
  LLMAdapterFactory,
  LLMMessage,
  ToolChoice
} from '../adapters/base.js';
import { llmMessageSchema, toolChoiceSchema } from '../adapters/base.js';
import { createAdapter } from '../adapters/providers.js';
import { LLMAbortError, LLMError, LLMTimeoutError, parseOrThrow } from './errors.js';
import { parseLLMResponse, parseLLMToolResponse, parseStreamStats } from './responses.js';
import type { LLMToolResponse, StreamStats } from './responses.js';

const environmentSchema = z.record(z.string(), z.string().optional());
const toolSchema = z.record(z.string(), z.unknown());
const temperatureSchema = z.number().finite().min(0).max(2);
const maxTokensSchema = z.number().int().positive();
const adapterCallOptionsSchema = z
  .object({
    temperature: temperatureSchema.optional(),
    maxTokens: maxTokensSchema.optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    signal: z
      .custom<AbortSignal>((value) => value instanceof AbortSignal, 'Expected AbortSignal')
      .optional()
  })
  .strict();

export const SUPPORTED_PROVIDERS = [
  'openai',
  'deepseek',
  'qwen',
  'modelscope',
  'kimi',
  'zhipu',
  'ollama',
  'vllm',
  'local',
  'auto',
  'custom'
] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export interface HelloAgentsLLMOptions {
  /** 模型名称；未提供时按 provider 或 `LLM_MODEL_ID` 推断。 */
  readonly model?: string;
  /** 提供商凭证；未提供时遵循 provider-specific、再到 `LLM_API_KEY`。 */
  readonly apiKey?: string;
  /** OpenAI-compatible 服务地址；未提供时按 provider 或 `LLM_BASE_URL` 推断。 */
  readonly baseUrl?: string;
  /** 提供商；未提供时执行上游的自动检测。 */
  readonly provider?: SupportedProvider | string;
  /** 调用未覆盖时使用的默认采样温度。 */
  readonly temperature?: number;
  /** 默认最大生成 token 数。 */
  readonly maxTokens?: number;
  /** 单次请求超时（秒），对应 Python `timeout`。 */
  readonly timeout?: number;
  /** 毫秒形式的 TypeScript 兼容选项。 */
  readonly timeoutMs?: number;
  /** 自定义适配器，可用于本地提供商和测试。 */
  readonly adapter?: BaseLLMAdapter;
  /** 环境变量解析完成后用于创建适配器的工厂函数。 */
  readonly adapterFactory?: LLMAdapterFactory;
  /** 要读取的环境变量映射；不传时读取进程环境。 */
  readonly env?: Record<string, string | undefined>;
}

/** invoke、工具调用和流式调用共用的选项。 */
export type LLMInvokeOptions = AdapterCallOptions;

function runtimeEnvironment(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : { ...process.env };
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new LLMError(`API密钥和服务地址必须被提供或在.env文件中定义。 (${label})`);
  return value;
}

function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined) return 60_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new LLMError('Invalid LLM_TIMEOUT');
  return seconds * 1000;
}

function validateConstructorNumber(
  value: number | undefined,
  schema: z.ZodType<number>,
  label: string
): number | undefined {
  return value === undefined ? undefined : parseOrThrow(schema, value, label, LLMError);
}

const providerDefaults: Record<
  Exclude<SupportedProvider, 'auto' | 'custom'>,
  { baseUrl: string; model: string }
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-3.5-turbo' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  modelscope: {
    baseUrl: 'https://api-inference.modelscope.cn/v1/',
    model: 'Qwen/Qwen2.5-72B-Instruct'
  },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
  vllm: { baseUrl: 'http://localhost:8000/v1', model: 'meta-llama/Llama-2-7b-chat-hf' },
  local: { baseUrl: 'http://localhost:8000/v1', model: 'local-model' }
};

function detectProviderFromUrl(baseUrl: string, apiKey?: string): SupportedProvider {
  const actualUrl = baseUrl.toLowerCase();
  if (actualUrl.includes('api.openai.com')) return 'openai';
  if (actualUrl.includes('api.deepseek.com')) return 'deepseek';
  if (actualUrl.includes('dashscope.aliyuncs.com')) return 'qwen';
  if (actualUrl.includes('api-inference.modelscope.cn')) return 'modelscope';
  if (actualUrl.includes('api.moonshot.cn')) return 'kimi';
  if (actualUrl.includes('open.bigmodel.cn')) return 'zhipu';
  if (actualUrl.includes('localhost') || actualUrl.includes('127.0.0.1')) {
    if (actualUrl.includes(':11434') || actualUrl.includes('ollama')) return 'ollama';
    if (actualUrl.includes(':8000') && actualUrl.includes('vllm')) return 'vllm';
    if (actualUrl.includes(':8080') || actualUrl.includes(':7860')) return 'local';
    if (apiKey?.toLowerCase() === 'ollama') return 'ollama';
    if (apiKey?.toLowerCase() === 'vllm') return 'vllm';
    return 'local';
  }
  if ([':8080', ':7860', ':5000'].some((port) => actualUrl.includes(port))) return 'local';
  return 'auto';
}

function autoDetectProvider(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  env: Record<string, string | undefined>
): SupportedProvider {
  // An explicitly supplied endpoint identifies the target more reliably than
  // credentials inherited from an unrelated provider in the environment.
  if (baseUrl) {
    const detected = detectProviderFromUrl(baseUrl, apiKey ?? env.LLM_API_KEY);
    if (detected !== 'auto') return detected;
    // Provider hosts are endpoint signals too; retain their existing fallback
    // for generic LLM_BASE_URL values without consulting provider credentials.
    if (env.OLLAMA_HOST) return 'ollama';
    if (env.VLLM_HOST) return 'vllm';
    return 'auto';
  }
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.DEEPSEEK_API_KEY) return 'deepseek';
  if (env.DASHSCOPE_API_KEY) return 'qwen';
  if (env.MODELSCOPE_API_KEY) return 'modelscope';
  if (env.KIMI_API_KEY || env.MOONSHOT_API_KEY) return 'kimi';
  if (env.ZHIPU_API_KEY || env.GLM_API_KEY) return 'zhipu';
  if (env.OLLAMA_API_KEY || env.OLLAMA_HOST) return 'ollama';
  if (env.VLLM_API_KEY || env.VLLM_HOST) return 'vllm';

  const actualKey = apiKey ?? env.LLM_API_KEY;
  if (actualKey) {
    const lower = actualKey.toLowerCase();
    if (actualKey.startsWith('ms-')) return 'modelscope';
    if (lower === 'ollama') return 'ollama';
    if (lower === 'vllm') return 'vllm';
    if (lower === 'local') return 'local';
    if (actualKey.endsWith('.') || actualKey.slice(-20).includes('.')) return 'zhipu';
  }
  return 'auto';
}

function providerCredential(
  provider: string,
  apiKey: string | undefined,
  env: Record<string, string | undefined>
): string | undefined {
  const providerEnv: Record<string, string | undefined> = {
    openai: env.OPENAI_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
    qwen: env.DASHSCOPE_API_KEY,
    modelscope: env.MODELSCOPE_API_KEY,
    kimi: env.KIMI_API_KEY ?? env.MOONSHOT_API_KEY,
    zhipu: env.ZHIPU_API_KEY ?? env.GLM_API_KEY,
    ollama: env.OLLAMA_API_KEY,
    vllm: env.VLLM_API_KEY
  };
  return apiKey || providerEnv[provider] || env.LLM_API_KEY;
}

function normalizeAbort(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof LLMTimeoutError) throw signal.reason;
  throw new LLMAbortError('LLM request aborted', signal.reason);
}

function normalizeFailure(
  error: unknown,
  operation: string,
  signal: AbortSignal | undefined
): never {
  if (signal?.aborted) {
    if (signal.reason instanceof LLMTimeoutError) throw signal.reason;
    throw new LLMAbortError('LLM request aborted', signal.reason ?? error);
  }
  if (error instanceof LLMError) throw error;
  throw new LLMError(`LLM ${operation} failed`, error);
}

function normalizeMessages(messages: unknown): readonly LLMMessage[] {
  return parseOrThrow(z.array(llmMessageSchema), messages, 'LLM messages', LLMError);
}

function normalizeOptions(options: unknown): AdapterCallOptions {
  return parseOrThrow(adapterCallOptionsSchema, options, 'LLM call options', LLMError);
}

export class HelloAgentsLLM {
  public readonly model: string;
  public readonly apiKey: string;
  public readonly baseUrl: string;
  public readonly provider: string;
  /** Python timeout value in seconds. */
  public readonly timeout: number;
  public readonly timeoutMs: number;
  public readonly temperature: number;
  public readonly maxTokens: number | undefined;
  public readonly adapter: BaseLLMAdapter;
  public lastCallStats: StreamStats | undefined;

  /** 从显式选项或环境变量创建与提供商无关的 LLM 客户端。 */
  public constructor(options: HelloAgentsLLMOptions = {}) {
    const env = parseOrThrow(
      environmentSchema,
      options.env ?? runtimeEnvironment(),
      'LLM environment',
      LLMError
    );
    const requestedProvider = options.provider?.toLowerCase();
    const provider =
      requestedProvider && requestedProvider !== 'auto'
        ? requestedProvider
        : autoDetectProvider(options.apiKey, options.baseUrl || env.LLM_BASE_URL, env);
    this.provider = provider;

    const defaults = providerDefaults[provider as keyof typeof providerDefaults];
    const providerHost =
      provider === 'ollama' ? env.OLLAMA_HOST : provider === 'vllm' ? env.VLLM_HOST : undefined;
    const baseUrl = options.baseUrl || providerHost || env.LLM_BASE_URL || defaults?.baseUrl;
    const apiKey =
      provider === 'ollama'
        ? providerCredential(provider, options.apiKey, env) || 'ollama'
        : provider === 'vllm'
          ? providerCredential(provider, options.apiKey, env) || 'vllm'
          : provider === 'local'
            ? providerCredential(provider, options.apiKey, env) || 'local'
            : providerCredential(provider, options.apiKey, env);
    const model = options.model || env.LLM_MODEL_ID || defaults?.model || 'gpt-3.5-turbo';

    this.model = required(model, 'model');
    this.apiKey = required(apiKey, 'API key');
    this.baseUrl = required(baseUrl, 'base URL');
    this.temperature =
      validateConstructorNumber(options.temperature, temperatureSchema, 'LLM temperature') ?? 0.7;
    this.maxTokens = validateConstructorNumber(options.maxTokens, maxTokensSchema, 'LLM maxTokens');
    this.timeoutMs =
      options.timeoutMs === undefined
        ? options.timeout === undefined
          ? parseTimeoutMs(env.LLM_TIMEOUT)
          : (() => {
              if (!Number.isFinite(options.timeout) || options.timeout <= 0)
                throw new LLMError('Invalid timeout');
              return options.timeout * 1000;
            })()
        : validateConstructorNumber(
            options.timeoutMs,
            z.number().int().positive(),
            'LLM timeoutMs'
          )!;
    this.timeout = this.timeoutMs / 1000;

    const config: AdapterConfig = {
      model: this.model,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs
    };
    this.adapter = options.adapter ?? options.adapterFactory?.(config) ?? createAdapter(config);
  }

  private callOptions(options: LLMInvokeOptions | undefined): AdapterCallOptions {
    const parsed = normalizeOptions(options ?? {});
    return {
      temperature: parsed.temperature ?? this.temperature,
      ...(parsed.maxTokens === undefined
        ? this.maxTokens === undefined
          ? {}
          : { maxTokens: this.maxTokens }
        : { maxTokens: parsed.maxTokens }),
      ...(parsed.providerOptions === undefined ? {} : { providerOptions: parsed.providerOptions }),
      ...(parsed.signal === undefined ? {} : { signal: parsed.signal })
    };
  }

  private request(messages: unknown, options: LLMInvokeOptions | undefined): AdapterRequest {
    const callOptions = this.callOptions(options);
    normalizeAbort(callOptions.signal);
    return { messages: normalizeMessages(messages), options: callOptions };
  }

  private withTimeout(request: AdapterRequest): { request: AdapterRequest; dispose: () => void } {
    const timeoutController = new AbortController();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort(
        new LLMTimeoutError(`LLM request timed out after ${this.timeoutMs}ms`)
      );
    }, this.timeoutMs);
    const inputSignal = request.options.signal;
    const onInputAbort = () => controller.abort(inputSignal?.reason);
    const onTimeoutAbort = () => controller.abort(timeoutController.signal.reason);

    inputSignal?.addEventListener('abort', onInputAbort, { once: true });
    timeoutController.signal.addEventListener('abort', onTimeoutAbort, { once: true });
    if (inputSignal?.aborted) onInputAbort();

    return {
      request: { ...request, options: { ...request.options, signal: controller.signal } },
      dispose: () => {
        clearTimeout(timeoutId);
        inputSignal?.removeEventListener('abort', onInputAbort);
        timeoutController.signal.removeEventListener('abort', onTimeoutAbort);
      }
    };
  }

  /**
   * 发送聊天消息，并校验标准化的提供商响应。
   *
   * @param messages 聊天消息列表。
   * @param options 本次调用的 LLM 选项。
   * @returns 标准化的 LLM 响应对象。
   */
  public async invoke(
    messages: readonly LLMMessage[],
    options?: LLMInvokeOptions
  ): Promise<string> {
    const timed = this.withTimeout(this.request(messages, options));
    try {
      const raw = await this.adapter.invoke(timed.request);
      normalizeAbort(timed.request.options.signal);
      return parseLLMResponse(raw).content;
    } catch (error) {
      return normalizeFailure(error, 'invoke', timed.request.options.signal);
    } finally {
      timed.dispose();
    }
  }

  /**
   * 携带工具模式发送聊天消息，并返回校验后的工具调用。
   *
   * @param messages 聊天消息列表。
   * @param tools 可供模型调用的工具模式。
   * @param toolChoice 工具选择策略。
   * @param options 本次调用的 LLM 选项。
   * @returns 包含工具调用的标准化响应对象。
   */
  public async invokeWithTools(
    messages: readonly LLMMessage[],
    tools: readonly Record<string, unknown>[],
    toolChoice: ToolChoice = 'auto',
    options?: LLMInvokeOptions
  ): Promise<LLMToolResponse> {
    const request = this.request(messages, options);
    const validatedTools = parseOrThrow(z.array(toolSchema), tools, 'LLM tools', LLMError);
    const validatedChoice = parseOrThrow(toolChoiceSchema, toolChoice, 'LLM tool choice', LLMError);
    const timed = this.withTimeout(request);
    try {
      const raw = await this.adapter.invokeWithTools({
        ...timed.request,
        tools: validatedTools,
        toolChoice: validatedChoice
      });
      normalizeAbort(timed.request.options.signal);
      return parseLLMToolResponse(raw);
    } catch (error) {
      return normalizeFailure(error, 'tool invocation', timed.request.options.signal);
    } finally {
      timed.dispose();
    }
  }

  /**
   * 流式返回文本块；如果提供商返回统计信息则记录下来。
   *
   * @param messages 聊天消息列表。
   * @param options 本次调用的 LLM 选项。
   * @yields LLM 文本片段。
   */
  public async *stream(
    messages: readonly LLMMessage[],
    options?: LLMInvokeOptions
  ): AsyncIterable<string> {
    const timed = this.withTimeout(this.request(messages, options));
    try {
      for await (const rawChunk of this.adapter.stream(timed.request)) {
        normalizeAbort(timed.request.options.signal);
        yield parseOrThrow(z.string(), rawChunk, 'LLM stream chunk', LLMError);
      }
      normalizeAbort(timed.request.options.signal);
      if (this.adapter.lastStats !== undefined)
        this.lastCallStats = parseStreamStats(this.adapter.lastStats);
    } catch (error) {
      return normalizeFailure(error, 'stream', timed.request.options.signal);
    } finally {
      timed.dispose();
    }
  }

  /** `stream` 的兼容别名。 */
  public think(
    messages: readonly LLMMessage[],
    options?: LLMInvokeOptions | number
  ): AsyncIterable<string> {
    return this.stream(messages, typeof options === 'number' ? { temperature: options } : options);
  }

  /** `stream` 的兼容别名。 */
  public streamInvoke(
    messages: readonly LLMMessage[],
    options?: LLMInvokeOptions | number
  ): AsyncIterable<string> {
    const temperature = typeof options === 'number' ? options : options?.temperature;
    return this.stream(messages, temperature === undefined ? undefined : { temperature });
  }

  public ainvoke(messages: readonly LLMMessage[], options?: LLMInvokeOptions): Promise<string> {
    return this.invoke(messages, options);
  }

  public ainvokeWithTools(
    messages: readonly LLMMessage[],
    tools: readonly Record<string, unknown>[],
    toolChoice: ToolChoice = 'auto',
    options?: LLMInvokeOptions
  ): Promise<LLMToolResponse> {
    return this.invokeWithTools(messages, tools, toolChoice, options);
  }
}
