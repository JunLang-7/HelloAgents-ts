import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Message, SessionStore } from '../src/index.js';

describe('SessionStore', () => {
  test('atomically persists validated snake_case session data and restores it in a new store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'helloagents-session-'));
    try {
      const store = new SessionStore({
        sessionDir: directory,
        now: () => new Date('2026-08-12T12:00:00.000Z')
      });
      const path = await store.save({
        sessionName: 'demo',
        agentConfig: { llm_provider: 'openai', llm_model: 'test', max_steps: 3 },
        history: [new Message('hello', 'user')],
        toolSchemaHash: 'hash-a',
        readCache: { 'file.txt': { file_size_bytes: 3 } },
        metadata: { total_tokens: 2 }
      });
      const restored = await new SessionStore({ sessionDir: directory }).load(path);

      expect(path).toEndWith('demo.json');
      expect(restored.toJSON()).toMatchObject({
        agent_config: { llm_model: 'test' },
        history: [{ role: 'user', content: 'hello' }],
        tool_schema_hash: 'hash-a',
        read_cache: { 'file.txt': { file_size_bytes: 3 } }
      });
      expect(await store.listSessions()).toMatchObject([{ filename: 'demo.json' }]);
      expect(await store.delete('demo')).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('reports Python-compatible configuration and schema-hash consistency warnings', async () => {
    const store = new SessionStore({
      sessionDir: await mkdtemp(join(tmpdir(), 'helloagents-session-'))
    });
    try {
      expect(
        store.checkConfigConsistency(
          { llm_provider: 'openai', llm_model: 'a', max_steps: 3 },
          { llm_provider: 'anthropic', llm_model: 'b', max_steps: 4 }
        )
      ).toEqual({
        consistent: false,
        warnings: ['LLM 提供商变化: openai → anthropic', '模型变化: a → b', '最大步数变化: 3 → 4']
      });
      expect(store.checkToolSchemaConsistency('a', 'b')).toEqual({
        changed: true,
        saved_hash: 'a',
        current_hash: 'b',
        recommendation: '建议重新读取文件'
      });
    } finally {
      await rm(store.sessionDir, { recursive: true, force: true });
    }
  });
});
