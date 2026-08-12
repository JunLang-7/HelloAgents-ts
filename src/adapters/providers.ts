import { z } from 'zod';

import type {
  AdapterConfig,
  AdapterRequest,
  AdapterToolRequest,
  BaseLLMAdapter,
  LLMMessage
} from './base.js';
import { LLMError, parseOrThrow } from '../core/errors.js';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const openAiResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z.array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  id: z.string(),
                  function: z.object({ name: z.string(), arguments: z.string() })
                })
              )
              .optional()
          })
          .optional(),
        delta: z
          .object({
            content: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional()
          })
          .optional()
      })
    ),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional()
      })
      .optional()
  })
  .passthrough();

const anthropicResponseSchema = z
  .object({
    content: z.array(
      z.union([
        z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
        z
          .object({
            type: z.literal('tool_use'),
            id: z.string(),
            name: z.string(),
            input: z.record(z.string(), z.unknown())
          })
          .passthrough()
      ])
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative()
      })
      .optional()
  })
  .passthrough();

const geminiResponseSchema = z
  .object({
    text: z.string().optional(),
    candidates: z
      .array(
        z.object({
          content: z.object({
            parts: z.array(
              z
                .object({
                  text: z.string().optional(),
                  functionCall: z
                    .object({
                      name: z.string(),
                      args: z.record(z.string(), z.unknown()).default({})
                    })
                    .optional()
                })
                .passthrough()
            )
          })
        })
      )
      .default([]),
    usageMetadata: z
      .object({
        promptTokenCount: z.number().int().nonnegative().optional(),
        candidatesTokenCount: z.number().int().nonnegative().optional(),
        totalTokenCount: z.number().int().nonnegative().optional()
      })
      .optional()
  })
  .passthrough();

type Usage = Record<string, number>;

function usageFromOpenAI(usage: z.infer<typeof openAiResponseSchema>['usage']): Usage {
  return usage
    ? {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0
      }
    : {};
}

function usageFromAnthropic(usage: z.infer<typeof anthropicResponseSchema>['usage']): Usage {
  return usage
    ? {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens
      }
    : {};
}

function usageFromGemini(usage: z.infer<typeof geminiResponseSchema>['usageMetadata']): Usage {
  return usage
    ? {
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        total_tokens: usage.totalTokenCount ?? 0
      }
    : {};
}

function endpoint(baseUrl: string, pathname: string): string {
  return new URL(pathname.replace(/^\//, ''), `${baseUrl.replace(/\/?$/, '/')}`).toString();
}

function toolCalls(message: LLMMessage): unknown[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls : [];
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolCallParts(message: LLMMessage): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (message.content) parts.push({ type: 'text', text: message.content });
  for (const call of toolCalls(message)) {
    const rawCall = object(call);
    const functionValue = object(rawCall.function);
    const rawArguments = functionValue.arguments;
    let input: Record<string, unknown> = {};
    if (typeof rawArguments === 'string') {
      try {
        input = object(JSON.parse(rawArguments));
      } catch {
        input = {};
      }
    } else {
      input = object(rawArguments);
    }
    parts.push({
      type: 'tool_use',
      id: typeof rawCall.id === 'string' ? rawCall.id : undefined,
      name: typeof functionValue.name === 'string' ? functionValue.name : undefined,
      input
    });
  }
  return parts;
}

function collectText(response: z.infer<typeof anthropicResponseSchema>): string {
  return response.content
    .filter(
      (block): block is Extract<(typeof response.content)[number], { type: 'text' }> =>
        block.type === 'text'
    )
    .map((block) => block.text)
    .join('');
}

async function responseJson(response: Response, provider: string): Promise<unknown> {
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new LLMError(`${provider} returned invalid JSON`);
  }
  if (!response.ok)
    throw new LLMError(`${provider} request failed with HTTP ${response.status}`, body);
  return body;
}

async function* sseEvents(response: Response, provider: string): AsyncIterable<unknown> {
  if (!response.body) throw new LLMError(`${provider} returned an empty stream`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        throw new LLMError(`${provider} stream contained invalid JSON`);
      }
    }
  }
}

abstract class FetchAdapter implements BaseLLMAdapter {
  public lastStats: unknown;
  public constructor(
    public readonly config: AdapterConfig,
    protected readonly fetchImpl: FetchLike = fetch
  ) {}

  protected async post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal })
      });
    } catch (error) {
      throw new LLMError('Provider network request failed', error);
    }
  }

  public abstract invoke(request: AdapterRequest): Promise<unknown>;
  public abstract stream(request: AdapterRequest): AsyncIterable<unknown>;
  public abstract invokeWithTools(request: AdapterToolRequest): Promise<unknown>;
}

