/**
 * #75 协议模块测试：MCP（utils / server / client memory + stdio / 工具封装）。
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MCPServer,
  MCPServerBuilder,
  MCPClient,
  MemoryTransport,
  StdioJsonRpcTransport,
  createContext,
  createErrorResponse,
  createSuccessResponse,
  createExampleServer,
  parseContext
} from '../hello_agents/protocols/mcp/index.js';
import { MCPTool } from '../hello_agents/tools/builtin/protocol-tools.js';
import type { MCPWrappedTool } from '../hello_agents/tools/builtin/mcp-wrapper-tool.js';

const fixtureDir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

describe('MCP utils（对齐上游 protocols/mcp/utils.py）', () => {
  test('createContext fills defaults', () => {
    expect(createContext()).toEqual({
      messages: [],
      tools: [],
      resources: [],
      metadata: {}
    });
    expect(
      createContext([{ role: 'user', content: 'hi' }], undefined, undefined, { source: 'test' })
    ).toMatchObject({ metadata: { source: 'test' } });
  });

  test('parseContext parses JSON strings and records', () => {
    const parsed = parseContext('{"messages":[{"role":"user"}],"metadata":{"a":1}}');
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.metadata).toEqual({ a: 1 });
    expect(parseContext({ tools: [{ name: 't' }] }).tools).toHaveLength(1);
    expect(parseContext('{"unknown":true}').resources).toEqual([]);
  });

  test('parseContext rejects invalid input', () => {
    expect(() => parseContext('not json')).toThrow(/Invalid JSON/);
    expect(() => parseContext('[1,2]')).toThrow(/must be a dictionary/);
    expect(() => parseContext('42')).toThrow(/must be a dictionary/);
  });

  test('createErrorResponse / createSuccessResponse shapes', () => {
    expect(createErrorResponse('boom')).toEqual({
      error: { message: 'boom', code: 'UNKNOWN_ERROR' }
    });
    expect(createErrorResponse('denied', 'PERMISSION_DENIED', { path: '/x' })).toMatchObject({
      error: { code: 'PERMISSION_DENIED', details: { path: '/x' } }
    });
    expect(createSuccessResponse({ ok: 1 }, { trace: 't' })).toEqual({
      success: true,
      data: { ok: 1 },
      metadata: { trace: 't' }
    });
  });
});

describe('MCPServer + MemoryTransport（内存传输）', () => {
  test('registers tools/resources/prompts and serves them via MCPClient', async () => {
    const server = new MCPServer('calc-server', 'Calculator over MCP');
    server
      .addTool(
        (args: Record<string, unknown>) => Number(args.a ?? 0) + Number(args.b ?? 0),
        'add',
        'Add two numbers'
      )
      .addResource(
        (() => 'static resource content') as () => unknown,
        'info://static',
        'static-info',
        'Static info resource'
      )
      .addPrompt(
        (args: Record<string, unknown>) => `Question: ${String(args.question ?? '')}`,
        'ask',
        'Ask a question prompt'
      );

    expect(server.getInfo()).toMatchObject({ name: 'calc-server', tools_count: 1 });

    const client = new MCPClient(server);
    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['add']);
    expect(await client.callTool('add', { a: 2, b: 3 })).toBe(5);
    const resources = await client.listResources();
    expect(resources[0]?.uri).toBe('info://static');
    expect(await client.readResource('info://static')).toBe('static resource content');
    const prompts = await client.listPrompts();
    expect(prompts[0]?.name).toBe('ask');
    expect(await client.getPrompt('ask', { question: '1+1?' })).toEqual([
      { role: 'user', content: 'Question: 1+1?' }
    ]);
    expect(await client.ping()).toBe(true);
    expect(client.getTransportInfo().transport).toBe('memory');
    await client.close();
  });

  test('MemoryTransport can be used standalone', async () => {
    const transport = new MemoryTransport(createExampleServer());
    await transport.connect();
    expect((await transport.listTools()).map((tool) => tool.name)).toContain('greet');
    expect(await transport.callTool('greet', { name: 'TS' })).toContain('TS');
    await transport.close();
  });

  test('MCPServerBuilder chains and builds', () => {
    const server = new MCPServerBuilder('b', 'builder')
      .withTool((args: Record<string, unknown>) => Number(args.n ?? 0) * 2, 'double')
      .withPrompt((args: Record<string, unknown>) => `p:${String(args.x ?? '')}`, 'prompt')
      .build();
    expect(server.getInfo().tools_count).toBe(1);
  });

  test('unknown tool/resource/prompt and method errors surface clearly', async () => {
    const client = new MCPClient(createExampleServer());
    await expect(client.callTool('nope', {})).rejects.toThrow(/not found/);
    await expect(client.readResource('nope://x')).rejects.toThrow(/not found/);
    await expect(client.getPrompt('nope', {})).rejects.toThrow(/not found/);
    await client.close();
  });
});

describe('MCP stdio transport（真实子进程 + JSON-RPC 2.0，fixture 验证）', () => {
  const stdioServer = resolve(fixtureDir, 'mcp-stdio-server.ts');

  test('spawns the fixture server and calls tools over stdio', async () => {
    const client = new MCPClient([process.execPath, stdioServer]);
    const tools = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['add', 'subtract', 'multiply', 'divide', 'greet', 'get_system_info'])
    );
    const result = await client.callTool('divide', { a: 10, b: 2 });
    expect(Number(result)).toBe(5);
    expect(await client.ping()).toBe(true);
    expect(client.getTransportInfo().transport).toBe('stdio');
    await client.close();
  });

  test('stdio transport also serves resources and prompts', async () => {
    const transport = new StdioJsonRpcTransport([process.execPath, stdioServer]);
    await transport.connect();
    const greet = (await transport.listTools()).find((tool) => tool.name === 'greet');
    expect(greet?.description).toContain('greeting');
    await transport.close();
  });

  test('stdio server errors surface as client errors', async () => {
    // 用确定性错误响应（而非 spawn 失败/进程崩溃）覆盖客户端错误传播：
    // bun 1.3.14 x64 Linux 对 spawn ENOENT 不派发 'error'、对快速退出
    // 的子进程 'exit' 事件时序也不可靠；request 层 15s 兜底超时保证永不挂起。
    const script = [
      "const { createInterface } = require('node:readline');",
      'const rl = createInterface({ input: process.stdin });',
      "rl.on('line', (line) => {",
      '  const req = JSON.parse(line);',
      "  if (req.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'probe', version: '1' } } }) + '\\n');",
      '  } else {',
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'boom' } }) + '\\n');",
      '  }',
      '});',
      "rl.on('close', () => process.exit(0));"
    ].join('');
    const client = new MCPClient([process.execPath, '-e', script]);
    await expect(client.listTools()).rejects.toThrow(/MCP tools\/list failed: boom/);
    await client.close();
  });

  test('client sends notifications/initialized after the handshake (MCP lifecycle)', async () => {
    const notifyFile = join(tmpdir(), `mcp-initialized-${process.pid}-${Date.now()}.log`);
    const script = [
      "const { createInterface } = require('node:readline');",
      "const fs = require('node:fs');",
      'const rl = createInterface({ input: process.stdin });',
      "rl.on('line', (line) => {",
      '  const req = JSON.parse(line);',
      '  if (req.id === undefined) {',
      "    fs.appendFileSync(process.env.MCP_NOTIFY_FILE, req.method + '\\n');",
      "  } else if (req.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'probe', version: '1' } } }) + '\\n');",
      '  } else {',
      "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\\n');",
      '  }',
      '});',
      "rl.on('close', () => process.exit(0));"
    ].join('');
    const client = new MCPClient([process.execPath, '-e', script], [], {
      env: { ...process.env, MCP_NOTIFY_FILE: notifyFile }
    });
    await client.ping();
    // 通知写入异步完成，短暂等待后断言。
    await new Promise((resolve2) => setTimeout(resolve2, 150));
    await client.close();
    const log = readFileSync(notifyFile, 'utf8');
    rmSync(notifyFile, { force: true });
    expect(log).toContain('notifications/initialized');
  });
});

describe('MCPTool + MCPWrappedTool（协议→工具封装）', () => {
  test('MCPTool defaults to the built-in demo server (memory transport)', async () => {
    const tool = new MCPTool();
    const response = await tool.execute({ action: 'list_tools' });
    expect(response.status).toBe('success');
    expect(response.text).toContain('6 个工具');

    const addResponse = await tool.execute({
      action: 'call_tool',
      tool_name: 'add',
      arguments: { a: 4, b: 7 }
    });
    expect(addResponse.text).toContain('11');

    const infoResponse = await tool.execute({ action: 'call_tool', tool_name: 'get_system_info' });
    expect(infoResponse.text).toContain('server_name');
  });

  test('MCPTool expands wrapped tools via getExpandedToolsAsync', async () => {
    const tool = new MCPTool({ name: 'mcpdemo' });
    const expanded = await tool.getExpandedToolsAsync();
    const names = expanded.map((t) => t.name);
    expect(names).toContain('mcpdemo_add');
    expect(names).toContain('mcpdemo_greet');

    const wrapped = expanded.find((t) => t.name === 'mcpdemo_add') as MCPWrappedTool;
    const response = await wrapped.execute({ a: 20, b: 22 });
    expect(response.status).toBe('success');
    expect(response.text).toContain('42');
  });

  test('MCPWrappedTool builds input schema from MCP input_schema', async () => {
    const tool = new MCPTool();
    const expanded = await tool.getExpandedToolsAsync();
    const wrapped = expanded[0] as MCPWrappedTool;
    expect(wrapped.mcpToolName).toBeTypeOf('string');
    expect(wrapped.toDict().parameters).toBeInstanceOf(Array);
  });

  test('MCPTool supports stdio server commands', async () => {
    const stdioServer = resolve(fixtureDir, 'mcp-stdio-server.ts');
    const tool = new MCPTool({ serverCommand: [process.execPath, stdioServer] });
    const response = await tool.execute({
      action: 'call_tool',
      tool_name: 'multiply',
      arguments: { a: 6, b: 7 }
    });
    expect(response.status).toBe('success');
    expect(response.text).toContain('42');
  });

  test('MCPTool rejects unknown actions and missing args', async () => {
    const tool = new MCPTool();
    const badAction = await tool.execute({ action: 'explode' });
    expect(badAction.status).toBe('error');
    const missingName = await tool.execute({ action: 'call_tool' });
    expect(missingName.status).toBe('error');
  });
});
