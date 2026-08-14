import { describe, expect, test } from 'bun:test';

import {
  AnthropicAdapter,
  GeminiAdapter,
  HelloAgentsLLM,
  LLMError,
  OpenAIAdapter,
  createAdapter
} from '../hello_agents/index.js';
import type { FetchLike } from '../hello_agents/adapters/providers.js';

const config = {
  model: 'test-model',
  apiKey: 'test-key',
  baseUrl: 'https://provider.test/v1',
  timeoutMs: 60_000
};
const messages = [{ role: 'user' as const, content: 'hello' }];

function jsonFetch(
  body: unknown,
  capture: { url?: string | undefined; init?: RequestInit | undefined }
): FetchLike {
  return async (url, init) => {
    capture.url = String(url);
    capture.init = init;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}

function sseFetch(events: unknown[]): FetchLike {
  return async () =>
    new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
      {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      }
    );
}

function errorFetch(status: number, body: unknown): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
}

describe('provider selection', () => {
  test('matches Python base_url detection and leaves every other endpoint OpenAI-compatible', () => {
    expect(createAdapter({ ...config, baseUrl: 'https://api.anthropic.com' })).toBeInstanceOf(
      AnthropicAdapter
    );
    expect(
      createAdapter({ ...config, baseUrl: 'https://generativelanguage.googleapis.com' })
    ).toBeInstanceOf(GeminiAdapter);
    expect(createAdapter({ ...config, baseUrl: 'https://api.openai.com/v1' })).toBeInstanceOf(
      OpenAIAdapter
    );
    expect(createAdapter({ ...config, baseUrl: 'https://deepseek.example/v1' })).toBeInstanceOf(
      OpenAIAdapter
    );
  });

  test('can be injected into HelloAgentsLLM through the standard adapter factory', async () => {
    const llm = new HelloAgentsLLM({
      ...config,
      baseUrl: 'https://api.anthropic.com',
      adapterFactory: (adapterConfig) =>
        createAdapter(
          adapterConfig,
          jsonFetch({ content: [{ type: 'text', text: 'factory result' }] }, {})
        )
    });

    expect(await llm.invoke(messages)).toMatchObject({ content: 'factory result' });
    expect(llm.adapter).toBeInstanceOf(AnthropicAdapter);
  });

  test('uses createAdapter automatically when no adapter is explicitly injected', () => {
    expect(
      new HelloAgentsLLM({ ...config, baseUrl: 'https://api.anthropic.com' }).adapter
    ).toBeInstanceOf(AnthropicAdapter);
    expect(
      new HelloAgentsLLM({
        ...config,
        baseUrl: 'https://generativelanguage.googleapis.com'
      }).adapter
    ).toBeInstanceOf(GeminiAdapter);
  });

  test('forwards the client cancellation signal into a provider fetch transport', async () => {
    let receivedSignal: AbortSignal | undefined;
    const llm = new HelloAgentsLLM({
      ...config,
      baseUrl: 'https://provider.test/v1',
      adapterFactory: (adapterConfig) =>
        new OpenAIAdapter(adapterConfig, async (_url, init) => {
          receivedSignal = init?.signal ?? undefined;
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            headers: { 'content-type': 'application/json' }
          });
        })
    });
    await llm.invoke(messages);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('OpenAI-compatible adapter', () => {
  test('normalizes ordinary and tool responses using raw provider fixtures', async () => {
    const ordinaryCapture: { url?: string; init?: RequestInit } = {};
    const adapter = new OpenAIAdapter(
      config,
      jsonFetch(
        {
          model: 'provider-model',
          choices: [{ message: { content: 'hello world', reasoning_content: 'reasoning' } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        },
        ordinaryCapture
      )
    );

    const response = await adapter.invoke({ messages, options: { temperature: 0.2 } });
    expect(response).toMatchObject({ content: 'hello world', model: 'test-model' });
    expect(JSON.parse(String(ordinaryCapture.init?.body))).toMatchObject({
      model: 'test-model',
      messages,
      temperature: 0.2
    });

    const toolCapture: { url?: string; init?: RequestInit } = {};
    const toolAdapter = new OpenAIAdapter(
      config,
      jsonFetch(
        {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    function: { name: 'calculate', arguments: '{"expression":"2+3"}' }
                  }
                ]
              }
            }
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        },
        toolCapture
      )
    );
    const tools = [
      { type: 'function', function: { name: 'calculate', parameters: { type: 'object' } } }
    ];
    const toolResponse = await toolAdapter.invokeWithTools({
      messages,
      tools,
      toolChoice: 'required',
      options: {}
    });
    expect(toolResponse).toMatchObject({
      tool_calls: [{ id: 'call_1', name: 'calculate', arguments: '{"expression":"2+3"}' }]
    });
    expect(JSON.parse(String(toolCapture.init?.body))).toMatchObject({
      tools,
      tool_choice: 'required'
    });
  });

  test('parses OpenAI SSE chunks and persists final stream usage', async () => {
    const adapter = new OpenAIAdapter(
      config,
      sseFetch([
        { choices: [{ delta: { content: 'hel' } }] },
        { choices: [{ delta: { content: 'lo', reasoning_content: 'think' } }] },
        { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }
      ])
    );
    const chunks: string[] = [];
    for await (const chunk of adapter.stream({ messages, options: {} })) chunks.push(String(chunk));

    expect(chunks).toEqual(['hel', 'lo']);
    expect(adapter.lastStats).toMatchObject({
      model: 'test-model',
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      reasoning_content: 'think'
    });
  });

  test('normalizes HTTP failures with provider context', async () => {
    const adapter = new OpenAIAdapter(
      config,
      errorFetch(429, { error: { message: 'rate limited' } })
    );

    await expect(adapter.invoke({ messages, options: {} })).rejects.toThrow(
      'OpenAI request failed'
    );
  });
});

