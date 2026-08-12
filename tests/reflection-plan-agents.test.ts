import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  PlanAndSolveAgent,
  PlanSolveAgent,
  ReflectionAgent,
  ToolRegistry
} from '../src/index.js';

const config = { model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test' };

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe('ReflectionAgent', () => {
  test('records the initial/reflection/refinement trajectory and stops early on no-improvement feedback', async () => {
    const replies = ['draft', 'please add detail', 'improved draft', '无需改进'];
    const adapter = new MockAdapter({
      invoke: () => ({
        content: replies.shift() ?? '',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new ReflectionAgent({
      name: 'reflector',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      maxIterations: 3,
      customPrompts: {
        initial: 'START {task}',
        reflect: 'CHECK {content}',
        refine: 'FIX {feedback}'
      }
    });

    await expect(agent.run('write')).resolves.toBe('improved draft');
    expect(agent.memory.records).toEqual([
      { type: 'execution', content: 'draft' },
      { type: 'reflection', content: 'please add detail' },
      { type: 'execution', content: 'improved draft' },
      { type: 'reflection', content: '无需改进' }
    ]);
    expect(adapter.requests.map((request) => request.messages.at(-1)?.content)).toEqual([
      'START write',
      'CHECK draft',
      'FIX please add detail',
      'CHECK improved draft'
    ]);
  });

  test('executes Function Calling during a reflection phase and labels stream events', async () => {
    let calls = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => {
        calls += 1;
        return calls === 1
          ? {
              content: null,
              tool_calls: [{ id: 'one', name: 'echo', arguments: '{"value":"ok"}' }],
              model: 'test-model',
              usage: {},
              latency_ms: 0
            }
          : {
              content: calls === 2 ? 'draft ok' : '无需改进',
              tool_calls: [],
              model: 'test-model',
              usage: {},
              latency_ms: 0
            };
      }
    });
    const registry = new ToolRegistry().registerFunction(
      new FunctionTool({
        name: 'echo',
        description: 'echo',
        inputSchema: z.object({ value: z.string() }).strict(),
        handler: ({ value }) => value
      })
    );
    const agent = new ReflectionAgent({
      name: 'reflector',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: registry,
      maxIterations: 1
    });
    const events = await collect(agent.arunStream('task'));
    expect(events.map((event) => event.type)).toContain('reflection');
    expect(events.at(-1)?.data).toMatchObject({ result: 'draft ok' });
    expect(adapter.toolRequests).toHaveLength(3);
  });

  test('emits agent_error before propagating an LLM failure from the stream', async () => {
    const agent = new ReflectionAgent({
      name: 'reflector',
      llm: new HelloAgentsLLM({
        ...config,
        adapter: new MockAdapter({ invoke: () => Promise.reject(new Error('offline')) })
      })
    });
    const events: string[] = [];
    await expect(
      (async () => {
        for await (const event of agent.arunStream('task')) events.push(event.type);
      })()
    ).rejects.toThrow('LLM invoke failed');
    expect(events).toEqual(['agent_start', 'step_start', 'agent_error']);
  });
});

describe('PlanSolveAgent', () => {
  test('safely parses a Python-list plan, executes ordered steps, retains history, and exports an alias', async () => {
    const replies = ['```python\n["research", "write"]\n```', 'fact', 'final'];
    const adapter = new MockAdapter({
      invoke: () => ({
        content: replies.shift() ?? '',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const agent = new PlanSolveAgent({
      name: 'planner',
      llm: new HelloAgentsLLM({ ...config, adapter })
    });
    await expect(agent.run('question')).resolves.toBe('final');
    expect(agent.lastPlan).toEqual(['research', 'write']);
    expect(agent.lastStepResults).toEqual(['fact', 'final']);
    expect(PlanAndSolveAgent).toBe(PlanSolveAgent);
  });

  test('executes Function Calling while completing a planned step', async () => {
    let calls = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => {
        calls += 1;
        return calls === 1
          ? {
              content: '["use tool"]',
              tool_calls: [],
              model: 'test-model',
              usage: {},
              latency_ms: 0
            }
          : calls === 2
            ? {
                content: null,
                tool_calls: [
                  { id: 'step-tool', name: 'echo', arguments: '{"value":"tool result"}' }
                ],
                model: 'test-model',
                usage: {},
                latency_ms: 0
              }
            : {
                content: 'completed',
                tool_calls: [],
                model: 'test-model',
                usage: {},
                latency_ms: 0
              };
      }
    });
    const registry = new ToolRegistry().registerFunction(
      new FunctionTool({
        name: 'echo',
        description: 'echo',
        inputSchema: z.object({ value: z.string() }).strict(),
        handler: ({ value }) => value
      })
    );
    const agent = new PlanSolveAgent({
      name: 'planner',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: registry
    });
    await expect(agent.run('question')).resolves.toBe('completed');
    expect(adapter.toolRequests).toHaveLength(3);
    expect(adapter.toolRequests.at(-1)?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'step-tool',
      content: 'tool result'
    });
  });

  test('terminates deterministically on unsafe/invalid plans and emits plan/step events', async () => {
    const invalid = new PlanSolveAgent({
      name: 'planner',
      llm: new HelloAgentsLLM({
        ...config,
        adapter: new MockAdapter({
          invoke: () => ({
            content: '__import__("os").system("bad")',
            model: 'test-model',
            usage: {},
            latency_ms: 0
          })
        })
      })
    });
    await expect(invalid.run('question')).resolves.toBe('无法生成有效的行动计划，任务终止。');

    const replies = ['["only step"]', 'answer'];
    const streamed = new PlanSolveAgent({
      name: 'planner',
      llm: new HelloAgentsLLM({
        ...config,
        adapter: new MockAdapter({
          invoke: () => ({
            content: replies.shift() ?? '',
            model: 'test-model',
            usage: {},
            latency_ms: 0
          })
        })
      })
    });
    const events = await collect(streamed.arunStream('question'));
    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'step_start',
      'plan',
      'step_finish',
      'step_start',
      'step_finish',
      'agent_finish'
    ]);
  });

  test('emits agent_error before propagating planning failures from the stream', async () => {
    const agent = new PlanSolveAgent({
      name: 'planner',
      llm: new HelloAgentsLLM({
        ...config,
        adapter: new MockAdapter({ invoke: () => Promise.reject(new Error('offline')) })
      })
    });
    const events: string[] = [];
    await expect(
      (async () => {
        for await (const event of agent.arunStream('question')) events.push(event.type);
      })()
    ).rejects.toThrow('LLM invoke failed');
    expect(events).toEqual(['agent_start', 'step_start', 'agent_error']);
  });
});
