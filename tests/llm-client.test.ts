import { describe, expect, test } from 'bun:test';

import {
  HelloAgentsLLM,
  LLMAbortError,
  LLMError,
  LLMTimeoutError,
  MockAdapter
} from '../hello_agents/index.js';

const credentials = {
  model: 'test-model',
  apiKey: 'test-key',
  baseUrl: 'https://provider.test/v1'
};

const messages = [{ role: 'user' as const, content: 'hello' }];
const ordinaryResponse = {
  content: 'world',
  model: 'test-model',
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  latency_ms: 7
};

describe('HelloAgentsLLM', () => {
  test('uses explicit configuration before environment values and forwards merged call options', async () => {
    const adapter = new MockAdapter({ invoke: () => ordinaryResponse });
    const llm = new HelloAgentsLLM({
      ...credentials,
      temperature: 0.2,
      maxTokens: 99,
      adapter,
      timeoutMs: 5_000,
      env: {
        LLM_MODEL_ID: 'environment-model',
        LLM_API_KEY: 'environment-key',
        LLM_BASE_URL: 'https://environment.test',
        LLM_TIMEOUT: '123'
      }
    });

    const response = await llm.invoke(messages, {
      temperature: 0.4,
      providerOptions: { seed: 7 }
    });

    expect(response.content).toBe('world');
    expect(llm).toMatchObject({
      model: 'test-model',
      apiKey: 'test-key',
      baseUrl: 'https://provider.test/v1',
      timeoutMs: 5_000
    });
    expect(adapter.requests[0]).toMatchObject({
      messages,
      options: { temperature: 0.4, maxTokens: 99, providerOptions: { seed: 7 } }
    });
  });

  test('uses Python LLM_* environment fallbacks and reports missing required values', () => {
    const adapter = new MockAdapter();
    const llm = new HelloAgentsLLM({
      adapter,
      env: {
        LLM_MODEL_ID: 'environment-model',
        LLM_API_KEY: 'environment-key',
        LLM_BASE_URL: 'https://environment.test',
        LLM_TIMEOUT: '42'
      }
    });

    expect(llm).toMatchObject({
      model: 'environment-model',
      apiKey: 'environment-key',
      baseUrl: 'https://environment.test',
      timeoutMs: 42_000
    });
    expect(() => new HelloAgentsLLM({ adapter, env: {} })).toThrow(LLMError);
  });

  test('preserves Python tool-call IDs, names and JSON-string arguments', async () => {
    const adapter = new MockAdapter({
      invokeWithTools: () => ({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'calculate', arguments: '{"expression":"2+3"}' }],
        model: 'test-model'
      })
    });
    const llm = new HelloAgentsLLM({ ...credentials, adapter });
    const tools = [
      {
        type: 'function',
        function: {
          name: 'calculate',
          description: 'Calculate an expression',
          parameters: { type: 'object' }
        }
      }
    ];

    const response = await llm.invokeWithTools(messages, tools, 'required');

    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'calculate', arguments: '{"expression":"2+3"}' }
    ]);
    expect(adapter.toolRequests[0]).toMatchObject({ tools, toolChoice: 'required' });
  });

  test('streams through AsyncIterable and records validated lastCallStats after completion', async () => {
    const adapter = new MockAdapter({
      stream: async function* () {
        yield 'hel';
        yield 'lo';
      }
    });
    adapter.lastStats = {
      model: 'test-model',
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      latency_ms: 8
    };
    const llm = new HelloAgentsLLM({ ...credentials, adapter });
    const chunks: string[] = [];

    for await (const chunk of llm.stream(messages)) chunks.push(chunk);

    expect(chunks).toEqual(['hel', 'lo']);
    expect(llm.lastCallStats?.toJSON()).toEqual({
      model: 'test-model',
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      latency_ms: 8
    });
  });

  test('does not publish stream stats when a consumer stops before completion', async () => {
    const adapter = new MockAdapter({
      stream: async function* () {
        yield 'first';
        yield 'second';
      }
    });
    adapter.lastStats = { model: 'test-model', usage: {}, latency_ms: 1 };
    const llm = new HelloAgentsLLM({ ...credentials, adapter });

    for await (const chunk of llm.stream(messages)) {
      expect(chunk).toBe('first');
      break;
    }

    expect(llm.lastCallStats).toBeUndefined();
  });

  test('passes AbortSignal to the adapter and normalizes cancellation', async () => {
    const controller = new AbortController();
    const adapter = new MockAdapter({
      invoke: async (request) => {
        request.options.signal?.throwIfAborted();
        return ordinaryResponse;
      }
    });
    const llm = new HelloAgentsLLM({ ...credentials, adapter });
    controller.abort('user cancelled');

    await expect(llm.invoke(messages, { signal: controller.signal })).rejects.toBeInstanceOf(
      LLMAbortError
    );
    expect(adapter.requests).toHaveLength(0);
  });

  test('aborts an adapter request when the configured timeout elapses', async () => {
    const adapter = new MockAdapter({
      invoke: (request) =>
        new Promise((_, reject) => {
          request.options.signal?.addEventListener(
            'abort',
            () => reject(request.options.signal?.reason),
            { once: true }
          );
        })
    });
    const llm = new HelloAgentsLLM({ ...credentials, adapter, timeoutMs: 1 });

    await expect(llm.invoke(messages)).rejects.toBeInstanceOf(LLMTimeoutError);
    expect(adapter.requests).toHaveLength(1);
  });

  test('normalizes malformed raw adapter data without exposing Zod errors', async () => {
    const adapter = new MockAdapter({ invoke: () => ({ content: 42 }) });
    const llm = new HelloAgentsLLM({ ...credentials, adapter });

    let error: unknown;
    try {
      await llm.invoke(messages);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(LLMError);
    expect(error).not.toHaveProperty('issues');
  });
});
