/**
 * A2A（Agent-to-Agent Protocol）实现（对齐上游 `protocols/a2a/implementation.py`）。
 *
 * 上游基于 Flask（服务器）+ requests（客户端）。TS 教学端（DIFF-038）改用
 * Node 内置 `node:http`/全局 `fetch`，无第三方依赖：
 * - `A2AServer.run()` 返回可关闭的 `http.Server` 句柄（非阻塞；上游 Flask
 *   `app.run` 是阻塞的）——差异已登记。
 * - HTTP 契约（/info /skills /execute/:skill /ask /health）与上游保持一致，
 *   客户端/服务端可真实互通。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const A2A_AVAILABLE = true;

export type A2ASkill = (text: string) => string;

export interface A2AServerOptions {
  name: string;
  description: string;
  version?: string;
  capabilities?: Record<string, unknown>;
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        request.destroy();
        resolve({});
      }
    });
    request.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve({}));
  });
}

/** A2A 服务器：HTTP 端点 + 技能注册（对应上游 Flask 版）。 */
export class A2AServer {
  public readonly name: string;
  public readonly description: string;
  public readonly version: string;
  public readonly capabilities: Record<string, unknown>;
  public readonly skills: Record<string, A2ASkill> = {};

  public constructor(options: A2AServerOptions);
  public constructor(
    name: string,
    description: string,
    version?: string,
    capabilities?: Record<string, unknown>
  );
  public constructor(
    nameOrOptions: string | A2AServerOptions,
    maybeDescription?: string,
    version = '1.0.0',
    capabilities: Record<string, unknown> | undefined = undefined
  ) {
    const resolved =
      typeof nameOrOptions === 'string'
        ? { name: nameOrOptions, description: maybeDescription ?? '' }
        : nameOrOptions;
    this.name = resolved.name;
    this.description = resolved.description;
    this.version = resolved.version ?? version;
    this.capabilities = resolved.capabilities ?? capabilities ?? {};
  }

  /** 添加技能（对应上游 `add_skill`）。 */
  public addSkill(skillName: string, func: A2ASkill): A2ASkill {
    this.skills[skillName] = func;
    return func;
  }

  /** 装饰器风格添加技能（对应上游 `skill`）。 */
  public skill(skillName: string): (func: A2ASkill) => A2ASkill {
    return (func: A2ASkill): A2ASkill => this.addSkill(skillName, func);
  }

  /**
   * 运行服务器（非阻塞，返回可关闭的 `http.Server`）。
   *
   * 上游 Flask `app.run` 阻塞直至进程退出；TS 端（DIFF-038）返回句柄，
   * 便于测试与程序化生命周期管理。`onReady` 在监听成功后回调。
   */
  public run(
    host = '0.0.0.0',
    port = 5000,
    onReady: ((address: string) => void) | undefined = undefined
  ): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response);
      });
      server.on('error', reject);
      server.listen(port, host, () => {
        const address = server.address() as AddressInfo;
        const base = `http://${host}:${address.port}`;
        onReady?.(base);
        resolve(server);
      });
    });
  }

  /** 处理单个 HTTP 请求（路由表与上游 Flask 端点对齐）。 */
  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      });
      response.end(payload);
    };

    const method = request.method ?? 'GET';
    try {
      // GET /health
      if (method === 'GET' && url.pathname === '/health') {
        send(200, { status: 'healthy', agent: this.name });
        return;
      }
      // GET /info
      if (method === 'GET' && url.pathname === '/info') {
        send(200, this.getInfo());
        return;
      }
      // GET /skills
      if (method === 'GET' && url.pathname === '/skills') {
        send(200, { skills: Object.keys(this.skills) });
        return;
      }
      // POST /execute/:skill
      const executeMatch = url.pathname.match(/^\/execute\/([^/]+)$/);
      if (method === 'POST' && executeMatch && executeMatch[1]) {
        const skillName = decodeURIComponent(executeMatch[1]);
        const skillFunc = this.skills[skillName];
        if (!skillFunc) {
          send(404, {
            error: `Skill '${skillName}' not found`,
            available_skills: Object.keys(this.skills)
          });
          return;
        }
        try {
          const data = await readJsonBody(request);
          const text = String(data.text ?? data.query ?? '');
          const result = skillFunc(text);
          send(200, { skill: skillName, result, status: 'success' });
        } catch (error) {
          send(500, {
            error: error instanceof Error ? error.message : String(error),
            skill: skillName,
            status: 'error'
          });
        }
        return;
      }
      // POST /ask
      if (method === 'POST' && url.pathname === '/ask') {
        const data = await readJsonBody(request);
        const question = String(data.question ?? data.text ?? '');
        for (const [skillName, skillFunc] of Object.entries(this.skills)) {
          try {
            const result = skillFunc(question);
            if (result && !result.startsWith('Error')) {
              send(200, { answer: result, skill_used: skillName, status: 'success' });
              return;
            }
          } catch {
            // 尝试下一个技能
          }
        }
        send(200, { answer: 'No suitable skill found for this question', status: 'no_match' });
        return;
      }
      send(404, { error: `Not found: ${method} ${url.pathname}` });
    } catch (error) {
      send(500, {
        error: error instanceof Error ? error.message : String(error),
        status: 'error'
      });
    }
  }

  /** 获取服务器信息（对齐上游 `get_info`）。 */
  public getInfo(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      version: this.version,
      capabilities: this.capabilities,
      protocol: 'A2A',
      skills: Object.keys(this.skills)
    };
  }
}

