/**
 * MCP 服务器（对齐上游 `protocols/mcp/server.py` 的教学参考实现）。
 *
 * 上游基于 fastmcp 的 `FastMCP`。TS 端不捆绑 fastmcp，改为维护本地
 * 工具/资源/提示词注册表（`McpServerLike`），并提供两种内置传输：
 * - `memory`：直接暴露自身（内存传输，供 MCPClient 测试与内置演示服务器）
 * - `stdio`：JSON-RPC 2.0 行协议（`initialize`/`ping`/`tools/list`/`tools/call`
 *   /`resources/list`/`resources/read`/`prompts/list`/`prompts/get`），用于
 *   本地进程边界验证
 *
 * `http`/`sse` 传输不在内置范围（DIFF-036）：教学端通过 transport port 注入，
 * 未配置时明确报错，不冒充真实服务端。
 */
import { createInterface } from 'node:readline';

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpPromptInfo,
  McpPromptMessage,
  McpResourceInfo,
  McpServerLike,
  McpToolInfo
} from './types.js';

type ToolHandler = (args: Record<string, unknown>) => unknown;
type ResourceHandler = (args: Record<string, unknown>) => unknown;
type PromptHandler = (args: Record<string, unknown>) => unknown;

export interface MCPServerOptions {
  name: string;
  description?: string;
}

export class MCPServer implements McpServerLike {
  public readonly name: string;
  public readonly description: string;

  private readonly toolHandlers = new Map<string, { fn: ToolHandler; description: string }>();
  private readonly resourceHandlers = new Map<
    string,
    { fn: ResourceHandler; uri: string; name: string; description: string }
  >();
  private readonly promptHandlers = new Map<string, { fn: PromptHandler; description: string }>();

  public constructor(name: string, description?: string);
  public constructor(options: MCPServerOptions);
  public constructor(nameOrOptions: string | MCPServerOptions, maybeDescription?: string) {
    const resolved =
      typeof nameOrOptions === 'string'
        ? { name: nameOrOptions, description: maybeDescription }
        : nameOrOptions;
    this.name = resolved.name;
    this.description = resolved.description ?? `${resolved.name} MCP Server`;
  }

  /** 注册工具（对应上游 `add_tool`；名称缺省取函数名）。 */
  public addTool(
    func: ToolHandler,
    name: string | undefined = undefined,
    description: string | undefined = undefined
  ): this {
    const toolName = name ?? func.name;
    if (!toolName) {
      throw new Error('MCP tool requires a name (anonymous functions must pass one)');
    }
    this.toolHandlers.set(toolName, {
      fn: func,
      description: description ?? ''
    });
    return this;
  }

  /** 注册资源（对应上游 `add_resource`；uri 缺省取函数名）。 */
  public addResource(
    func: ResourceHandler,
    uri: string | undefined = undefined,
    name: string | undefined = undefined,
    description: string | undefined = undefined
  ): this {
    const resourceUri = uri ?? func.name;
    if (!resourceUri) {
      throw new Error('MCP resource requires a uri (anonymous functions must pass one)');
    }
    this.resourceHandlers.set(resourceUri, {
      fn: func,
      uri: resourceUri,
      name: name ?? func.name,
      description: description ?? ''
    });
    return this;
  }

  /** 注册提示词模板（对应上游 `add_prompt`；名称缺省取函数名）。 */
  public addPrompt(
    func: PromptHandler,
    name: string | undefined = undefined,
    description: string | undefined = undefined
  ): this {
    const promptName = name ?? func.name;
    if (!promptName) {
      throw new Error('MCP prompt requires a name (anonymous functions must pass one)');
    }
    this.promptHandlers.set(promptName, { fn: func, description: description ?? '' });
    return this;
  }

  /**
   * 运行服务器。
   *
   * - `transport: 'memory'`（默认）：返回自身，供内存传输直接调用。
   * - `transport: 'stdio'`：阻塞式 JSON-RPC 2.0 行协议循环，读取 stdin、
   *   写 stdout；解析到 `exit` 请求或流结束时退出。
   * - `transport: 'http' | 'sse'`：不在内置范围，抛错提示通过 host 注入。
   */
  public run(
    transport: 'memory' | 'stdio' | 'http' | 'sse' = 'memory',
    options: Record<string, unknown> = {}
  ): Promise<this> | this {
    void options;
    if (transport === 'memory') return this;
    if (transport === 'stdio') {
      return this.runStdio(process.stdin, process.stdout);
    }
    throw new Error(
      `MCP transport '${transport}' is not built in (DIFF-036): ` +
        'inject an HTTP/SSE transport provider to use it.'
    );
  }

