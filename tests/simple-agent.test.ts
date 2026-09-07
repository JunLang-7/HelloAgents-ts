import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FunctionCallAgent,
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  SimpleAgent,
  ToolAwareSimpleAgent,
  ToolRegistry
} from '../hello_agents/index.js';

const config = { model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test' };

function echoTool(handler: (input: { input: string }) => unknown = ({ input }) => input) {
  return new FunctionTool({
    name: 'echo',
    description: 'Echo input.',
    inputSchema: z.object({ input: z.string() }).strict(),
    parameters: [{ name: 'input', type: 'string', description: 'Text' }],
    handler
  });
}

describe('SimpleAgent marker calling', () => {
  test('exports a direct no-tools agent with the upstream default system prompt and history', async () => {
    const adapter = new MockAdapter({
      invoke: () => ({ content: 'direct answer', model: 'test-model', usage: {}, latency_ms: 0 })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter })
    });

    await expect(agent.run('hello')).resolves.toBe('direct answer');
    expect(adapter.requests[0]?.messages).toMatchObject([
      { role: 'system', content: '你是一个有用的AI助手。' },
      { role: 'user', content: 'hello' }
    ]);
    expect(agent.getHistory().map((message) => [message.role, message.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'direct answer']
    ]);
  });

  test('parses multiple text markers, executes each in order, and feeds results back', async () => {
    let turn = 0;
    const adapter = new MockAdapter({
      invoke: () => {
        turn += 1;
        return {
          content:
            turn === 1
              ? 'Working [TOOL_CALL:echo:input=one] then [TOOL_CALL:echo:input=two]'
              : 'combined result',
          model: 'test-model',
          usage: {},
          latency_ms: 0
        };
      }
    });
    const registry = new ToolRegistry().register(echoTool());
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: registry
    });

    await expect(agent.run('use tools')).resolves.toBe('combined result');
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages.slice(-2)).toMatchObject([
      {
        role: 'assistant',
        content: 'Working [TOOL_CALL:echo:input=one] then [TOOL_CALL:echo:input=two]'
      },
      { role: 'user' }
    ]);
    const feedback = String(adapter.requests[1]?.messages.at(-1)?.content);
    expect(feedback).toContain('🔧 工具 echo 执行结果：\none');
    expect(feedback).toContain('two');
  });

  test('converts JSON and scalar typed arguments, infers memory actions, and reports tool errors', async () => {
    const seen: unknown[] = [];
    const adapter = new MockAdapter({
      invoke: (request) => ({
        content: request.messages.some(
          (message) => message.role === 'user' && String(message.content).includes('工具执行结果')
        )
          ? 'finished'
          : '[TOOL_CALL:memory:count=2,enabled=yes,recall=topic]',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const memory = new FunctionTool({
      name: 'memory',
      description: 'Memory.',
      inputSchema: z
        .object({ action: z.string(), query: z.string(), count: z.number(), enabled: z.boolean() })
        .strict(),
      parameters: [
        { name: 'action', type: 'string', description: '' },
        { name: 'query', type: 'string', description: '' },
        { name: 'count', type: 'number', description: '' },
        { name: 'enabled', type: 'boolean', description: '' }
      ],
      handler: (input) => {
        seen.push(input);
        return 'stored';
      }
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(memory)
    });

    await expect(agent.run('remember')).resolves.toBe('finished');
    expect(seen).toEqual([{ action: 'search', query: 'topic', count: 2, enabled: true }]);

    const jsonAdapter = new MockAdapter({
      invoke: (request) => ({
        content: request.messages.some(
          (message) => message.role === 'user' && String(message.content).includes('工具执行结果')
        )
          ? 'json finished'
          : '[TOOL_CALL:memory:{"action":"search","query":"json","count":"3","enabled":"false"}]',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const jsonAgent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter: jsonAdapter }),
      toolRegistry: new ToolRegistry().register(memory)
    });
    await expect(jsonAgent.run('json')).resolves.toBe('json finished');
    expect(seen.at(-1)).toEqual({ action: 'search', query: 'json', count: 3, enabled: false });

    const errorAdapter = new MockAdapter({
      invoke: (request) => ({
        content: request.messages.length > 2 ? 'recovered' : '[TOOL_CALL:missing:input=x]',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const errorAgent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter: errorAdapter }),
      toolRegistry: new ToolRegistry()
    });
    await expect(errorAgent.run('bad tool')).resolves.toBe('recovered');
    expect(errorAdapter.requests[1]?.messages.at(-1)?.content).toContain("未找到工具 'missing'");
  });

  test('uses one final direct call after max marker iterations and manages tools', async () => {
    let calls = 0;
    const adapter = new MockAdapter({
      invoke: () => ({
        content: ++calls === 1 ? '[TOOL_CALL:echo:input=x]' : 'fallback answer',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      maxToolIterations: 1
    });
    agent.addTool(echoTool());

    await expect(agent.run('limited')).resolves.toBe('fallback answer');
    expect(adapter.requests).toHaveLength(2);
    expect(agent.removeTool('echo')).toBe(true);
    expect(agent.hasTools()).toBe(false);
  });
});

describe('FunctionCallAgent native calling', () => {
  test('uses native schemas, preserves call ids, converts typed JSON arguments, and loops', async () => {
    let turn = 0;
    const seen: unknown[] = [];
    const adapter = new MockAdapter({
      invokeWithTools: () => ({
        content: turn++ === 0 ? null : 'native done',
        tool_calls:
          turn === 1
            ? [{ id: 'call_1', name: 'typed', arguments: '{"count":"4","enabled":"false"}' }]
            : [],
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const typed = new FunctionTool({
      name: 'typed',
      description: 'Typed.',
      inputSchema: z.object({ count: z.number(), enabled: z.boolean() }).strict(),
      parameters: [
        { name: 'count', type: 'integer', description: '' },
        { name: 'enabled', type: 'boolean', description: '' }
      ],
      handler: (input) => {
        seen.push(input);
        return 'ok';
      }
    });
    const agent = new FunctionCallAgent({
      name: 'native',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(typed)
    });

    await expect(agent.run('go')).resolves.toBe('native done');
    expect(adapter.toolRequests).toHaveLength(2);
    expect(adapter.toolRequests[0]?.tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'typed' }
    });
    expect(adapter.toolRequests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'ok'
    });
    expect(seen).toEqual([{ count: 4, enabled: false }]);
  });

  test('uses tool_choice none for the final native request and direct invocation without tools', async () => {
    const adapter = new MockAdapter({
      invokeWithTools: (request) => ({
        content: request.toolChoice === 'none' ? 'final' : null,
        tool_calls:
          request.toolChoice === 'none'
            ? []
            : [{ id: 'c', name: 'echo', arguments: '{"input":"x"}' }],
        model: 'test-model',
        usage: {},
        latency_ms: 0
      }),
      invoke: () => ({ content: 'plain', model: 'test-model', usage: {}, latency_ms: 0 })
    });
    const llm = new HelloAgentsLLM({ ...config, adapter });
    await expect(
      new FunctionCallAgent({
        name: 'native',
        llm,
        toolRegistry: new ToolRegistry().register(echoTool()),
        maxToolIterations: 1
      }).run('go')
    ).resolves.toBe('final');
    expect(adapter.toolRequests.at(-1)?.toolChoice).toBe('none');
    await expect(new FunctionCallAgent({ name: 'plain', llm }).run('go')).resolves.toBe('plain');
  });
});

describe('ToolAwareSimpleAgent', () => {
  test('records sanitized nested-marker calls and filters markers during streaming', async () => {
    const observations: unknown[] = [];
    let streamTurn = 0;
    const adapter = new MockAdapter({
      stream: async function* () {
        if (streamTurn++ === 0) {
          yield 'Before [TOOL_CALL:echo:input=["a", "b"]]';
        } else {
          yield ' after tool';
        }
      }
    });
    const agent = new ToolAwareSimpleAgent({
      name: 'aware',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(echoTool()),
      toolCallListener: (call) => observations.push(call)
    });
    const chunks: string[] = [];
    for await (const chunk of agent.stream('go')) chunks.push(chunk);

    expect(chunks).toEqual(['Before ', ' ', 'after tool']);
    expect(observations).toMatchObject([
      { toolName: 'echo', parsedParameters: { input: '["a"]' } }
    ]);
    expect(agent.getHistory().at(-1)?.content).toBe(' after tool');
  });
});
