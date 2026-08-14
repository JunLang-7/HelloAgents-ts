import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  ReActAgent,
  ToolRegistry
} from '../hello_agents/index.js';

const config = { model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test' };

function llm(handler: ConstructorParameters<typeof MockAdapter>[0]): HelloAgentsLLM {
  return new HelloAgentsLLM({ ...config, adapter: new MockAdapter(handler) });
}

describe('ReActAgent', () => {
  test('includes Thought and Finish schemas, and Thought does not complete the task', async () => {
    let step = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => {
        step += 1;
        return step === 1
          ? {
              content: null,
              tool_calls: [
                { id: 'thought_1', name: 'Thought', arguments: '{"reasoning":"need calculate"}' }
              ],
              model: 'test-model',
              usage: { total_tokens: 3 },
              latency_ms: 0
            }
          : {
              content: null,
              tool_calls: [{ id: 'finish_1', name: 'Finish', arguments: '{"answer":"42"}' }],
              model: 'test-model',
              usage: { total_tokens: 2 },
              latency_ms: 0
            };
      }
    });
    const agent = new ReActAgent({
      name: 'react',
      llm: new HelloAgentsLLM({ ...config, adapter })
    });

    await expect(agent.run('solve')).resolves.toBe('42');
    expect(adapter.toolRequests[0]?.tools.slice(0, 2)).toMatchObject([
      { function: { name: 'Thought' } },
      { function: { name: 'Finish' } }
    ]);
    expect(adapter.toolRequests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'thought_1',
      content: '推理: need calculate'
    });
    expect(agent.sessionMetadata).toMatchObject({ total_steps: 2, total_tokens: 5 });
  });

  test('executes same-round user tools concurrently but writes observations in model order', async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let round = 0;
    const adapter = new MockAdapter({
      invokeWithTools: () => {
        round += 1;
        return round === 1
          ? {
              content: null,
              tool_calls: [
                { id: 'slow', name: 'slow', arguments: '{"input":"one"}' },
                { id: 'fast', name: 'fast', arguments: '{"input":"two"}' }
              ],
              model: 'test-model',
              usage: {},
              latency_ms: 0
            }
          : {
              content: null,
              tool_calls: [{ id: 'finish', name: 'Finish', arguments: '{"answer":"done"}' }],
              model: 'test-model',
              usage: {},
              latency_ms: 0
            };
      }
    });
    const registry = new ToolRegistry();
    registry.registerFunction(
      new FunctionTool({
        name: 'slow',
        description: 'Slow.',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: async ({ input }) => {
          started.push('slow');
          await firstReleased;
          return input;
        }
      })
    );
    registry.registerFunction(
      new FunctionTool({
        name: 'fast',
        description: 'Fast.',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: ({ input }) => {
          started.push('fast');
          releaseFirst?.();
          return input;
        }
      })
    );
    const agent = new ReActAgent({
      name: 'react',
      llm: new HelloAgentsLLM({ ...config, adapter }),
      toolRegistry: registry
    });

    await expect(agent.run('parallel')).resolves.toBe('done');
    expect(started).toEqual(['slow', 'fast']);
    expect(adapter.toolRequests[1]?.messages.slice(-3)).toMatchObject([
      { role: 'assistant', tool_calls: [{ id: 'slow' }, { id: 'fast' }] },
      { role: 'tool', tool_call_id: 'slow', content: 'one' },
      { role: 'tool', tool_call_id: 'fast', content: 'two' }
    ]);
  });

  test('returns text without tools and Python-compatible max-step fallback when unfinished', async () => {
    const direct = new ReActAgent({
      name: 'react',
      llm: llm({
        invokeWithTools: () => ({
          content: 'direct',
          tool_calls: [],
          model: 'test-model',
          usage: {},
          latency_ms: 0
        })
      })
    });
    await expect(direct.run('hello')).resolves.toBe('direct');
    expect(direct.listTools()).toEqual([]);

    const unfinished = new ReActAgent({
      name: 'react',
      maxSteps: 1,
      llm: llm({
        invokeWithTools: () => ({
          content: null,
          tool_calls: [{ id: 'thought', name: 'Thought', arguments: '{"reasoning":"more"}' }],
          model: 'test-model',
          usage: {},
          latency_ms: 0
        })
      })
    });
    await expect(unfinished.run('never finish')).resolves.toBe(
      '抱歉，我无法在限定步数内完成这个任务。'
    );
  });
});
