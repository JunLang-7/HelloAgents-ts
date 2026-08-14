import { describe, expect, test } from 'bun:test';

import {
  AgentEvent,
  HelloAgentsLLM,
  MockAdapter,
  SimpleAgent,
  StreamBuffer,
  streamToJsonLines,
  streamToSse
} from '../hello_agents/index.js';

const config = { model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test' };

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe('streaming primitives', () => {
  test('serializes snake_case event payloads as SSE and JSONL with type filtering', async () => {
    const events = [
      AgentEvent.create('agent_start', 'helper', { input_text: 'hello' }),
      AgentEvent.create('llm_chunk', 'helper', { chunk: 'world' })
    ];
    async function* source() {
      yield* events;
    }

    const sse = await collect(streamToSse(source(), ['llm_chunk']));
    expect(sse).toHaveLength(1);
    const firstSse = sse[0];
    if (firstSse === undefined) throw new Error('Expected one SSE event');
    expect(firstSse).toContain('event: llm_chunk\n');
    expect(JSON.parse(firstSse.split('\n')[1]?.replace('data: ', '') ?? '')).toMatchObject({
      type: 'llm_chunk',
      agent_name: 'helper',
      data: { chunk: 'world' }
    });
    expect(await collect(streamToJsonLines(source()))).toHaveLength(2);
  });

  test('bounds buffered events by discarding the oldest and can filter/clear', () => {
    const buffer = new StreamBuffer(2);
    buffer.add(AgentEvent.create('agent_start', 'helper'));
    buffer.add(AgentEvent.create('llm_chunk', 'helper'));
    buffer.add(AgentEvent.create('agent_finish', 'helper'));

    expect(buffer.getAll().map((event) => event.type)).toEqual(['llm_chunk', 'agent_finish']);
    expect(buffer.filterByType('llm_chunk')).toHaveLength(1);
    buffer.clear();
    expect(buffer.getAll()).toEqual([]);
  });
});

describe('SimpleAgent async lifecycle', () => {
  test('isolates hook failures/timeouts, propagates cancellation to LLM, and emits stable streaming events', async () => {
    let receivedSignal: AbortSignal | undefined;
    const adapter = new MockAdapter({
      invoke: (request) => {
        receivedSignal = request.options.signal;
        return { content: 'finished', model: 'test-model', usage: {}, latency_ms: 0 };
      },
      stream: async function* () {
        yield 'first';
        yield ' second';
      }
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter })
    });
    const controller = new AbortController();
    await expect(
      agent.arun('hello', {
        signal: controller.signal,
        lifecycle: {
          onStart: async () => {
            throw new Error('hook ignored');
          },
          hookTimeoutMs: 1
        }
      })
    ).resolves.toBe('finished');
    expect(receivedSignal).toBeInstanceOf(AbortSignal);

    const events = await collect(agent.arunStream('stream'));
    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'llm_chunk',
      'llm_chunk',
      'agent_finish'
    ]);
    expect(events.map((event) => event.data)).toContainEqual({ chunk: 'first' });
  });

  test('normalizes an aborted asynchronous run rather than starting the adapter request', async () => {
    const adapter = new MockAdapter({
      invoke: () => ({ content: 'unexpected', model: 'test-model', usage: {}, latency_ms: 0 })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter })
    });
    const controller = new AbortController();
    controller.abort('cancelled');

    await expect(agent.arun('cancel', { signal: controller.signal })).rejects.toThrow('aborted');
    expect(adapter.requests).toHaveLength(0);
  });
});
