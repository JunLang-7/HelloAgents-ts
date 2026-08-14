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

function usageFromGemini(usage: z.infer<typeof geminiResponseSchema>['usageMetadata']): Usage {
  return usage
    ? {
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        total_tokens: usage.totalTokenCount ?? 0
      }
    : {};
}

function toolCalls(message: LLMMessage): unknown[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls : [];
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
