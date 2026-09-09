/**
 * 协议工具集合（对齐上游 `tools/builtin/protocol_tools.py`）。
 *
 * - MCPTool：连接 MCP 服务器并调用工具/资源/提示词（memory/stdio 参考传输）
 * - A2ATool：连接 A2A Agent 并提问/获取信息（真实 HTTP）
 * - ANPTool：智能体网络管理（服务发现/节点管理/消息路由，概念性实现）
 */
import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';
import { createExampleServer } from '../../protocols/mcp/server.js';
import type { MCPServer } from '../../protocols/mcp/server.js';
import { MCPClient } from '../../protocols/mcp/client.js';
import type { McpToolInfo } from '../../protocols/mcp/types.js';
import { A2AClient } from '../../protocols/a2a/implementation.js';
import { ANPDiscovery, ANPNetwork, ServiceInfo } from '../../protocols/anp/implementation.js';

/** 常见 MCP 服务器所需的环境变量映射（对齐上游 `MCP_SERVER_ENV_MAP`）。 */
export const MCP_SERVER_ENV_MAP: Record<string, string[]> = {
  'server-github': ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  'server-slack': ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  'server-google-drive': ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  'server-postgres': ['POSTGRES_CONNECTION_STRING'],
  'server-sqlite': [],
  'server-filesystem': []
};

const mcpToolInputSchema = z
  .object({
    action: z.string(),
    tool_name: z.string().optional(),
    arguments: z.record(z.string(), z.unknown()).optional(),
    uri: z.string().optional(),
    prompt_name: z.string().optional(),
    prompt_arguments: z.record(z.string(), z.string()).optional()
  })
  .strict();

function extractServerName(serverCommand: string[]): string | undefined {
  for (const part of serverCommand) {
    if (part.includes('server-')) {
      return part.includes('/') ? part.split('/').pop() : part;
    }
  }
  return undefined;
}

