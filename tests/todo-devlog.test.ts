import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DevLogTool, TodoWriteTool, ToolErrorCode, ToolRegistry } from '../src/index.js';

describe('TodoWriteTool', () => {
  test('validates transitions, maintains a single in-progress item, persists atomically, and restores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-todos-'));
    try {
      const tool = await TodoWriteTool.create({ projectRoot: root, persistenceDir: 'todos' });
      const invalid = await tool.execute({
        todos: [
          { content: 'one', status: 'in_progress' },
          { content: 'two', status: 'in_progress' }
        ]
      });
      expect(invalid.errorInfo?.code).toBe(ToolErrorCode.INVALID_PARAM);
      const created = await tool.execute({
        summary: 'ship it',
        todos: [
          { content: 'implement', status: 'in_progress' },
          { content: 'test', status: 'pending' },
          { content: 'release', status: 'completed' }
        ]
      });
      expect(created).toMatchObject({
        status: 'success',
        data: { stats: { total: 3, in_progress: 1 } }
      });
      const savedPath = tool.persistencePath;
      expect(JSON.parse(await readFile(savedPath, 'utf8'))).toMatchObject({
        schema_version: 1,
        summary: 'ship it'
      });
      const restored = await TodoWriteTool.create({ projectRoot: root, persistenceDir: 'todos' });
      expect(restored.todos).toHaveLength(3);
      expect((await restored.execute({ action: 'clear' })).data).toMatchObject({
        stats: { total: 0 }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('exposes a Zod-derived Function Calling schema with only todos required for create/update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-todos-'));
    try {
      const tool = await TodoWriteTool.create({ projectRoot: root });
      const registry = new ToolRegistry().register(tool);
      expect(registry.toOpenAISchemas()[0]?.function.parameters).toMatchObject({
        properties: { todos: expect.any(Object) }
      });
      expect((await tool.execute({ action: 'update' })).errorInfo?.code).toBe(
        ToolErrorCode.INVALID_PARAM
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('DevLogTool', () => {
  test('appends, filters, summarizes in first-category order, atomically persists, and restores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-devlog-'));
    try {
      const tool = await DevLogTool.create({
        sessionId: 's1',
        agentName: 'Agent',
        projectRoot: root,
        persistenceDir: 'logs'
      });
      await tool.execute({
        action: 'append',
        category: 'issue',
        content: 'first',
        metadata: { tags: ['bug'] }
      });
      await tool.execute({
        action: 'append',
        category: 'decision',
        content: 'second',
        metadata: { tags: ['design'] }
      });
      await tool.execute({ action: 'append', category: 'issue', content: 'third' });
      expect(await tool.execute({ action: 'summary' })).toMatchObject({
        text: expect.stringContaining('issue(2), decision(1)')
      });
      expect(await tool.execute({ action: 'read', filter: { tags: ['bug'] } })).toMatchObject({
        data: { entries: [{ content: 'first' }] }
      });
      expect(JSON.parse(await readFile(tool.persistencePath, 'utf8'))).toMatchObject({
        schema_version: 1,
        session_id: 's1'
      });
      const restored = await DevLogTool.create({
        sessionId: 's1',
        agentName: 'Agent',
        projectRoot: root,
        persistenceDir: 'logs'
      });
      expect(await restored.execute({ action: 'read' })).toMatchObject({ stats: { matched: 3 } });
      expect(
        (await restored.execute({ action: 'append', category: 'bad', content: 'x' })).errorInfo
          ?.code
      ).toBe(ToolErrorCode.INVALID_PARAM);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('serializes concurrent appends so the persisted JSON remains recoverable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-devlog-concurrent-'));
    try {
      const tool = await DevLogTool.create({
        sessionId: 'parallel',
        agentName: 'Agent',
        projectRoot: root
      });
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          tool.execute({ action: 'append', category: 'progress', content: `step ${index}` })
        )
      );
      expect(results.every((result) => result.status === 'success')).toBe(true);
      expect(JSON.parse(await readFile(tool.persistencePath, 'utf8')).entries).toHaveLength(12);
      const restored = await DevLogTool.create({
        sessionId: 'parallel',
        agentName: 'Agent',
        projectRoot: root
      });
      expect(restored.logEntries).toHaveLength(12);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