export class OpenAIAdapter extends FetchAdapter {
  private body(
    request: AdapterRequest,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      model: this.config.model,
      messages: request.messages,
      ...(request.options.temperature === undefined
        ? {}
        : { temperature: request.options.temperature }),
      ...(request.options.maxTokens === undefined ? {} : { max_tokens: request.options.maxTokens }),
      ...(request.options.providerOptions ?? {}),
      ...extra
    };
  }
  private headers() {
    return { authorization: `Bearer ${this.config.apiKey}` };
  }
  public async invoke(request: AdapterRequest): Promise<unknown> {
    const started = Date.now();
    const raw = await responseJson(
      await this.post(
        endpoint(this.config.baseUrl, 'chat/completions'),
        this.headers(),
        this.body(request),
        request.options.signal
      ),
      'OpenAI'
    );
    const parsed = parseOrThrow(openAiResponseSchema, raw, 'OpenAI response', LLMError);
    const message = parsed.choices[0]?.message;
    if (!message) throw new LLMError('Invalid OpenAI response: choices.0.message');
    return {
      content: message.content ?? '',
      model: this.config.model,
      usage: usageFromOpenAI(parsed.usage),
      latency_ms: Date.now() - started,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {})
    };
  }
  public async *stream(request: AdapterRequest): AsyncIterable<unknown> {
    const started = Date.now();
    const response = await this.post(
      endpoint(this.config.baseUrl, 'chat/completions'),
      this.headers(),
      this.body(request, { stream: true, stream_options: { include_usage: true } }),
      request.options.signal
    );
    if (!response.ok) await responseJson(response, 'OpenAI');
    let usage: Usage = {};
    let reasoningContent = '';
    for await (const raw of sseEvents(response, 'OpenAI')) {
      const parsed = parseOrThrow(openAiResponseSchema, raw, 'OpenAI stream chunk', LLMError);
      usage = parsed.usage ? usageFromOpenAI(parsed.usage) : usage;
      const delta = parsed.choices[0]?.delta;
      if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
      if (delta?.content) yield delta.content;
    }
    this.lastStats = {
      model: this.config.model,
      usage,
      latency_ms: Date.now() - started,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
    };
  }
  public async invokeWithTools(request: AdapterToolRequest): Promise<unknown> {
    const started = Date.now();
    const raw = await responseJson(
      await this.post(
        endpoint(this.config.baseUrl, 'chat/completions'),
        this.headers(),
        this.body(request, { tools: request.tools, tool_choice: request.toolChoice }),
        request.options.signal
      ),
      'OpenAI'
    );
    const parsed = parseOrThrow(openAiResponseSchema, raw, 'OpenAI tool response', LLMError);
    const message = parsed.choices[0]?.message;
    if (!message) throw new LLMError('Invalid OpenAI tool response: choices.0.message');
    return {
      content: message.content ?? '',
      tool_calls: (message.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments
      })),
      model: this.config.model,
      usage: usageFromOpenAI(parsed.usage),
      latency_ms: Date.now() - started
    };
  }
}

