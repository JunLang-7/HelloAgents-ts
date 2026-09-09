/**
 * MCP 客户端（对齐上游 `protocols/mcp/client.py`）。
 *
 * 上游基于 fastmcp 的 `Client`，支持 6 种 server_source：
 * FastMCP 实例（memory）、配置字典、http(s) URL（http/sse）、.py 路径
 * （PythonStdio）、命令列表（Stdio）、其他（自动推断）。
 *
 * TS 端（DIFF-036）通过 transport port 实现同等的 source 分类：
 * - `McpServerLike` 实例 → 内置 `MemoryTransport`
 * - 脚本路径（.mjs/.js/.ts）或命令列表 → 内置 `StdioJsonRpcTransport`
 *   （真实子进程 + JSON-RPC 2.0 行协议）
 * - http(s) URL 或 `{ transport: 'http'|'sse', url }` → 声明 `HttpTransport`/
 *   `SseTransport` 契约；未注入实现时 `connect()` 明确报错（不冒充真实传输）
 *
 * 客户端采用 lazy connect：首次调用任意方法时自动建立连接，
 * `close()` 负责清理（对齐上游 async context manager 语义）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import { isJsonRpcResponse } from './utils.js';

/** 传输契约：MCPClient 与具体传输之间的边界。 */
export interface MCPTransport {
  readonly kind: string;
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listResources?(): Promise<McpResourceInfo[]>;
  readResource?(uri: string): Promise<unknown>;
  listPrompts?(): Promise<McpPromptInfo[]>;
  getPrompt?(name: string, args: Record<string, string>): Promise<McpPromptMessage[]>;
  ping?(): Promise<boolean>;
}

/** 内存传输：直接调用内存 MCP 服务器（对应上游 FastMCP 实例的 memory 传输）。 */
export class MemoryTransport implements MCPTransport {
  public readonly kind = 'memory';
  private readonly server: McpServerLike;

  public constructor(server: McpServerLike) {
    this.server = server;
  }

  public async connect(): Promise<void> {}
  public async close(): Promise<void> {}

  public async listTools(): Promise<McpToolInfo[]> {
    return this.server.listTools();
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.server.callTool(name, args);
  }

  public async listResources(): Promise<McpResourceInfo[]> {
    if (!this.server.listResources) return [];
    return this.server.listResources();
  }

  public async readResource(uri: string): Promise<unknown> {
    if (!this.server.readResource) throw new Error(`MCP resource not found: ${uri}`);
    return this.server.readResource(uri);
  }

  public async listPrompts(): Promise<McpPromptInfo[]> {
    if (!this.server.listPrompts) return [];
    return this.server.listPrompts();
  }

  public async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptMessage[]> {
    if (!this.server.getPrompt) throw new Error(`MCP prompt not found: ${name}`);
    return this.server.getPrompt(name, args);
  }

  public async ping(): Promise<boolean> {
    return this.server.ping ? this.server.ping() : true;
  }
}

/** HTTP（Streamable）传输契约：教学端不内置，需注入实现。 */
export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

/** SSE 传输契约：教学端不内置，需注入实现。 */
export interface SseTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

/** 未配置的 HTTP/SSE 传输占位（DIFF-036：注入实现后替换）。 */
class UnconfiguredHttpTransport implements MCPTransport {
  public readonly kind: 'http' | 'sse';
  private readonly url: string;
  private readonly method: string;

  public constructor(kind: 'http' | 'sse', url: string) {
    this.kind = kind;
    this.url = url;
    this.method = kind === 'http' ? 'HTTP' : 'SSE';
  }

  public async connect(): Promise<void> {
    throw new Error(
      `MCP ${this.method} transport is not built in (DIFF-036): ` +
        `inject an ${this.method} transport provider for ${this.url}.`
    );
  }

  public async close(): Promise<void> {}
  public async listTools(): Promise<McpToolInfo[]> {
    throw new Error(`${this.method} transport not configured (DIFF-036)`);
  }
  public async callTool(): Promise<unknown> {
    throw new Error(`${this.method} transport not configured (DIFF-036)`);
  }
}

/** stdio 传输：真实子进程 + JSON-RPC 2.0 行协议（本地 fixture 可验证）。 */
export class StdioJsonRpcTransport implements MCPTransport {
  public readonly kind = 'stdio';
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number | string, (response: JsonRpcResponse) => void>();
  private nextId = 1;
  private closed = false;

