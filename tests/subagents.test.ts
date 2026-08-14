import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  CustomFilter,
  FullAccessFilter,
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  IsolatedSubagent,
  PlanSolveAgent,
  ReadOnlyFilter,
  ReActAgent,
  ReflectionAgent,
  SimpleAgent,
  TaskTool,
  ToolErrorCode,
  ToolRegistry,
  createAgent,
  createAgentFactory
} from '../hello_agents/index.js';
import type { SubagentRunner } from '../hello_agents/index.js';

const config = { model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test' };

function registry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of ['Read', 'Write', 'Bash', 'Skill']) {
    registry.registerFunction(
      new FunctionTool({
        name,
        description: name,
        inputSchema: z.object({}).strict(),
        handler: () => name
      })
    );
  }
  return registry;
}

describe('ToolFilter', () => {
  test('enforces readonly/full/custom policies without changing source tool order', () => {
    const all = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill'];
    expect(new ReadOnlyFilter().filter(all)).toEqual(['Read', 'Glob', 'Grep', 'Skill']);
    expect(new FullAccessFilter().filter(all)).toEqual([
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Skill'
    ]);
    expect(new CustomFilter({ allowed: ['Write', 'Read'] }).filter(all)).toEqual(['Read', 'Write']);
    expect(new CustomFilter({ denied: ['Bash'], mode: 'blacklist' }).filter(all)).toEqual(
      all.filter((name) => name !== 'Bash')
    );
    expect(() => new CustomFilter({ mode: 'invalid' as 'whitelist' })).toThrow('Invalid mode');
  });
});

describe('TaskTool', () => {
  test('passes readonly filter and max_steps including zero, then returns structured success metadata', async () => {
    let seenFilter: ReadOnlyFilter | undefined;
    let seenMaxSteps: number | undefined;
    const runner: SubagentRunner = {
      runAsSubagent: async (_task, options) => {
        seenFilter = options.toolFilter as ReadOnlyFilter;
        seenMaxSteps = options.maxSteps;
        return {
          success: true,
          summary: 'done',
          metadata: { steps: 0, tokens: 3, duration_ms: 1, tools_used: ['Read'] }
        };
      }
    };
    const tool = new TaskTool({ agentFactory: () => runner });
    expect(tool.toOpenAISchema().function.parameters).toMatchObject({ required: ['task'] });
    const response = await tool.execute({ task: 'do it', tool_filter: 'readonly', max_steps: 0 });
    expect(response).toMatchObject({
      status: 'success',
      data: { steps: 0, tokens: 3, tools_used: ['Read'] }
    });
    expect(response.text).toContain('[SubAgent-react]');
    expect(seenFilter?.isAllowed('Write')).toBe(false);
    expect(seenMaxSteps).toBe(0);
  });

  test('returns partial failures and normalizes factory/runner errors without touching parent registry', async () => {
    const source = registry();
    const partial = new TaskTool({
      agentFactory: () => ({
        runAsSubagent: async () => ({
          success: false,
          summary: 'stopped',
          metadata: { steps: 0, tokens: 0, duration_ms: 1, tools_used: [], error: 'limit' }
        })
      })
    });
    expect(await partial.execute({ task: 'x', agent_type: 'simple' })).toMatchObject({
      status: 'partial',
      data: { error: 'limit' }
    });
    const failed = new TaskTool({
      agentFactory: () => {
        throw new Error('unsupported');
      }
    });
    expect((await failed.execute({ task: 'x', agent_type: 'bad' })).errorInfo?.code).toBe(
      ToolErrorCode.INVALID_PARAM
    );
    expect(source.list()).toEqual(['Read', 'Write', 'Bash', 'Skill']);
  });
});

describe('default subagent factory', () => {
  test('creates each public agent paradigm and rejects unsupported types', () => {
    const llm = new HelloAgentsLLM({ ...config, adapter: new MockAdapter() });
    expect(createAgent('simple', 'simple', llm)).toBeInstanceOf(SimpleAgent);
    expect(createAgent('react', 'react', llm)).toBeInstanceOf(ReActAgent);
    expect(createAgent('reflection', 'reflection', llm)).toBeInstanceOf(ReflectionAgent);
    expect(createAgent({ agentType: 'plan', name: 'plan', llm })).toBeInstanceOf(PlanSolveAgent);
    expect(() => createAgent('invalid', 'invalid', llm)).toThrow('不支持的 agent_type');
  });
  test('uses an isolated filtered registry and reports tools used without polluting the parent', async () => {
    const source = registry();
    const adapter = new MockAdapter({
      invokeWithTools: () => ({
        content: null,
        tool_calls: [{ id: 'call', name: 'Read', arguments: '{}' }],
        model: 'test-model',
        usage: { total_tokens: 4 },
        latency_ms: 0
      }),
      invoke: () => ({ content: 'complete', model: 'test-model', usage: {}, latency_ms: 0 })
    });
    const factory = createAgentFactory({
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: source
    });
    const subagent = await factory('simple');
    const result = await subagent.runAsSubagent('inspect', { toolFilter: new ReadOnlyFilter() });
    expect(result).toMatchObject({
      success: true,
      summary: 'complete',
      metadata: { tools_used: ['Read'] }
    });
    expect(source.list()).toEqual(['Read', 'Write', 'Bash', 'Skill']);
  });

  test('creates each requested agent paradigm and preserves a zero step override', async () => {
    const source = registry();
    const factory = createAgentFactory({
      llm: new HelloAgentsLLM({
        ...config,
        adapter: new MockAdapter({
          invoke: () => ({ content: 'fallback', model: 'test-model', usage: {}, latency_ms: 0 })
        })
      }),
      toolRegistry: source
    });
    expect(await factory('react')).toMatchObject({ agentType: 'react' });
    expect(await factory('reflection')).toMatchObject({ agentType: 'reflection' });
    expect(await factory('plan')).toMatchObject({ agentType: 'plan' });
    expect(await factory('simple')).toBeInstanceOf(IsolatedSubagent);
    const react = await factory('react');
    const result = await react.runAsSubagent('task', { maxSteps: 0 });
    expect(result.success).toBe(true);
    expect(source.list()).toEqual(['Read', 'Write', 'Bash', 'Skill']);
  });
});
