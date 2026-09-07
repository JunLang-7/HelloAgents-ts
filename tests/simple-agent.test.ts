import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FunctionCallAgent,
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  SimpleAgent,
  Tool,
  ToolAwareSimpleAgent,
  ToolRegistry,
  ToolResponse
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

function boomTool() {
  return new FunctionTool({
    name: 'boom',
    description: 'Throws on every call.',
    inputSchema: z.object({ input: z.string() }).strict(),
    parameters: [{ name: 'input', type: 'string', description: 'Text' }],
    handler: () => {
      throw new Error('kaboom');
    }
  });
}

function rejectTool() {
  return new FunctionTool({
    name: 'reject',
    description: 'Requires an integer count.',
    inputSchema: z.object({ count: z.number().int() }).strict(),
    parameters: [{ name: 'count', type: 'integer', description: 'Count' }],
    handler: ({ count }) => `count ${count}`
  });
}

/** Partial (e.g. large/truncated) results are content, not upstream failures. */
class PartialTool extends Tool<ReturnType<typeof z.object>> {
  public constructor() {
    super({
      name: 'partial',
      description: 'Returns a partial response with content.',
      inputSchema: z.object({ input: z.string() }).strict()
    });
  }

  protected run(): ToolResponse {
    return ToolResponse.partial('部分输出…（已截断）', { truncated: true });
  }
}

