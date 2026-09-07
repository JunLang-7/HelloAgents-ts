import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  ReActAgent,
  ToolRegistry,
  parseReActAction,
  parseReActActionInput,
  parseReActOutput
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

describe('ReActAgent', () => {
  test('uses the upstream text prompt, records Action/Observation, and finishes', async () => {
    const adapter = new MockAdapter({
      invoke: () => ({
        content: replies.shift() ?? '',
        model: 'test-model',
        usage: {},
        latency_ms: 0
      })
    });
    const replies = [
      'Thought: need an echo\nAction: echo[hello]',
      'Thought: done\nAction: Finish[hello]'
    ];
    const registry = new ToolRegistry().registerFunction(
      new FunctionTool({
        name: 'echo',
        description: 'Repeat the input.',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: ({ input }) => input
      })
    );
    const agent = new ReActAgent({
      name: 'react',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: registry
    });

    await expect(agent.run('say hello')).resolves.toBe('hello');
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]?.messages[0]?.content).toContain('**Question:** say hello');
    expect(adapter.requests[0]?.messages[0]?.content).toContain('- echo: Repeat the input.');
    expect(adapter.requests[1]?.messages[0]?.content).toContain(
      'Action: echo[hello]\nObservation: hello'
    );
    expect(agent.currentHistory).toEqual(['Action: echo[hello]', 'Observation: hello']);
    expect(agent.getHistory().map((message) => message.content)).toEqual(['say hello', 'hello']);
  });

  test('continues after an invalid action format and exposes text parsing helpers', async () => {
    const agent = new ReActAgent({
      name: 'react',
      llm: llm(['Thought: malformed\nAction: echo without brackets', 'Action: Finish[recovered]'])
    });

    await expect(agent.run('task')).resolves.toBe('recovered');
    expect(agent.currentHistory).toEqual(['Observation: 无效的Action格式，请检查。']);
    expect(parseReActOutput('Thought: one\nAction: echo[value]')).toEqual(['one', 'echo[value]']);
    expect(parseReActOutput('Action: echo[value]')).toEqual([undefined, 'echo[value]']);
    expect(parseReActAction('echo[value]')).toEqual(['echo', 'value']);
    expect(parseReActAction('not valid')).toEqual([undefined, undefined]);
    expect(parseReActActionInput('Finish[a] b]')).toBe('a] b');
  });

  test('uses the upstream max-step fallback for empty responses and unfinished work', async () => {
    const empty = new ReActAgent({ name: 'react', llm: llm(['']) });
    await expect(empty.run('empty')).resolves.toBe('抱歉，我无法在限定步数内完成这个任务。');

    const unfinished = new ReActAgent({
      name: 'react',
      maxSteps: 1,
      llm: llm(['Thought: more\nAction: echo[again]'])
    });
    await expect(unfinished.run('never finish')).resolves.toBe(
      '抱歉，我无法在限定步数内完成这个任务。'
    );
    expect(unfinished.currentHistory).toEqual([
      'Action: echo[again]',
      "Observation: 未找到名为 'echo' 的工具"
    ]);
  });

  test('propagates LLM errors without recording a completed exchange', async () => {
    const agent = new ReActAgent({
      name: 'react',
      llm: new HelloAgentsLLM({
        ...config,
        adapter: new MockAdapter({ invoke: () => Promise.reject(new Error('offline')) })
      })
    });

    await expect(agent.run('task')).rejects.toThrow('LLM invoke failed');
    expect(agent.getHistory()).toEqual([]);
  });
});
