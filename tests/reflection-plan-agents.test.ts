import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_EXECUTOR_PROMPT,
  DEFAULT_PLANNER_PROMPT,
  DEFAULT_PROMPTS,
  Executor,
  HelloAgentsLLM,
  INVALID_PLAN_ANSWER,
  Memory,
  MockAdapter,
  PlanAndSolveAgent,
  Planner,
  ReflectionAgent,
  parsePlan
} from '../hello_agents/index.js';

const config = { model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test' };

function llm(replies: string[]): HelloAgentsLLM {
  return new HelloAgentsLLM({
    ...config,
    adapter: new MockAdapter({
      invoke: () => ({
        content: replies.shift() ?? '',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    })
  });
}

describe('ReflectionAgent and Memory', () => {
  test('performs initial execution, reflection, refinement, then early stops with upstream prompts', async () => {
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
      maxIterations: 3
    });

    await expect(agent.run('write')).resolves.toBe('improved draft');
    expect(agent.memory.records).toEqual([
      { type: 'execution', content: 'draft' },
      { type: 'reflection', content: 'please add detail' },
      { type: 'execution', content: 'improved draft' },
      { type: 'reflection', content: '无需改进' }
    ]);
    expect(adapter.requests.map((request) => request.messages[0]?.content)).toEqual([
      DEFAULT_PROMPTS.initial.replaceAll('{task}', 'write'),
      DEFAULT_PROMPTS.reflect.replaceAll('{task}', 'write').replaceAll('{content}', 'draft'),
      DEFAULT_PROMPTS.refine
        .replaceAll('{task}', 'write')
        .replaceAll('{last_attempt}', 'draft')
        .replaceAll('{feedback}', 'please add detail'),
      DEFAULT_PROMPTS.reflect
        .replaceAll('{task}', 'write')
        .replaceAll('{content}', 'improved draft')
    ]);
  });

  test('Memory formats only recognized records and Reflection reaches its iteration limit', async () => {
    const memory = new Memory();
    memory.addRecord('other', 'ignored');
    memory.addRecord('execution', 'first');
    memory.addRecord('reflection', 'review');
    expect(memory.getLastExecution()).toBe('first');
    expect(memory.getTrajectory()).toBe(
      '--- 上一轮尝试 (代码) ---\nfirst\n\n--- 评审员反馈 ---\nreview'
    );

    const agent = new ReflectionAgent({
      name: 'reflector',
      llm: llm(['draft', 'fix one', 'draft one', 'fix two', 'draft two']),
      maxIterations: 2,
      customPrompts: { initial: 'I {task}', reflect: 'R {content}', refine: 'F {feedback}' }
    });
    await expect(agent.run('task')).resolves.toBe('draft two');
    expect(agent.memory.records).toHaveLength(5);
  });

  test('retains empty LLM results and propagates errors without appending history', async () => {
    const empty = new ReflectionAgent({ name: 'reflector', llm: llm(['', '无需改进']) });
    await expect(empty.run('task')).resolves.toBe('');
    expect(empty.memory.records).toEqual([
      { type: 'execution', content: '' },
      { type: 'reflection', content: '无需改进' }
    ]);

    const failed = new ReflectionAgent({
      name: 'reflector',
      llm: new HelloAgentsLLM({
        ...config,
        adapter: new MockAdapter({ invoke: () => Promise.reject(new Error('offline')) })
      })
    });
    await expect(failed.run('task')).rejects.toThrow('LLM invoke failed');
    expect(failed.getHistory()).toEqual([]);
  });
});

describe('Planner, Executor, and PlanAndSolveAgent', () => {
  test('direct Planner accepts only the upstream fenced Python string-list response', async () => {
    const planner = new Planner(llm(['```python\n["research", \'write\']\n```']));
    await expect(planner.plan('question')).resolves.toEqual(['research', 'write']);
    expect(parsePlan('["unfenced"]')).toEqual([]);
    expect(parsePlan('```json\n["wrong fence"]\n```')).toEqual([]);
    expect(parsePlan('```python\n[]\n```')).toEqual([]);
    expect(parsePlan('```python\n[not a string]\n```')).toEqual([]);
    expect(DEFAULT_PLANNER_PROMPT).toContain('```python');
  });

  test('Executor preserves Python-list plan text and accumulates upstream history between steps', async () => {
    const adapter = new MockAdapter({
      invoke: () => ({
        content: replies.shift() ?? '',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const replies = ['fact', 'final'];
    const executor = new Executor(new HelloAgentsLLM({ ...config, adapter }));

    await expect(executor.execute('question', ['research', 'write'])).resolves.toBe('final');
    expect(adapter.requests[0]?.messages[0]?.content).toBe(
      DEFAULT_EXECUTOR_PROMPT.replaceAll('{question}', 'question')
        .replaceAll('{plan}', "['research', 'write']")
        .replaceAll('{history}', '无')
        .replaceAll('{current_step}', 'research')
    );
    expect(adapter.requests[1]?.messages[0]?.content).toContain('步骤 1: research\n结果: fact\n\n');
  });

  test('PlanAndSolveAgent runs direct helpers in order and records the completed exchange', async () => {
    const agent = new PlanAndSolveAgent({
      name: 'planner',
      llm: llm(['```python\n["research", "write"]\n```', 'fact', 'final'])
    });

    await expect(agent.run('question')).resolves.toBe('final');
    expect(agent.getHistory().map((message) => message.content)).toEqual(['question', 'final']);
  });

  test('handles invalid and empty plans with the upstream fallback and propagates planning errors', async () => {
    const invalid = new PlanAndSolveAgent({ name: 'planner', llm: llm(['["unfenced"]']) });
    await expect(invalid.run('question')).resolves.toBe(INVALID_PLAN_ANSWER);
    const empty = new PlanAndSolveAgent({ name: 'planner', llm: llm(['```python\n[]\n```']) });
    await expect(empty.run('question')).resolves.toBe(INVALID_PLAN_ANSWER);

    const failed = new PlanAndSolveAgent({
      name: 'planner',
      llm: new HelloAgentsLLM({
        ...config,
        adapter: new MockAdapter({ invoke: () => Promise.reject(new Error('offline')) })
      })
    });
    await expect(failed.run('question')).rejects.toThrow('LLM invoke failed');
    expect(failed.getHistory()).toEqual([]);
  });
});