  public constructor(command: string[], env?: NodeJS.ProcessEnv) {
    if (command.length === 0) throw new Error('Stdio transport requires a command');
    const head = command[0];
    if (!head) throw new Error('Stdio transport requires a command');
    this.command = head;
    this.args = command.slice(1);
    this.env = env;
  }

  public async connect(): Promise<void> {
    if (this.child && !this.closed) return;
    this.closed = false;
    const child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env
    });
    this.child = child;
    // 消费 stderr，避免子进程日志造成背压（测试时保持静默）。
    child.stderr.on('data', () => {});
    const rl = createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let response: unknown;
      try {
        response = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!isJsonRpcResponse(response)) return;
      const resolve = this.pending.get(response.id);
      if (resolve) {
        this.pending.delete(response.id);
        resolve(response);
      }
    });
    child.on('error', (error) => {
      for (const resolve of this.pending.values()) {
        resolve({
          jsonrpc: '2.0',
          id: -1,
          error: { code: -32000, message: `Child process error: ${error.message}` }
        });
      }
      this.pending.clear();
    });
    child.on('exit', (code) => {
      for (const resolve of this.pending.values()) {
        resolve({
          jsonrpc: '2.0',
          id: -1,
          error: { code: -32000, message: `Child process exited with code ${code}` }
        });
      }
      this.pending.clear();
    });
    // 握手：等待 initialize 完成（客户端协议版本协商）。
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'helloagents-ts', version: '0.2.0' }
    });
    // MCP 生命周期规范：初始化成功后必须发送 notifications/initialized。
    this.sendNotification('notifications/initialized');
  }

  public async close(): Promise<void> {
    if (!this.child || this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    // MCP 生命周期规范：stdio 先关闭输入流（服务器收到 EOF 自然退出），
    // 等待进程退出，超时（2s）后才按需终止进程。
    child.stdin.end();
    const exited = new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const onExit = (): void => {
        child.off('exit', onExit);
        resolve(true);
      };
      child.on('exit', onExit);
    });
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  /** 发送 JSON-RPC 2.0 通知（无 id、无需响应）。 */
  private sendNotification(method: string, params: Record<string, unknown> = {}): void {
    const child = this.child;
    if (!child || this.closed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const child = this.child;
    if (!child || this.closed) {
      throw new Error('MCP stdio transport is not connected');
    }
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private async invoke<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await this.request(method, params);
    if (response.error) {
      throw new Error(`MCP ${method} failed: ${response.error.message}`);
    }
    return response.result as T;
  }

  public async listTools(): Promise<McpToolInfo[]> {
    const result = await this.invoke<{ tools: McpToolInfo[] }>('tools/list', {});
    return result.tools;
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.invoke<{ content: { type: string; text: string }[] }>('tools/call', {
      name,
      arguments: args
    });
    return result.content?.map((part) => part.text).join('') ?? '';
  }

  public async listResources(): Promise<McpResourceInfo[]> {
    const result = await this.invoke<{ resources: McpResourceInfo[] }>('resources/list', {});
    return result.resources;
  }

  public async readResource(uri: string): Promise<unknown> {
    const result = await this.invoke<{ contents: { uri: string; text: string }[] }>(
      'resources/read',
      { uri }
    );
    return result.contents?.map((part) => part.text).join('') ?? '';
  }

  public async listPrompts(): Promise<McpPromptInfo[]> {
    const result = await this.invoke<{ prompts: McpPromptInfo[] }>('prompts/list', {});
    return result.prompts;
  }

  public async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptMessage[]> {
    const result = await this.invoke<{ messages: McpPromptMessage[] }>('prompts/get', {
      name,
      arguments: args
    });
    return result.messages;
  }

  public async ping(): Promise<boolean> {
    await this.invoke('ping', {});
    return true;
  }
}

export interface MCPClientOptions {
  /** stdio 子进程环境变量（MCPTool 环境变量合并）。 */
  env?: NodeJS.ProcessEnv;
  /** 注入自定义传输（覆盖 source 推断）。 */
  transport?: MCPTransport;
}

/**
 * 服务器来源：内存服务器实例、脚本路径、命令列表、URL 或配置对象。
 */
