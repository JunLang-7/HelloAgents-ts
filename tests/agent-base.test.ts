import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import {
  Agent,
  FunctionTool,
  HelloAgentsLLM,
  MockAdapter,
  SessionStore,
  ToolRegistry
} from '../src/index.js';

class TestAgent extends Agent {
  public async run(input: string): Promise<string> {
    return input;
  }
}

describe('Agent base infrastructure', () => {
  test('shares tool schemas/execution and automatically compacts history at the configured budget', async () => {
    const registry = new ToolRegistry();
    registry.registerFunction(
      new FunctionTool({
        name: 'echo',
        description: 'Echo.',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: ({ input }) => input
      })
    );
    const agent = new TestAgent({
      name: 'base',
      llm: new HelloAgentsLLM({
        model: 'test',
        apiKey: 'key',
        baseUrl: 'https://provider.test',
        adapter: new MockAdapter()
      }),
      toolRegistry: registry,
      history: {
        maxTokens: 3,
        retainRecentTurns: 1,
        tokenCounter: {
          count: (text: string) => text.split(/\s+/).filter(Boolean).length,
          clear: () => undefined,
          getStats: () => ({ cache_hits: 0, cache_misses: 0, entries: 0 })
        } as never,
        summarize: () => 'summary'
      }
    });
    await agent.addMessage('first question', 'user');
    await agent.addMessage('first answer', 'assistant');
    await agent.addMessage('latest question', 'user');
    await agent.addMessage('latest answer', 'assistant');

    expect(agent.getHistory().map((message: { role: string }) => message.role)).toEqual([
      'summary',
      'user',
      'assistant'
    ]);
    expect(agent.buildToolSchemas()).toMatchObject([{ function: { name: 'echo' } }]);
    expect((await agent.executeToolCall('echo', { input: 'ok' })).text).toBe('ok');
  });

  test('round-trips history/read cache through SessionStore and exposes compatibility warnings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'helloagents-agent-'));
    try {
      const registry = new ToolRegistry();
      registry.cacheReadMetadata('note.txt', { file_size_bytes: 4 });
      const store = new SessionStore({ sessionDir: directory });
      const llm = new HelloAgentsLLM({
        model: 'test',
        apiKey: 'key',
        baseUrl: 'https://provider.test',
        adapter: new MockAdapter()
      });
      const agent = new TestAgent({
        name: 'base',
        llm,
        toolRegistry: registry,
        sessionStore: store
      });
      await agent.addMessage('persist me', 'user');
      const filepath = await agent.saveSession('agent');

      const restored = new TestAgent({
        name: 'base',
        llm,
        toolRegistry: new ToolRegistry(),
        sessionStore: store
      });
      const result = await restored.loadSession(filepath);
      expect(restored.getHistory().map((message: { content: string }) => message.content)).toEqual([
        'persist me'
      ]);
      expect(restored.toolRegistry.getReadMetadata('note.txt')).toEqual({ file_size_bytes: 4 });
      expect(result.toolSchema.changed).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
