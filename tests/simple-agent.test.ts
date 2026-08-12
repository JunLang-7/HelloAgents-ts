import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  SimpleAgent,
  ToolRegistry
} from '../src/index.js';

const config = { model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test' };

describe('SimpleAgent', () => {
  test('builds system/history/user messages and persists a direct conversation', async () => {
    const adapter = new MockAdapter({
      invoke: () => ({ content: 'direct answer', model: 'test-model', usage: {}, latency_ms: 0 })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      systemPrompt: 'Be concise.'
    });

    await expect(agent.run('hello')).resolves.toBe('direct answer');
    expect(adapter.requests[0]?.messages).toMatchObject([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hello' }
    ]);
    expect(agent.getHistory().map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'direct answer']
    ]);
  });

  test('executes multiple tool calls in order and preserves original tool_call_id values', async () => {
    let turn = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => {
        turn += 1;
        return turn === 1
          ? {
              content: null,
              tool_calls: [
                { id: 'call_one', name: 'echo', arguments: '{"input":"one"}' },
                { id: 'call_two', name: 'echo', arguments: '{"input":"two"}' }
              ],
              model: 'test-model',
              usage: {},
              latency_ms: 0
            }
          : {
              content: 'combined result',
              tool_calls: [],
              model: 'test-model',
              usage: {},
              latency_ms: 0
            };
      }
    });
    const registry = new ToolRegistry();
    registry.registerFunction(
      new FunctionTool({
        name: 'echo',
        description: 'Echo.',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: ({ input }) => input
      })
    );
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: registry
    });

    await expect(agent.run('use tools')).resolves.toBe('combined result');
    expect(adapter.toolRequests).toHaveLength(2);
    expect(adapter.toolRequests[1]?.messages.slice(-3)).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 'call_one' }, { id: 'call_two' }] },
      { role: 'tool', tool_call_id: 'call_one', content: 'one' },
      { role: 'tool', tool_call_id: 'call_two', content: 'two' }
    ]);
  });

  test('uses one final non-tool request after reaching the iteration limit and manages tools', async () => {
    const adapter = new MockAdapter({
      invokeWithTools: () => ({
        content: null,
        tool_calls: [{ id: 'call_1', name: 'echo', arguments: '{"input":"x"}' }],
        model: 'test-model',
        usage: {},
        latency_ms: 0
      }),
      invoke: () => ({ content: 'fallback answer', model: 'test-model', usage: {}, latency_ms: 0 })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      maxToolIterations: 1
    });
    agent.addTool(
      new FunctionTool({
        name: 'echo',
        description: 'Echo.',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: ({ input }) => input
      })
    );

    await expect(agent.run('limited')).resolves.toBe('fallback answer');
    expect(adapter.requests).toHaveLength(1);
    expect(agent.listTools()).toEqual(['echo']);
    expect(agent.hasTools()).toBe(true);
    expect(agent.removeTool('echo')).toBe(true);
    expect(agent.hasTools()).toBe(false);
  });

  test('streams a plain response and persists the completed text', async () => {
    const adapter = new MockAdapter({
      stream: async function* () {
        yield 'stream ';
        yield 'answer';
      }
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter })
    });
    const chunks: string[] = [];
    for await (const chunk of agent.stream('hello')) chunks.push(chunk);

    expect(chunks).toEqual(['stream ', 'answer']);
    expect(agent.getHistory().at(-1)?.content).toBe('stream answer');
  });
});
