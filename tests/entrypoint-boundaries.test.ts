/**
 * #81 入口边界测试：教学版根入口收敛与可选模块依赖边界。
 *
 * 验收②（根入口与子路径 exports）、验收③（WorkingMemory 同名异义）、
 * 验收④（核心包无重依赖可导入 + 可选模块独立失败）。
 *
 * 约定：1.x 专属符号（Session 持久化、Skills、subagents、TodoWrite/DevLog、
 * 文件工具、SSE、provider 适配器等）不得从根入口导出；教学符号必须可用；
 * 数据库/协议/评测/RL 重依赖按需加载，import 核心包不触发。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as entry from '../hello_agents/index.js';
import { WorkingMemory as TeachingWorkingMemory } from '../hello_agents/memory/types/working.js';
import { MemoryItem } from '../hello_agents/memory/base.js';
import { WorkingMemory as LegacyWorkingMemory } from '../hello_agents/context/working-memory.js';
import { z } from 'zod';

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')
) as { exports: Record<string, unknown> };

describe('#81 teaching entrypoint boundary', () => {
  test('root entrypoint keeps teaching symbols importable', () => {
    expect(typeof entry.HelloAgentsLLM).toBe('function');
    expect(typeof entry.Message).toBe('function');
    expect(typeof entry.SimpleAgent).toBe('function');
    expect(typeof entry.ReActAgent).toBe('function');
    expect(typeof entry.ToolRegistry).toBe('function');
    expect(typeof entry.ContextBuilder).toBe('function');
    expect(typeof entry.createConfig).toBe('function');
    expect(typeof entry.version).toBe('string');
  });

  test('1.x-only symbols are NOT exported from the root entrypoint', () => {
    const entryMap = entry as unknown as Record<string, unknown>;
    const removed: Array<[string, unknown]> = [
      ['SessionStore', entryMap.SessionStore],
      ['SessionData', entryMap.SessionData],
      ['SkillLoader', entryMap.SkillLoader],
      ['SkillTool', entryMap.SkillTool],
      ['TaskTool', entryMap.TaskTool],
      ['TodoWriteTool', entryMap.TodoWriteTool],
      ['DevLogTool', entryMap.DevLogTool],
      ['EditTool', entryMap.EditTool],
      ['WriteTool', entryMap.WriteTool],
      ['streamToJsonLines', entryMap.streamToJsonLines],
      ['streamToSse', entryMap.streamToSse],
      ['StreamBuffer', entryMap.StreamBuffer],
      ['createAgent', entryMap.createAgent],
      ['IsolatedSubagent', entryMap.IsolatedSubagent],
      ['CustomFilter', entryMap.CustomFilter],
      ['ReadOnlyFilter', entryMap.ReadOnlyFilter]
    ];
    for (const [name, value] of removed) {
      expect(value, `${name} must not be exported from the teaching entrypoint`).toBeUndefined();
    }
  });

  test('WorkingMemory resolves to the teaching memory implementation, not the 1.x alias', () => {
    expect(entry.WorkingMemory).toBe(TeachingWorkingMemory);
    expect(entry.WorkingMemory).not.toBe(LegacyWorkingMemory);
    const memory = new entry.WorkingMemory();
    memory.add(
      new MemoryItem({
        id: 'entry-boundary',
        content: 'teaching working memory',
        importance: 0.9,
        timestamp: new Date()
      })
    );
    expect(memory.getAll().map((item) => item.id)).toContain('entry-boundary');
  });

  test('optional backend clients are loaded on demand, never at import time', () => {
    const qdrantSource = readFileSync(
      join(import.meta.dir, '..', 'hello_agents', 'memory', 'storage', 'qdrant-store.ts'),
      'utf8'
    );
    const neo4jSource = readFileSync(
      join(import.meta.dir, '..', 'hello_agents', 'memory', 'storage', 'neo4j-store.ts'),
      'utf8'
    );
    // Static top-level imports must not reference the optional clients.
    expect(qdrantSource).not.toMatch(/from\s+['"]@qdrant/);
    expect(neo4jSource).not.toMatch(/from\s+['"]neo4j-driver/);
    // They are reachable only through dynamic import (used inside the store methods).
    expect(qdrantSource).toContain("import('@qdrant/js-client-rest')");
    expect(neo4jSource).toContain("import('neo4j-driver')");
  });

  test('package exports declare only teaching entrypoints; optional modules are not resolvable', () => {
    const declared = Object.keys(packageJson.exports);
    expect(declared).toContain('.');
    for (const sub of [
      './agents',
      './context',
      './core',
      './memory',
      './memory/rag',
      './memory/storage',
      './memory/types',
      './protocols',
      './protocols/mcp',
      './protocols/a2a',
      './protocols/anp',
      './tools',
      './utils'
    ]) {
      expect(declared).toContain(sub);
    }
    for (const optional of ['./evaluation', './rl', './adapters', './skills']) {
      expect(declared).not.toContain(optional);
    }
    // The root export object must map to dist paths (types + import + default).
    const rootEntry = packageJson.exports['.'] as Record<string, string>;
    expect(rootEntry.types).toBe('./dist/index.d.ts');
    expect(rootEntry.import).toBe('./dist/index.js');
  });

  test('subpath entrypoints expose their teaching barrels', async () => {
    const [agents, context, core, memory, tools, utils] = await Promise.all([
      import('../hello_agents/agents/index.js'),
      import('../hello_agents/context/index.js'),
      import('../hello_agents/core/index.js'),
      import('../hello_agents/memory/index.js'),
      import('../hello_agents/tools/index.js'),
      import('../hello_agents/utils/index.js')
    ]);
    expect(typeof agents.SimpleAgent).toBe('function');
    expect(typeof agents.ReActAgent).toBe('function');
    expect(typeof context.ContextBuilder).toBe('function');
    expect(typeof context.TokenCounter).toBe('function');
    expect(typeof core.HelloAgentsLLM).toBe('function');
    expect(typeof memory.MemoryManager).toBe('function');
    expect(typeof memory.WorkingMemory).toBe('function');
    expect(typeof tools.ToolRegistry).toBe('function');
    expect(typeof utils.Logger).toBe('function');
    const rag = await import('../hello_agents/memory/rag/index.js');
    const storage = await import('../hello_agents/memory/storage/index.js');
    const types = await import('../hello_agents/memory/types/index.js');
    expect(typeof rag.createRagPipeline).toBe('function');
    expect(typeof storage.DocumentStore).toBe('function');
    expect(typeof types.WorkingMemory).toBe('function');
    // #75: protocol subpaths expose the MCP/A2A/ANP teaching barrels.
    const protocols = await import('../hello_agents/protocols/index.js');
    const mcp = await import('../hello_agents/protocols/mcp/index.js');
    const a2a = await import('../hello_agents/protocols/a2a/index.js');
    const anp = await import('../hello_agents/protocols/anp/index.js');
    expect(typeof protocols.MCPClient).toBe('function');
    expect(typeof protocols.MCPServer).toBe('function');
    expect(typeof protocols.A2AServer).toBe('function');
    expect(typeof protocols.A2AClient).toBe('function');
    expect(typeof protocols.ANPDiscovery).toBe('function');
    expect(typeof mcp.createContext).toBe('function');
    expect(typeof a2a.createExampleAgent).toBe('function');
    expect(typeof anp.registerService).toBe('function');
  });

  test('teaching subpath barrels stay usable end-to-end (context + memory + tools)', async () => {
    const { ContextBuilder, TokenCounter } = await import('../hello_agents/context/index.js');
    const { MemoryManager } = await import('../hello_agents/memory/index.js');
    const { ToolRegistry, FunctionTool } = await import('../hello_agents/tools/index.js');
    const counter = new TokenCounter({ tokenize: (text) => [...text].length });
    const builder = new ContextBuilder({ maxTokens: 128, tokenCounter: counter });
    expect(await builder.build('hello', [])).toBeTypeOf('string');
    const manager = new MemoryManager({ enablePerceptual: false });
    manager.addMemory('subpath working memory entry');
    expect((await manager.retrieveMemories('subpath')).length).toBeGreaterThan(0);
    const registry = new ToolRegistry();
    registry.registerFunction(
      new FunctionTool({
        name: 'echo',
        description: 'echo',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: ({ input }) => input
      })
    );
    expect((await registry.execute('echo', { input: 'x' })).toJSON().data.output).toBe('x');
  });
});