describe('Anthropic adapter', () => {
  test('separates system content and converts tool history, schemas, tool choice and response', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const adapter = new AnthropicAdapter(
      { ...config, baseUrl: 'https://api.anthropic.com' },
      jsonFetch(
        {
          content: [
            { type: 'text', text: 'I will calculate.' },
            { type: 'tool_use', id: 'toolu_1', name: 'calculate', input: { expression: '2+3' } }
          ],
          usage: { input_tokens: 8, output_tokens: 4 }
        },
        capture
      )
    );
    const toolHistory = [
      { role: 'system' as const, content: 'be helpful' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          { id: 'call_1', function: { name: 'calculate', arguments: '{"expression":"2+3"}' } }
        ]
      },
      { role: 'tool' as const, content: '5', tool_call_id: 'call_1' }
    ];
    const tools = [
      {
        type: 'function',
        function: { name: 'calculate', description: 'calculate', parameters: { type: 'object' } }
      }
    ];
    const response = await adapter.invokeWithTools({
      messages: toolHistory,
      tools,
      toolChoice: { type: 'function', function: { name: 'calculate' } },
      options: {}
    });
    const request = JSON.parse(String(capture.init?.body));

    expect(request).toMatchObject({
      system: 'be helpful',
      tool_choice: { type: 'tool', name: 'calculate' },
      tools: [{ name: 'calculate', input_schema: { type: 'object' } }],
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'calculate', input: { expression: '2+3' } }
          ]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '5' }] }
      ]
    });
    expect(response).toMatchObject({
      content: 'I will calculate.',
      tool_calls: [{ id: 'toolu_1', name: 'calculate', arguments: '{"expression":"2+3"}' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
    });
  });

  test('parses Anthropic content deltas and final message usage from SSE', async () => {
    const adapter = new AnthropicAdapter(
      { ...config, baseUrl: 'https://api.anthropic.com' },
      sseFetch([
        { type: 'content_block_delta', delta: { text: 'hello' } },
        { type: 'message_start', message: { usage: { input_tokens: 3 } } },
        { type: 'message_delta', usage: { output_tokens: 2 } }
      ])
    );
    const chunks: string[] = [];
    for await (const chunk of adapter.stream({ messages, options: {} })) chunks.push(String(chunk));

    expect(chunks).toEqual(['hello']);
    expect(adapter.lastStats).toMatchObject({
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    });
  });
});

describe('Gemini adapter', () => {
  test('converts system/messages/tools/tool choice and normalizes function calls', async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const adapter = new GeminiAdapter(
      { ...config, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      jsonFetch(
        {
          text: '',
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'calculate', args: { expression: '2+3' } } }]
              }
            }
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 }
        },
        capture
      )
    );
    const response = await adapter.invokeWithTools({
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: 'calculate 2+3' }
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'calculate', description: 'calculate', parameters: { type: 'object' } }
        }
      ],
      toolChoice: 'required',
      options: { temperature: 0.2, maxTokens: 50 }
    });
    const request = JSON.parse(String(capture.init?.body));

    expect(request).toMatchObject({
      systemInstruction: { parts: [{ text: 'be helpful' }] },
      contents: [{ role: 'user', parts: [{ text: 'calculate 2+3' }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 50 },
      tools: [
        { functionDeclarations: [{ name: 'calculate', parametersJsonSchema: { type: 'object' } }] }
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } }
    });
    expect(response).toMatchObject({
      tool_calls: [{ name: 'calculate', arguments: '{"expression":"2+3"}' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
    });
  });

  test('converts raw provider validation failures into LLMError', async () => {
    const adapter = new GeminiAdapter(
      { ...config, baseUrl: 'https://generativelanguage.googleapis.com' },
      jsonFetch({ candidates: [{ content: { parts: 'not-an-array' } }] }, {})
    );

    await expect(adapter.invoke({ messages, options: {} })).rejects.toBeInstanceOf(LLMError);
  });

  test('parses Gemini SSE chunks and final usage metadata', async () => {
    const adapter = new GeminiAdapter(
      { ...config, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      sseFetch([
        { candidates: [{ content: { parts: [{ text: 'hello' }] } }] },
        { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }
      ])
    );
    const chunks: string[] = [];
    for await (const chunk of adapter.stream({ messages, options: {} })) chunks.push(String(chunk));

    expect(chunks).toEqual(['hello']);
    expect(adapter.lastStats).toMatchObject({
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    });
  });
});