/** A2A 客户端（通过真实 HTTP 与 A2AServer 通信，对应上游 requests 实现）。 */
export class A2AClient {
  public readonly serverUrl: string;

  public constructor(serverUrl: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, '');
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
      });
    } catch (error) {
      throw new Error(
        `Error communicating with agent at ${this.serverUrl}${path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    if (!response.ok) {
      throw new Error(`A2A request failed: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  /** 向 Agent 提问（通用接口，对齐上游 `ask`）。 */
  public async ask(question: string): Promise<string> {
    try {
      const response = await this.request('/ask', {
        method: 'POST',
        body: JSON.stringify({ question })
      });
      const data = (await response.json()) as Record<string, unknown>;
      return typeof data.answer === 'string' ? data.answer : 'No response';
    } catch (error) {
      return `Error communicating with agent: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 执行指定技能（对齐上游 `execute_skill`）。 */
  public async executeSkill(skillName: string, text = ''): Promise<Record<string, unknown>> {
    try {
      const response = await this.request(`/execute/${encodeURIComponent(skillName)}`, {
        method: 'POST',
        body: JSON.stringify({ text })
      });
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      return {
        error: `Failed to execute skill: ${error instanceof Error ? error.message : String(error)}`,
        status: 'error'
      };
    }
  }

  /** 获取 Agent 信息（对齐上游 `get_info`）。 */
  public async getInfo(): Promise<Record<string, unknown>> {
    try {
      const response = await this.request('/info');
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      return {
        error: `Failed to get agent info: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /** 列出 Agent 技能（对齐上游 `list_skills`）。 */
  public async listSkills(): Promise<string[]> {
    try {
      const response = await this.request('/skills');
      const data = (await response.json()) as { skills?: string[] };
      return data.skills ?? [];
    } catch {
      return [];
    }
  }
}

/** Agent 网络（概念性实现，对齐上游 `AgentNetwork`）。 */
export class AgentNetwork {
  public readonly name: string;
  private readonly agents: Record<string, string> = {};

  public constructor(name = 'Agent Network') {
    this.name = name;
  }

  /** 添加 Agent 到网络。 */
  public addAgent(agentName: string, agentUrl: string): void {
    this.agents[agentName] = agentUrl;
  }

  /** 获取网络中的 Agent 客户端。 */
  public getAgent(agentName: string): A2AClient {
    const url = this.agents[agentName];
    if (!url) throw new Error(`Agent '${agentName}' not found in network`);
    return new A2AClient(url);
  }

  /** 列出所有 Agent。 */
  public listAgents(): Array<{ name: string; url: string }> {
    return Object.entries(this.agents).map(([name, url]) => ({ name, url }));
  }

  /** 从 URL 列表中发现 Agent（通过 /info 互通确认，对齐上游 `discover_agents`）。 */
  public async discoverAgents(urls: string[]): Promise<number> {
    let discovered = 0;
    for (const url of urls) {
      try {
        const client = new A2AClient(url);
        const info = await client.getInfo();
        if (typeof info.name === 'string' && !('error' in info)) {
          this.addAgent(info.name, url);
          discovered += 1;
        }
      } catch {
        // 跳过不可达的 URL
      }
    }
    return discovered;
  }
}

/** Agent 注册中心（概念性实现，对齐上游 `AgentRegistry`）。 */
export class AgentRegistry {
  public readonly name: string;
  public readonly description: string;
  private readonly registeredAgents: Record<
    string,
    { url: string; metadata: Record<string, unknown>; registered_at: string }
  > = {};

  public constructor(name = 'Agent Registry', description = 'Central agent registry') {
    this.name = name;
    this.description = description;
  }

  /** 注册 Agent。 */
  public registerAgent(
    agentName: string,
    agentUrl: string,
    metadata: Record<string, unknown> | undefined = undefined
  ): void {
    this.registeredAgents[agentName] = {
      url: agentUrl,
      metadata: metadata ?? {},
      registered_at: new Date().toISOString()
    };
  }

  /** 注销 Agent。 */
  public unregisterAgent(agentName: string): void {
    delete this.registeredAgents[agentName];
  }

  /** 列出所有注册的 Agent。 */
  public listAgents(): Array<{
    name: string;
    url: string;
    metadata: Record<string, unknown>;
    registered_at: string;
  }> {
    return Object.entries(this.registeredAgents).map(([name, info]) => ({
      name,
      ...info
    }));
  }

  /** 查找特定 Agent。 */
  public findAgent(
    agentName: string
  ): { url: string; metadata: Record<string, unknown>; registered_at: string } | undefined {
    return this.registeredAgents[agentName];
  }

  /** 获取注册中心信息。 */
  public getInfo(): Record<string, unknown> {
    return {
      name: this.name,
      description: this.description,
      protocol: 'A2A',
      type: 'registry',
      registered_agents: Object.keys(this.registeredAgents).length
    };
  }
}

/** 仅允许安全表达式字符（与上游 calculator 技能一致）。 */
const SAFE_EXPRESSION_CHARS = new Set('0123456789+-*/() .');

function safeEvaluate(expression: string): string {
  if (![...expression].every((char) => SAFE_EXPRESSION_CHARS.has(char))) {
    return 'Error: Invalid characters in expression';
  }
  try {
    // 白名单校验后仅执行算术表达式（无外部副作用面）。
    const result = new Function(`return (${expression})`)();
    return `The result is: ${String(result)}`;
  } catch (error) {
    return `Calculation error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 创建示例 A2A Agent（对齐上游 `create_example_agent`：calculate + greet）。 */
export function createExampleAgent(): A2AServer {
  const server = new A2AServer({
    name: 'Example A2A Agent',
    description: 'A simple example A2A agent',
    version: '1.0.0',
    capabilities: { chat: true, calculation: true }
  });

  server.addSkill('calculate', (text: string) => {
    const match = text.match(/calculate\s+(.+)/i);
    if (match && match[1]) return safeEvaluate(match[1].trim());
    // Error 前缀：让 /ask 的“尝试所有技能”策略能跳过本技能（上游以
    // startswith("Error") 判定失败；上游此处返回非 Error 提示会误选技能，
    // 属于真实缺陷，TS 端修复）。
    return 'Error: Please provide an expression to calculate';
  });

  server.addSkill('greet', (text: string) => {
    if (/hello|hi|greet/i.test(text)) {
      return "Hello! I'm an A2A agent. How can I help you today?";
    }
    return 'Hi there!';
  });

  return server;
}