/** 准备环境变量（优先级：env > envKeys > 自动检测，对齐上游）。 */
function prepareEnv(
  env: Record<string, string> | undefined,
  envKeys: string[] | undefined,
  serverCommand: string[] | undefined
): NodeJS.ProcessEnv | undefined {
  const result: Record<string, string> = {};
  if (serverCommand) {
    const serverName = extractServerName(serverCommand);
    if (serverName && serverName in MCP_SERVER_ENV_MAP) {
      for (const key of MCP_SERVER_ENV_MAP[serverName] ?? []) {
        const value = process.env[key];
        if (value) result[key] = value;
      }
    }
  }
  if (envKeys) {
    for (const key of envKeys) {
      const value = process.env[key];
      if (value) result[key] = value;
    }
  }
  if (env) {
    Object.assign(result, env);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * MCP 工具：连接 MCP 服务器并调用其工具、资源和提示词。
 *
 * 支持三种来源（对齐上游）：
 * 1. `server`：内存 MCP 服务器实例（内置 memory 传输）
 * 2. `serverCommand`：启动命令（如 `["bun", "server.mjs"]`，stdio 传输）
 * 3. 都不传：创建内置演示服务器（calculator + greet + system_info）
 */
export class MCPTool extends Tool<typeof mcpToolInputSchema> {
  public static readonly inputSchema = mcpToolInputSchema;
  public readonly serverCommand: string[] | undefined;
  public readonly serverArgs: string[];
  public readonly server: ReturnType<typeof createExampleServer> | undefined;
  public readonly autoExpand: boolean;
  public readonly prefix: string;
  public readonly env: NodeJS.ProcessEnv | undefined;
  public readonly envKeys: string[] | undefined;

  private availableTools: McpToolInfo[] | undefined;

  public constructor(
    options: {
      name?: string;
      description?: string;
      serverCommand?: string[];
      serverArgs?: string[];
      server?: MCPServer;
      autoExpand?: boolean;
      env?: Record<string, string>;
      envKeys?: string[];
    } = {}
  ) {
    const {
      name = 'mcp',
      description,
      serverCommand,
      serverArgs,
      server,
      autoExpand = true,
      env,
      envKeys
    } = options;
    const mergedEnv = prepareEnv(env, envKeys, serverCommand);
    const resolvedServer = server ?? (serverCommand ? undefined : createExampleServer());
    super({
      name,
      description:
        description ??
        '连接到 MCP 服务器，调用工具、读取资源和获取提示词。支持内置服务器和外部服务器。',
      inputSchema: mcpToolInputSchema,
      expandable: false
    });
    this.serverCommand = serverCommand;
    this.serverArgs = serverArgs ?? [];
    this.server = resolvedServer;
    this.autoExpand = autoExpand;
    this.prefix = autoExpand ? `${name}_` : '';
    this.env = mergedEnv;
    this.envKeys = envKeys;
  }

  /** 创建（或复用）客户端，按上游 server_source 分类选择传输。 */
  private createClient(): MCPClient {
    if (this.server) return new MCPClient(this.server);
    return new MCPClient(
      this.serverCommand ?? [],
      this.serverArgs,
      this.env ? { env: this.env } : {}
    );
  }

  /** 发现服务器提供的工具（缓存；上游 `_discover_tools`）。 */
  public async discoverTools(): Promise<McpToolInfo[]> {
    if (this.availableTools) return this.availableTools;
    try {
      const client = this.createClient();
      try {
        this.availableTools = await client.listTools();
      } finally {
        await client.close();
      }
    } catch {
      // 发现失败不影响工具可用性（对齐上游：失败则工具列表为空）
      this.availableTools = [];
    }
    return this.availableTools;
  }

  /** 生成增强描述（对齐上游 `_generate_description`）。 */
  private generateDescription(): string {
    if (!this.availableTools || this.availableTools.length === 0) {
      return '连接到 MCP 服务器，调用工具、读取资源和获取提示词。支持内置服务器和外部服务器。';
    }
    if (this.autoExpand) {
      return `MCP工具服务器，包含${this.availableTools.length}个工具。这些工具会自动展开为独立的工具供Agent使用。`;
    }
    const parts = [`MCP工具服务器，提供${this.availableTools.length}个工具：`];
    for (const tool of this.availableTools) {
      const shortDesc = (tool.description ?? '无描述').split('.')[0];
      parts.push(`  • ${tool.name}: ${shortDesc}`);
    }
    parts.push('\n调用格式：返回JSON格式的参数');
    parts.push('{"action": "call_tool", "tool_name": "工具名", "arguments": {...}}');
    return parts.join('\n');
  }

  /** 获取展开的工具列表（需先 `discoverTools()`；对齐上游 `get_expanded_tools`）。 */
  public async getExpandedToolsAsync(): Promise<Tool[]> {
    if (!this.autoExpand) return [];
    const tools = await this.discoverTools();
    const { MCPWrappedTool } = await import('./mcp-wrapper-tool.js');
    return tools.map((toolInfo) => new MCPWrappedTool(this, toolInfo, this.prefix));
  }

  protected async run(input: z.output<typeof mcpToolInputSchema>): Promise<ToolResponse> {
    const action = input.action?.toLowerCase();
    if (!action) {
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：必须指定 action 参数');
    }
    try {
      const client = this.createClient();
      try {
        if (action === 'list_tools') {
          const tools = await client.listTools();
          if (tools.length === 0) return ToolResponse.success('没有找到可用的工具');
          return ToolResponse.success(
            `找到 ${tools.length} 个工具:\n${tools
              .map((tool) => `- ${tool.name}: ${tool.description}`)
              .join('\n')}`
          );
        }
        if (action === 'call_tool') {
          const toolName = input.tool_name;
          if (!toolName) {
            return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：必须指定 tool_name 参数');
          }
          const result = await client.callTool(toolName, input.arguments ?? {});
          const rendered =
            typeof result === 'string'
              ? result
              : typeof result === 'object' && result !== null
                ? JSON.stringify(result)
                : String(result);
          return ToolResponse.success(`工具 '${toolName}' 执行结果:\n${rendered}`);
        }
        if (action === 'list_resources') {
          const resources = await client.listResources();
          if (resources.length === 0) return ToolResponse.success('没有找到可用的资源');
          return ToolResponse.success(
            `找到 ${resources.length} 个资源:\n${resources
              .map((resource) => `- ${resource.uri}: ${resource.name}`)
              .join('\n')}`
          );
        }
        if (action === 'read_resource') {
          const uri = input.uri;
          if (!uri)
            return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：必须指定 uri 参数');
          const content = await client.readResource(uri);
          return ToolResponse.success(`资源 '${uri}' 内容:\n${String(content)}`);
        }
        if (action === 'list_prompts') {
          const prompts = await client.listPrompts();
          if (prompts.length === 0) return ToolResponse.success('没有找到可用的提示词');
          return ToolResponse.success(
            `找到 ${prompts.length} 个提示词:\n${prompts
              .map((prompt) => `- ${prompt.name}: ${prompt.description}`)
              .join('\n')}`
          );
        }
        if (action === 'get_prompt') {
          const promptName = input.prompt_name;
          if (!promptName) {
            return ToolResponse.error(
              ToolErrorCode.INVALID_PARAM,
              '错误：必须指定 prompt_name 参数'
            );
          }
          const messages = await client.getPrompt(promptName, input.prompt_arguments ?? {});
          return ToolResponse.success(
            `提示词 '${promptName}':\n${messages
              .map((message) => `[${message.role}] ${message.content}`)
              .join('\n')}`
          );
        }
        return ToolResponse.error(ToolErrorCode.INVALID_PARAM, `错误：不支持的操作 '${action}'`);
      } finally {
        await client.close();
      }
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.INTERNAL_ERROR,
        `MCP 操作失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

const a2aToolInputSchema = z
  .object({
    action: z.string(),
    question: z.string().optional(),
    skill_name: z.string().optional(),
    text: z.string().optional()
  })
  .strict();

/**
 * A2A 工具：连接 A2A Agent 并进行通信（对齐上游 `A2ATool`）。
 */
export class A2ATool extends Tool<typeof a2aToolInputSchema> {
  public static readonly inputSchema = a2aToolInputSchema;
  public readonly agentUrl: string;

  public constructor(agentUrl: string, name = 'a2a', description?: string) {
    super({
      name,
      description: description ?? '连接到 A2A Agent，支持提问和获取信息。',
      inputSchema: a2aToolInputSchema
    });
    this.agentUrl = agentUrl;
  }

  protected async run(input: z.output<typeof a2aToolInputSchema>): Promise<ToolResponse> {
    const action = input.action?.toLowerCase();
    if (!action) {
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：必须指定 action 参数');
    }
    try {
      const client = new A2AClient(this.agentUrl);
      if (action === 'ask') {
        const question = input.question;
        if (!question) {
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：必须指定 question 参数');
        }
        const answer = await client.ask(question);
        return ToolResponse.success(`Agent 回答:\n${answer}`);
      }
      if (action === 'get_info') {
        const info = await client.getInfo();
        const lines = Object.entries(info).map(([key, value]) => `- ${key}: ${String(value)}`);
        return ToolResponse.success(`Agent 信息:\n${lines.join('\n')}`);
      }
      if (action === 'execute_skill') {
        const skillName = input.skill_name;
        if (!skillName) {
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：必须指定 skill_name 参数');
        }
        const result = await client.executeSkill(skillName, input.text ?? '');
        return ToolResponse.success(`技能 '${skillName}' 执行结果:\n${JSON.stringify(result)}`);
      }
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, `错误：不支持的操作 '${action}'`);
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.INTERNAL_ERROR,
        `A2A 操作失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

const anpToolInputSchema = z
  .object({
    action: z.string(),
    service_id: z.string().optional(),
    service_type: z.string().optional(),
    endpoint: z.string().optional(),
    service_name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    node_id: z.string().optional(),
    from_node: z.string().optional(),
    to_node: z.string().optional(),
    message: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

/**
 * ANP 工具：智能体网络管理（对齐上游 `ANPTool`，概念性实现）。
 */
export class ANPTool extends Tool<typeof anpToolInputSchema> {
  public static readonly inputSchema = anpToolInputSchema;
  public readonly discovery: ANPDiscovery;
  public readonly network: ANPNetwork;

  public constructor(
    name = 'anp',
    description?: string,
    discovery: ANPDiscovery | undefined = undefined,
    network: ANPNetwork | undefined = undefined
  ) {
    super({
      name,
      description:
        description ?? '智能体网络管理工具，支持服务发现、节点管理和消息路由。概念性实现。',
      inputSchema: anpToolInputSchema
    });
    this.discovery = discovery ?? new ANPDiscovery();
    this.network = network ?? new ANPNetwork();
  }

  protected run(input: z.output<typeof anpToolInputSchema>): ToolResponse {
    const action = input.action?.toLowerCase();
    if (!action) {
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：必须指定 action 参数');
    }
    try {
      if (action === 'register_service') {
        const { service_id: serviceId, service_type: serviceType, endpoint } = input;
        if (!serviceId || !serviceType || !endpoint) {
          return ToolResponse.error(
            ToolErrorCode.INVALID_PARAM,
            '错误：必须指定 service_id, service_type 和 endpoint 参数'
          );
        }
        const service = new ServiceInfo(
          serviceId,
          serviceType,
          endpoint,
          input.service_name,
          input.capabilities,
          input.metadata
        );
        this.discovery.registerService(service);
        return ToolResponse.success(`✅ 已注册服务 '${serviceId}'`);
      }
      if (action === 'unregister_service') {
        const serviceId = input.service_id;
        if (!serviceId) {
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：必须指定 service_id 参数');
        }
        return this.discovery.unregisterService(serviceId)
          ? ToolResponse.success(`✅ 已注销服务 '${serviceId}'`)
          : ToolResponse.error(ToolErrorCode.INVALID_PARAM, `错误：服务 '${serviceId}' 不存在`);
      }
      if (action === 'discover_services') {
        const services = this.discovery.discoverServices(input.service_type);
        if (services.length === 0) return ToolResponse.success('没有找到服务');
        const lines = services.flatMap((service) => {
          const lines: string[] = [
            `服务ID: ${service.service_id}`,
            `  名称: ${service.service_name}`,
            `  类型: ${service.service_type}`,
            `  端点: ${service.endpoint}`
          ];
          if (service.capabilities.length > 0) {
            lines.push(`  能力: ${service.capabilities.join(', ')}`);
          }
          if (Object.keys(service.metadata).length > 0) {
            lines.push(`  元数据: ${JSON.stringify(service.metadata)}`);
          }
          return lines;
        });
        return ToolResponse.success(`找到 ${services.length} 个服务:\n\n${lines.join('\n')}`);
      }
      if (action === 'add_node') {
        const { node_id: nodeId, endpoint } = input;
        if (!nodeId || !endpoint) {
          return ToolResponse.error(
            ToolErrorCode.INVALID_PARAM,
            '错误：必须指定 node_id 和 endpoint 参数'
          );
        }
        this.network.addNode(nodeId, endpoint, input.metadata);
        return ToolResponse.success(`✅ 已添加节点 '${nodeId}'`);
      }
      if (action === 'route_message') {
        const { from_node: fromNode, to_node: toNode } = input;
        if (!fromNode || !toNode) {
          return ToolResponse.error(
            ToolErrorCode.INVALID_PARAM,
            '错误：必须指定 from_node 和 to_node 参数'
          );
        }
        const path = this.network.routeMessage(fromNode, toNode, input.message ?? {});
        return path
          ? ToolResponse.success(`消息路由路径: ${path.join(' -> ')}`)
          : ToolResponse.success('无法找到路由路径');
      }
      if (action === 'get_stats') {
        const stats = this.network.getNetworkStats();
        const lines = Object.entries(stats).map(([key, value]) => `- ${key}: ${String(value)}`);
        return ToolResponse.success(`网络统计:\n${lines.join('\n')}`);
      }
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, `错误：不支持的操作 '${action}'`);
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.INTERNAL_ERROR,
        `ANP 操作失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