export type MCPServerSource =
  | McpServerLike
  | string
  | string[]
  | { transport: 'http' | 'sse'; url: string; headers?: Record<string, string> };

function isConfiguredObject(
  source:
    McpServerLike | { transport: 'http' | 'sse'; url: string; headers?: Record<string, string> }
): source is { transport: 'http' | 'sse'; url: string; headers?: Record<string, string> } {
  return 'transport' in source && 'url' in source;
}

export class MCPClient {
  private readonly source: MCPServerSource;
  private readonly args: string[];
  private readonly options: MCPClientOptions;
  private transport: MCPTransport | undefined;

  public constructor(source: MCPServerSource, args: string[] = [], options: MCPClientOptions = {}) {
    this.source = source;
    this.args = args;
    this.options = options;
  }

  /** 创建（或复用）传输实例（对应上游 server_source 分类逻辑）。 */
  private buildTransport(): MCPTransport {
    if (this.options.transport) return this.options.transport;
    const source = this.source;

    if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
      // 配置对象（{transport:'http'|'sse', url}）→ 声明占位传输；
      // 其余对象（如 MCPServer）→ memory 传输
      if (isConfiguredObject(source)) {
        return new UnconfiguredHttpTransport(source.transport, source.url);
      }
      return new MemoryTransport(source);
    }

    if (Array.isArray(source)) {
      return new StdioJsonRpcTransport(source, this.options.env);
    }

    // 字符串：URL 或脚本路径
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return new UnconfiguredHttpTransport('http', source);
    }
    if (/\.(py)$/i.test(source)) {
      // 上游 PythonStdio：TS 教学端明确报错（DIFF-036：Python 服务需通过命令列表或脚本路径接入）
      throw new Error(
        'Python MCP server paths are not supported directly (DIFF-036): ' +
          'pass a command list such as ["python", "<script.py>"] to launch it via stdio.'
      );
    }
    // 脚本路径（.mjs/.js/.ts）→ 用当前运行时以 stdio 启动
    return new StdioJsonRpcTransport([process.execPath, source, ...this.args], this.options.env);
  }

  /** 显式建立连接（lazy connect 之外也可手动调用）。 */
  public async connect(): Promise<void> {
    if (this.transport) return;
    const transport = this.buildTransport();
    await transport.connect();
    this.transport = transport;
  }

  /** 关闭连接并清理子进程。 */
  public async close(): Promise<void> {
    if (!this.transport) return;
    const transport = this.transport;
    this.transport = undefined;
    await transport.close();
  }

  private async withTransport<T>(operation: (t: MCPTransport) => Promise<T>): Promise<T> {
    await this.connect();
    const transport = this.transport as MCPTransport;
    return operation(transport);
  }

  public async listTools(): Promise<McpToolInfo[]> {
    return this.withTransport((t) => t.listTools());
  }

  public async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.withTransport((t) => t.callTool(name, args));
  }

  public async listResources(): Promise<McpResourceInfo[]> {
    return this.withTransport(async (t) => (t.listResources ? t.listResources() : []));
  }

  public async readResource(uri: string): Promise<unknown> {
    return this.withTransport(async (t) => {
      if (!t.readResource) throw new Error(`MCP resource not found: ${uri}`);
      return t.readResource(uri);
    });
  }

  public async listPrompts(): Promise<McpPromptInfo[]> {
    return this.withTransport(async (t) => (t.listPrompts ? t.listPrompts() : []));
  }

  public async getPrompt(
    name: string,
    args: Record<string, string> = {}
  ): Promise<McpPromptMessage[]> {
    return this.withTransport(async (t) => {
      if (!t.getPrompt) throw new Error(`MCP prompt not found: ${name}`);
      return t.getPrompt(name, args);
    });
  }

  public async ping(): Promise<boolean> {
    return this.withTransport(async (t) => (t.ping ? t.ping() : true));
  }

  /** 获取传输信息（对齐上游 `get_transport_info`）。 */
  public getTransportInfo(): Record<string, unknown> {
    return {
      transport: this.transport?.kind ?? 'not-connected',
      source:
        typeof this.source === 'string'
          ? this.source
          : Array.isArray(this.source)
            ? this.source.join(' ')
            : this.source && typeof this.source === 'object' && 'name' in this.source
              ? (this.source as McpServerLike).name
              : JSON.stringify(this.source)
    };
  }
}
