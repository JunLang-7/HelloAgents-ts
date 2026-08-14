import { z } from 'zod';

import type { AdapterRequest, AdapterToolRequest } from './base.js';
import { endpoint, FetchAdapter, responseJson, sseEvents, type Usage } from './fetch-adapter.js';
import { LLMError, parseOrThrow } from '../core/errors.js';

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

function usageFromOpenAI(usage: z.infer<typeof openAiResponseSchema>['usage']): Usage {
  return usage
    ? {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0
      }
    : {};
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