export class AnthropicAdapter extends FetchAdapter {
  private headers() {
    return { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' };
  }
  private convertMessages(messages: readonly LLMMessage[]) {
    let system: string | undefined;
    const converted: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      if (message.role === 'system') {
        system = message.content ?? '';
        continue;
      }
      if (message.role === 'assistant' && toolCalls(message).length > 0) {
        converted.push({ role: 'assistant', content: toolCallParts(message) });
        continue;
      }
      if (message.role === 'tool') {
        converted.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content: message.content ?? ''
            }
          ]
        });
        continue;
      }
      converted.push({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content ?? ''
      });
    }
    return { system, messages: converted };
  }
  private body(request: AdapterRequest, extra: Record<string, unknown> = {}) {
    const converted = this.convertMessages(request.messages);
    return {
      model: this.config.model,
      messages: converted.messages,
      max_tokens: request.options.maxTokens ?? 4096,
      ...(converted.system ? { system: converted.system } : {}),
      ...(request.options.temperature === undefined
        ? {}
        : { temperature: request.options.temperature }),
      ...(request.options.providerOptions ?? {}),
      ...extra
    };
  }
  public async invoke(request: AdapterRequest): Promise<unknown> {
    const started = Date.now();
    const raw = await responseJson(
      await this.post(
        endpoint(this.config.baseUrl, 'v1/messages'),
        this.headers(),
        this.body(request),
        request.options.signal
      ),
      'Anthropic'
    );
    const parsed = parseOrThrow(anthropicResponseSchema, raw, 'Anthropic response', LLMError);
    return {
      content: collectText(parsed),
      model: this.config.model,
      usage: usageFromAnthropic(parsed.usage),
      latency_ms: Date.now() - started
    };
  }
  public async *stream(request: AdapterRequest): AsyncIterable<unknown> {
    const started = Date.now();
    const response = await this.post(
      endpoint(this.config.baseUrl, 'v1/messages'),
      this.headers(),
      this.body(request, { stream: true }),
      request.options.signal
    );
    if (!response.ok) await responseJson(response, 'Anthropic');
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const raw of sseEvents(response, 'Anthropic')) {
      const event = object(raw);
      const eventUsage = object(event.usage);
      const startUsage = object(object(event.message).usage);
      if (typeof startUsage.input_tokens === 'number') inputTokens = startUsage.input_tokens;
      if (typeof eventUsage.input_tokens === 'number') inputTokens = eventUsage.input_tokens;
      if (typeof eventUsage.output_tokens === 'number') outputTokens = eventUsage.output_tokens;
      const delta = object(event.delta);
      if (event.type === 'content_block_delta' && typeof delta.text === 'string') yield delta.text;
    }
    this.lastStats = {
      model: this.config.model,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      },
      latency_ms: Date.now() - started
    };
  }
  public async invokeWithTools(request: AdapterToolRequest): Promise<unknown> {
    const started = Date.now();
    const tools = request.tools.map((tool) => {
      const functionValue = object(tool.function);
      return tool.type === 'function'
        ? {
            name: functionValue.name,
            description: functionValue.description ?? '',
            input_schema: functionValue.parameters ?? { type: 'object', properties: {} }
          }
        : tool;
    });
    const toolChoice =
      request.toolChoice === 'required'
        ? { type: 'any' }
        : request.toolChoice === 'auto' || request.toolChoice === 'none'
          ? undefined
          : { type: 'tool', name: request.toolChoice.function.name };
    const raw = await responseJson(
      await this.post(
        endpoint(this.config.baseUrl, 'v1/messages'),
        this.headers(),
        this.body(request, { tools, ...(toolChoice ? { tool_choice: toolChoice } : {}) }),
        request.options.signal
      ),
      'Anthropic'
    );
    const parsed = parseOrThrow(anthropicResponseSchema, raw, 'Anthropic tool response', LLMError);
    return {
      content: collectText(parsed),
      tool_calls: parsed.content
        .filter(
          (block): block is Extract<(typeof parsed.content)[number], { type: 'tool_use' }> =>
            block.type === 'tool_use'
        )
        .map((block) => ({
          id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input)
        })),
      model: this.config.model,
      usage: usageFromAnthropic(parsed.usage),
      latency_ms: Date.now() - started
    };
  }
}

