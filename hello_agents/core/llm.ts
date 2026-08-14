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
import type { LLMResponse, LLMToolResponse, StreamStats } from './responses.js';

const environmentSchema = z.record(z.string(), z.string().optional());
const toolSchema = z.record(z.string(), z.unknown());
const adapterCallOptionsSchema = z
  .object({
    temperature: z.number().finite().optional(),
    maxTokens: z.number().int().positive().optional(),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
    signal: z
      .custom<AbortSignal>((value) => value instanceof AbortSignal, 'Expected AbortSignal')
      .optional()
  })
  .strict();

export interface HelloAgentsLLMOptions {
  /** Model identifier passed to the provider. Falls back to `LLM_MODEL_ID`. */
  readonly model?: string;
  /** Provider credential. Falls back to `LLM_API_KEY`. */
  readonly apiKey?: string;
  /** Provider endpoint. Falls back to `LLM_BASE_URL`. */
  readonly baseUrl?: string;
  /** Default sampling temperature for calls that do not override it. */
  readonly temperature?: number;
  /** Default maximum completion tokens. */
  readonly maxTokens?: number;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Fully custom adapter, useful for local providers and tests. */
  readonly adapter?: BaseLLMAdapter;
  /** Factory used to construct an adapter after environment values are resolved. */
  readonly adapterFactory?: LLMAdapterFactory;
  /** Environment map to read instead of the process environment. */
  readonly env?: Record<string, string | undefined>;
}

/** Options shared by invoke, tool invocation, and streaming calls. */
export type LLMInvokeOptions = AdapterCallOptions;

function runtimeEnvironment(): Record<string, string | undefined> {
  return typeof process === 'undefined' ? {} : { ...process.env };
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new LLMError(`Missing required LLM ${label}`);
  return value;
}

function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined) return 60_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new LLMError('Invalid LLM_TIMEOUT');
  return seconds * 1000;
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
  public readonly timeoutMs: number;
  public readonly temperature: number;
  public readonly maxTokens: number | undefined;
  public readonly adapter: BaseLLMAdapter;
  public lastCallStats: StreamStats | undefined;

  /** Creates a provider-neutral LLM client from explicit options or environment variables. */
  public constructor(options: HelloAgentsLLMOptions) {
    const env = parseOrThrow(
      environmentSchema,
      options.env ?? runtimeEnvironment(),
      'LLM environment',
      LLMError
    );
    this.model = required(options.model ?? env.LLM_MODEL_ID, 'model (model or LLM_MODEL_ID)');
    this.apiKey = required(options.apiKey ?? env.LLM_API_KEY, 'API key (apiKey or LLM_API_KEY)');
    this.baseUrl = required(
      options.baseUrl ?? env.LLM_BASE_URL,
      'base URL (baseUrl or LLM_BASE_URL)'
    );
    this.timeoutMs = options.timeoutMs ?? parseTimeoutMs(env.LLM_TIMEOUT);
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens;

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

  /** Sends chat messages and validates the normalized provider response. */
  public async invoke(
    messages: readonly LLMMessage[],
    options?: LLMInvokeOptions
  ): Promise<LLMResponse> {
    const timed = this.withTimeout(this.request(messages, options));
    try {
      const raw = await this.adapter.invoke(timed.request);
      normalizeAbort(timed.request.options.signal);
      return parseLLMResponse(raw);
    } catch (error) {
      return normalizeFailure(error, 'invoke', timed.request.options.signal);
    } finally {
      timed.dispose();
    }
  }

  /** Sends chat messages with tool schemas and returns validated tool calls. */
  public async invokeWithTools(
    messages: readonly LLMMessage[],
    tools: readonly Record<string, unknown>[],
    toolChoice: ToolChoice = 'auto',
    options?: LLMInvokeOptions
  ): Promise<LLMToolResponse> {
    const timed = this.withTimeout(this.request(messages, options));
    const validatedTools = parseOrThrow(z.array(toolSchema), tools, 'LLM tools', LLMError);
    const validatedChoice = parseOrThrow(toolChoiceSchema, toolChoice, 'LLM tool choice', LLMError);
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

  /** Streams text chunks and records provider usage statistics when available. */
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

  /** Compatibility alias for `stream`. */
  public think(messages: readonly LLMMessage[], options?: LLMInvokeOptions): AsyncIterable<string> {
    return this.stream(messages, options);
  }

  /** Compatibility alias for `stream`. */
  public streamInvoke(
    messages: readonly LLMMessage[],
    options?: LLMInvokeOptions
  ): AsyncIterable<string> {
    return this.stream(messages, options);
  }

  public ainvoke(
    messages: readonly LLMMessage[],
    options?: LLMInvokeOptions
  ): Promise<LLMResponse> {
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
