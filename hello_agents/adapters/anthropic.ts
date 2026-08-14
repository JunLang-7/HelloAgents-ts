import { z } from 'zod';

import type { AdapterRequest, AdapterToolRequest, LLMMessage } from './base.js';
import {
  endpoint,
  FetchAdapter,
  object,
  responseJson,
  sseEvents,
  type Usage
} from './fetch-adapter.js';
import { LLMError, parseOrThrow } from '../core/errors.js';

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

function usageFromAnthropic(usage: z.infer<typeof anthropicResponseSchema>['usage']): Usage {
  return usage
    ? {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens
      }
    : {};
}

function toolCalls(message: LLMMessage): unknown[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls : [];
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