export class GeminiAdapter extends FetchAdapter {
  private endpoint(stream = false) {
    return endpoint(
      this.config.baseUrl,
      `models/${encodeURIComponent(this.config.model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}?key=${encodeURIComponent(this.config.apiKey)}`
    );
  }
  private convertMessages(messages: readonly LLMMessage[]) {
    let systemInstruction: Record<string, unknown> | undefined;
    const contents: Array<Record<string, unknown>> = [];
    const toolNames = new Map<string, string>();
    for (const message of messages) {
      if (message.role === 'system') {
        systemInstruction = { parts: [{ text: message.content ?? '' }] };
        continue;
      }
      if (message.role === 'assistant' && toolCalls(message).length > 0) {
        const parts: Array<Record<string, unknown>> = message.content
          ? [{ text: message.content }]
          : [];
        for (const call of toolCalls(message)) {
          const rawCall = object(call);
          const functionValue = object(rawCall.function);
          const id = typeof rawCall.id === 'string' ? rawCall.id : undefined;
          const name = typeof functionValue.name === 'string' ? functionValue.name : '';
          let args: Record<string, unknown> = {};
          try {
            args = object(
              typeof functionValue.arguments === 'string'
                ? JSON.parse(functionValue.arguments)
                : functionValue.arguments
            );
          } catch {
            args = {};
          }
          if (id && name) toolNames.set(id, name);
          parts.push({ functionCall: { name, args } });
        }
        contents.push({ role: 'model', parts });
        continue;
      }
      if (message.role === 'tool') {
        contents.push({
          role: 'tool',
          parts: [
            {
              functionResponse: {
                name: toolNames.get(message.tool_call_id ?? '') ?? 'tool_result',
                response: { result: message.content ?? '' }
              }
            }
          ]
        });
        continue;
      }
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content ?? '' }]
      });
    }
    return { systemInstruction, contents };
  }
  private body(request: AdapterRequest, extra: Record<string, unknown> = {}) {
    const converted = this.convertMessages(request.messages);
    const generationConfig = {
      ...(request.options.temperature === undefined
        ? {}
        : { temperature: request.options.temperature }),
      ...(request.options.maxTokens === undefined
        ? {}
        : { maxOutputTokens: request.options.maxTokens }),
      ...(request.options.providerOptions ?? {})
    };
    return {
      contents: converted.contents,
      ...(converted.systemInstruction ? { systemInstruction: converted.systemInstruction } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...extra
    };
  }
  public async invoke(request: AdapterRequest): Promise<unknown> {
    const started = Date.now();
    const raw = await responseJson(
      await this.post(this.endpoint(), {}, this.body(request), request.options.signal),
      'Gemini'
    );
    const parsed = parseOrThrow(geminiResponseSchema, raw, 'Gemini response', LLMError);
    const content =
      parsed.text ??
      parsed.candidates[0]?.content.parts.map((part) => part.text ?? '').join('') ??
      '';
    return {
      content,
      model: this.config.model,
      usage: usageFromGemini(parsed.usageMetadata),
      latency_ms: Date.now() - started
    };
  }
  public async *stream(request: AdapterRequest): AsyncIterable<unknown> {
    const started = Date.now();
    const response = await this.post(
      this.endpoint(true),
      {},
      this.body(request),
      request.options.signal
    );
    if (!response.ok) await responseJson(response, 'Gemini');
    let usage: Usage = {};
    for await (const raw of sseEvents(response, 'Gemini')) {
      const parsed = parseOrThrow(geminiResponseSchema, raw, 'Gemini stream chunk', LLMError);
      usage = parsed.usageMetadata ? usageFromGemini(parsed.usageMetadata) : usage;
      const text =
        parsed.text ??
        parsed.candidates[0]?.content.parts.map((part) => part.text ?? '').join('') ??
        '';
      if (text) yield text;
    }
    this.lastStats = { model: this.config.model, usage, latency_ms: Date.now() - started };
  }
  public async invokeWithTools(request: AdapterToolRequest): Promise<unknown> {
    const started = Date.now();
    const functions = request.tools
      .filter((tool) => tool.type === 'function')
      .map((tool) => {
        const functionValue = object(tool.function);
        return {
          name: functionValue.name,
          description: functionValue.description ?? '',
          parametersJsonSchema: functionValue.parameters ?? {}
        };
      });
    const functionCallingConfig =
      request.toolChoice === 'required'
        ? { mode: 'ANY' }
        : request.toolChoice === 'none'
          ? { mode: 'NONE' }
          : request.toolChoice === 'auto'
            ? undefined
            : { mode: 'ANY', allowedFunctionNames: [request.toolChoice.function.name] };
    const raw = await responseJson(
      await this.post(
        this.endpoint(),
        {},
        this.body(request, {
          ...(functions.length ? { tools: [{ functionDeclarations: functions }] } : {}),
          ...(functionCallingConfig ? { toolConfig: { functionCallingConfig } } : {})
        }),
        request.options.signal
      ),
      'Gemini'
    );
    const parsed = parseOrThrow(geminiResponseSchema, raw, 'Gemini tool response', LLMError);
    const calls = parsed.candidates.flatMap((candidate, candidateIndex) =>
      candidate.content.parts.flatMap((part, partIndex) =>
        part.functionCall
          ? [
              {
                id: `call_${candidateIndex}_${partIndex}`,
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args)
              }
            ]
          : []
      )
    );
    return {
      content: parsed.text ?? '',
      tool_calls: calls,
      model: this.config.model,
      usage: usageFromGemini(parsed.usageMetadata),
      latency_ms: Date.now() - started
    };
  }
}

export function createAdapter(config: AdapterConfig, fetchImpl?: FetchLike): BaseLLMAdapter {
  const baseUrl = config.baseUrl.toLowerCase();
  if (baseUrl.includes('anthropic.com')) return new AnthropicAdapter(config, fetchImpl);
  if (baseUrl.includes('googleapis.com') || baseUrl.includes('generativelanguage'))
    return new GeminiAdapter(config, fetchImpl);
  return new OpenAIAdapter(config, fetchImpl);
}