/** Passthrough probe that records the exact object delivered to the tool handler. */
function probeTool(seen: Array<Record<string, unknown>>) {
  return new FunctionTool({
    name: 'probe',
    description: 'Records raw arguments.',
    inputSchema: z.object({}).passthrough(),
    parameters: [
      { name: 'input', type: 'string', description: 'Text' },
      { name: 'count', type: 'integer', description: 'Count' },
      { name: 'ratio', type: 'number', description: 'Ratio' }
    ],
    handler: (data) => {
      seen.push(data as Record<string, unknown>);
      return 'probe ok';
    }
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
    // Upstream hasTools() stays true while a registry remains attached, even when empty.
    expect(agent.hasTools()).toBe(true);
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

describe('SimpleAgent tool failure feedback', () => {
  test('feeds a throwing tool handler back as an upstream failure, never a success', async () => {
    let turn = 0;
    const adapter = new MockAdapter({
      invoke: () => ({
        content: ++turn === 1 ? '[TOOL_CALL:boom:input=x]' : 'recovered answer',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(boomTool())
    });

    await expect(agent.run('use boom')).resolves.toBe('recovered answer');
    const feedback = String(adapter.requests[1]?.messages.at(-1)?.content);
    expect(feedback).toContain('❌ 工具调用失败：');
    expect(feedback).toContain('kaboom');
    expect(feedback).not.toContain('🔧 工具 boom 执行结果');
  });

  test('feeds a zod-rejected marker argument back as a tool failure and recovers', async () => {
    let turn = 0;
    const adapter = new MockAdapter({
      invoke: () => ({
        content: ++turn === 1 ? '[TOOL_CALL:reject:{"count":"abc"}]' : 'recovered from reject',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(rejectTool())
    });

    await expect(agent.run('use reject')).resolves.toBe('recovered from reject');
    const feedback = String(adapter.requests[1]?.messages.at(-1)?.content);
    expect(feedback).toContain('❌ 工具调用失败：');
    expect(feedback).toContain('参数无效');
    expect(feedback).not.toContain('🔧 工具 reject 执行结果');
  });

  test('keeps the original string when numeric conversion cannot match the declared type', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let turn = 0;
    const adapter = new MockAdapter({
      invoke: () => ({
        content:
          ++turn === 1
            ? '[TOOL_CALL:probe:{"count":"12.5","ratio":"oops","input":"x"}]'
            : 'typed ok',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(probeTool(seen))
    });

    await expect(agent.run('typed')).resolves.toBe('typed ok');
    // Upstream float()/int() raise on invalid input; the original value is kept,
    // so '12.5' is never truncated to 12 and 'oops' never becomes NaN.
    expect(seen[0]).toEqual({ count: '12.5', ratio: 'oops', input: 'x' });
  });

  test('frames partial results as tool content, never as a failure', async () => {
    let turn = 0;
    const adapter = new MockAdapter({
      invoke: () => ({
        content: ++turn === 1 ? '[TOOL_CALL:partial:input=x]' : 'recovered from partial',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(new PartialTool())
    });

    await expect(agent.run('use partial')).resolves.toBe('recovered from partial');
    const feedback = String(adapter.requests[1]?.messages.at(-1)?.content);
    expect(feedback).toContain('🔧 工具 partial 执行结果');
    expect(feedback).toContain('部分输出');
    expect(feedback).not.toContain('❌ 工具调用失败');
  });
});

describe('FunctionCallAgent tool failure and exhaustion', () => {
  test('feeds a throwing native tool handler back as an upstream failure', async () => {
    let turn = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => ({
        content: turn++ === 0 ? null : 'native recovered',
        tool_calls:
          turn === 1 ? [{ id: 'call_boom', name: 'boom', arguments: '{"input":"x"}' }] : [],
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new FunctionCallAgent({
      name: 'native',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(boomTool())
    });

    await expect(agent.run('boom')).resolves.toBe('native recovered');
    const toolMessage = adapter.toolRequests[1]?.messages.at(-1);
    const content = String(toolMessage?.content);
    expect(toolMessage).toMatchObject({ role: 'tool' });
    expect(content).toContain('kaboom');
    expect(content).toContain('❌ 工具调用失败：');
    expect(content).not.toContain('🔧 工具 boom 执行结果');
  });

  test('feeds a zod-rejected native argument back as a tool failure and recovers', async () => {
    let turn = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => ({
        content: turn++ === 0 ? null : 'native reject recovered',
        tool_calls:
          turn === 1 ? [{ id: 'call_reject', name: 'reject', arguments: '{"count":"abc"}' }] : [],
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new FunctionCallAgent({
      name: 'native',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(rejectTool())
    });

    await expect(agent.run('reject')).resolves.toBe('native reject recovered');
    const toolMessage = adapter.toolRequests[1]?.messages.at(-1);
    expect(String(toolMessage?.content)).toContain('❌ 工具调用失败：');
    expect(String(toolMessage?.content)).toContain('参数无效');
    expect(String(toolMessage?.content)).not.toContain('🔧 工具 reject 执行结果');
  });

  test('keeps the missing-tool feedback path for native calls', async () => {
    let turn = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => ({
        content: turn++ === 0 ? null : 'missing recovered',
        tool_calls: turn === 1 ? [{ id: 'call_ghost', name: 'ghost', arguments: '{}' }] : [],
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new FunctionCallAgent({
      name: 'native',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(echoTool())
    });

    await expect(agent.run('ghost')).resolves.toBe('missing recovered');
    const toolMessage = adapter.toolRequests[1]?.messages.at(-1);
    expect(String(toolMessage?.content)).toBe("❌ 错误：未找到工具 'ghost'");
  });

  test('executes tool calls from a final Anthropic-style request that ignores toolChoice none', async () => {
    const echoRuns: string[] = [];
    let toolTurns = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => {
        toolTurns += 1;
        return {
          content: '',
          tool_calls:
            toolTurns <= 2
              ? [{ id: `call_${toolTurns}`, name: 'echo', arguments: '{"input":"x"}' }]
              : [],
          model: 'test-model',
          usage: {},
          latency_ms: 0
        };
      },
      invoke: () => ({ content: 'plain fallback', model: 'test-model', usage: {}, latency_ms: 0 })
    });
    const agent = new FunctionCallAgent({
      name: 'native',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(
        echoTool(({ input }) => {
          echoRuns.push(input);
          return input;
        })
      ),
      maxToolIterations: 1
    });

    // Anthropic ignores toolChoice 'none'; both pending calls must run and the
    // answer must never be an empty dropped-call reply.
    await expect(agent.run('go')).resolves.toBe('plain fallback');
    expect(toolTurns).toBe(2);
    expect(echoRuns).toEqual(['x', 'x']);
    expect(adapter.requests).toHaveLength(1);
    // The tool-free fallback request carries the balanced conversation including the
    // executed call_2 result; the model then answers without tools.
    expect(adapter.requests[0]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_2',
      name: 'echo',
      content: 'x'
    });
    expect(adapter.toolRequests[1]?.toolChoice).toBe('none');
    expect(agent.getHistory().at(-1)?.content).toBe('plain fallback');
  });
});

describe('ToolAwareSimpleAgent failure and listener semantics', () => {
  test('records a throwing handler failure with upstream framing', async () => {
    const observations: unknown[] = [];
    let turn = 0;
    const adapter = new MockAdapter({
      invoke: () => ({
        content: ++turn === 1 ? '[TOOL_CALL:boom:input=x]' : 'aware recovered',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new ToolAwareSimpleAgent({
      name: 'aware',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(boomTool()),
      toolCallListener: (call) => observations.push(call)
    });

    await expect(agent.run('boom')).resolves.toBe('aware recovered');
    expect(observations).toHaveLength(1);
    const result = String((observations[0] as { result?: unknown }).result);
    expect(result).toContain('❌ 工具调用失败：');
    expect(result).toContain('kaboom');
    expect(result).not.toContain('🔧 工具 boom 执行结果');
  });

  test('feeds a zod-rejected argument back as a failure and skips the listener for missing tools', async () => {
    const observations: unknown[] = [];
    let turn = 0;
    const adapter = new MockAdapter({
      invoke: () => ({
        content:
          ++turn === 1
            ? '[TOOL_CALL:reject:{"count":"abc"}]'
            : turn === 2
              ? '[TOOL_CALL:ghost:input=x]'
              : 'aware reject recovered',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new ToolAwareSimpleAgent({
      name: 'aware',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(rejectTool()),
      toolCallListener: (call) => observations.push(call)
    });

    await expect(agent.run('reject then ghost')).resolves.toBe('aware reject recovered');
    // The registry lookup failure is an upstream early return: only the real
    // reject attempt is observed, and only with failure framing.
    expect(observations).toHaveLength(1);
    const result = String((observations[0] as { result?: unknown }).result);
    expect(result).toContain('❌ 工具调用失败：');
    expect(result).toContain('参数无效');
    const rejectFeedback = String(adapter.requests[1]?.messages.at(-1)?.content);
    const ghostFeedback = String(adapter.requests[2]?.messages.at(-1)?.content);
    expect(ghostFeedback).toContain("未找到工具 'ghost'");
    expect(rejectFeedback).not.toContain('🔧 工具 reject 执行结果');
  });
});

describe('prototype-key filtering regressions', () => {
  const hostile = (seed: string) =>
    `{"input":"${seed}","count":"2","ratio":"0.5","__proto__":{"polluted":true},"constructor":"ctor","prototype":"proto"}`;

  test('SimpleAgent markers never copy prototype-tampering keys into tool arguments', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let turn = 0;
    const adapter = new MockAdapter({
      invoke: () => ({
        content: ++turn === 1 ? `[TOOL_CALL:probe:${hostile('a')}]` : 'clean',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new SimpleAgent({
      name: 'helper',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(probeTool(seen))
    });

    await expect(agent.run('hostile')).resolves.toBe('clean');
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(['count', 'input', 'ratio']);
    expect((seen[0] as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test('FunctionCallAgent native arguments never copy prototype-tampering keys', async () => {
    const seen: Array<Record<string, unknown>> = [];
    let turn = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => ({
        content: turn++ === 0 ? null : 'clean native',
        tool_calls:
          turn === 1 ? [{ id: 'call_probe', name: 'probe', arguments: hostile('b') }] : [],
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new FunctionCallAgent({
      name: 'native',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: new ToolRegistry().register(probeTool(seen))
    });

    await expect(agent.run('hostile native')).resolves.toBe('clean native');
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(['count', 'input', 'ratio']);
    expect((seen[0] as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  test('ToolAware sanitizeParameters drops prototype-tampering keys directly', () => {
    const hostileInput = JSON.parse(
      '{"input":"x","__proto__":{"polluted":true},"constructor":"ctor","prototype":"proto"}'
    ) as Record<string, unknown>;
    const sanitized = ToolAwareSimpleAgent.sanitizeParameters(hostileInput);
    expect(Object.keys(sanitized)).toEqual(['input']);
    expect((sanitized as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