  /** 以 JSON-RPC 2.0 行协议在给定流上处理请求（stdio 参考实现，可注入流做 fixture）。 */
  public async runStdio(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream
  ): Promise<this> {
    const writeLine = (value: unknown): void => {
      output.write(`${JSON.stringify(value)}\n`);
    };
    await new Promise<void>((resolve, reject) => {
      const rl = createInterface({ input, terminal: false });
      rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let request: JsonRpcRequest;
        try {
          request = JSON.parse(trimmed) as JsonRpcRequest;
        } catch {
          writeLine({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error: invalid JSON' }
          });
          return;
        }
        if (request.method === 'exit') {
          rl.close();
          resolve();
          return;
        }
        if (request.id === undefined) {
          // JSON-RPC 2.0 通知（如 notifications/initialized）：无需响应。
          return;
        }
        const response = await this.handleJsonRpc(request);
        writeLine(response);
      });
      rl.on('error', reject);
      rl.on('close', () => resolve());
    });
    return this;
  }

  /** 处理单个 JSON-RPC 2.0 请求（供 stdio 与测试直接调用）。 */
  public async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const base: JsonRpcResponse = { jsonrpc: '2.0', id: request.id };
    const params = request.params ?? {};
    try {
      switch (request.method) {
        case 'initialize':
          return {
            ...base,
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: { name: this.name, description: this.description },
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false },
                prompts: {}
              }
            }
          };
        case 'ping':
          return { ...base, result: {} };
        case 'tools/list':
          return { ...base, result: { tools: await this.listTools() } };
        case 'tools/call': {
          const toolName = String(params.name ?? '');
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          return {
            ...base,
            result: {
              content: [{ type: 'text', text: String(await this.callTool(toolName, args)) }]
            }
          };
        }
        case 'resources/list':
          return { ...base, result: { resources: await this.listResources() } };
        case 'resources/read': {
          const uri = String(params.uri ?? '');
          return {
            ...base,
            result: { contents: [{ uri, text: String(await this.readResource(uri)) }] }
          };
        }
        case 'prompts/list':
          return { ...base, result: { prompts: await this.listPrompts() } };
        case 'prompts/get': {
          const promptName = String(params.name ?? '');
          const promptArgs = (params.arguments ?? {}) as Record<string, string>;
          return { ...base, result: { messages: await this.getPrompt(promptName, promptArgs) } };
        }
        default:
          return {
            ...base,
            error: { code: -32601, message: `Method not found: ${request.method}` }
          };
      }
    } catch (error) {
      return {
        ...base,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  /** 获取服务器信息（对齐上游 `get_info`）。 */
  public getInfo(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      protocol: 'MCP',
      tools_count: this.toolHandlers.size
    };
  }

  // ---- McpServerLike ----

  public async listTools(): Promise<McpToolInfo[]> {
    return [...this.toolHandlers.entries()].map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: { type: 'object', properties: {} }
    }));
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.toolHandlers.get(name);
    if (!tool) {
      throw new Error(`MCP tool not found: ${name}`);
    }
    return tool.fn(args);
  }

  public async listResources(): Promise<McpResourceInfo[]> {
    return [...this.resourceHandlers.values()].map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description
    }));
  }

  public async readResource(uri: string): Promise<unknown> {
    const resource = this.resourceHandlers.get(uri);
    if (!resource) {
      throw new Error(`MCP resource not found: ${uri}`);
    }
    return resource.fn({});
  }

  public async listPrompts(): Promise<McpPromptInfo[]> {
    return [...this.promptHandlers.entries()].map(([name, prompt]) => ({
      name,
      description: prompt.description,
      arguments: []
    }));
  }

  public async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptMessage[]> {
    const prompt = this.promptHandlers.get(name);
    if (!prompt) {
      throw new Error(`MCP prompt not found: ${name}`);
    }
    const rendered = prompt.fn(args);
    return [{ role: 'user', content: String(rendered) }];
  }

  public async ping(): Promise<boolean> {
    return true;
  }
}

/** 便捷的服务器构建器（对齐上游 `MCPServerBuilder`），提供链式 API。 */
export class MCPServerBuilder {
  public readonly server: MCPServer;

  public constructor(name: string, description: string | undefined = undefined) {
    this.server = new MCPServer(name, description);
  }

  public withTool(func: ToolHandler, name?: string, description?: string): this {
    this.server.addTool(func, name, description);
    return this;
  }

  public withResource(
    func: ResourceHandler,
    uri?: string,
    name?: string,
    description?: string
  ): this {
    this.server.addResource(func, uri, name, description);
    return this;
  }

  public withPrompt(func: PromptHandler, name?: string, description?: string): this {
    this.server.addPrompt(func, name, description);
    return this;
  }

  public build(): MCPServer {
    return this.server;
  }

  public async run(transport: 'memory' | 'stdio' | 'http' | 'sse' = 'memory') {
    return this.server.run(transport);
  }
}

/** 创建内置演示服务器（对齐上游 `create_example_server` 的 6 个工具）。 */
export function createExampleServer(): MCPServer {
  const server = new MCPServer('example-server', 'A simple example MCP server');

  server.addTool(
    (args: Record<string, unknown>) => Number(args.a ?? 0) + Number(args.b ?? 0),
    'add',
    'Addition calculator'
  );
  server.addTool(
    (args: Record<string, unknown>) => Number(args.a ?? 0) - Number(args.b ?? 0),
    'subtract',
    'Subtraction calculator'
  );
  server.addTool(
    (args: Record<string, unknown>) => Number(args.a ?? 0) * Number(args.b ?? 0),
    'multiply',
    'Multiplication calculator'
  );
  server.addTool(
    (args: Record<string, unknown>) => {
      const divisor = Number(args.b ?? 0);
      if (divisor === 0) throw new Error('除数不能为零');
      return Number(args.a ?? 0) / divisor;
    },
    'divide',
    'Division calculator'
  );
  server.addTool(
    (args: Record<string, unknown>) =>
      `Hello, ${String(args.name ?? 'World')}! 欢迎使用 HelloAgents MCP 工具！`,
    'greet',
    'Friendly greeting'
  );
  server.addTool(
    () => ({
      platform: process.platform,
      runtime: process.version,
      server_name: 'example-server',
      tools_count: 6
    }),
    'get_system_info',
    'Get system information'
  );

  return server;
}
