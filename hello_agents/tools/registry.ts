import type { ZodType } from 'zod';

import { ToolError } from '../core/errors.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ToolErrorCode } from './errors.js';
import { ToolResponse } from './response.js';
import type { ExpandableTool, FunctionToolOptions, OpenAIToolSchema, Tool } from './tool.js';
import { FunctionTool } from './tool.js';

type RegisteredTool = Tool | ExpandableTool;

export interface ToolRegistryOptions {
  /** 共享熔断器，用于临时禁用反复失败的工具。 */
  readonly circuitBreaker?: CircuitBreaker;
}

function isExpandableTool(tool: RegisteredTool): tool is ExpandableTool {
  return 'expandable' in tool && tool.expandable;
}

function normalizeInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input);
  } catch {
    return { input };
  }
}

/** HelloAgents 工具注册表，提供工具注册、管理和执行能力。 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly functions = new Map<string, FunctionTool>();
  public readonly readMetadataCache = new Map<string, Record<string, unknown>>();
  public readonly circuitBreaker: CircuitBreaker;

  public constructor(options: ToolRegistryOptions = {}) {
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker();
  }

  /**
   * 注册 Tool 对象；默认自动展开可展开工具，同名工具会被覆盖。
   *
   * @param tool 要注册的 Tool 对象或可展开工具组。
   * @param autoExpand 是否自动展开可展开工具，默认为 true。
   * @returns 当前注册表，便于链式调用。
   */
  public register(tool: RegisteredTool, autoExpand = true): this {
    if (autoExpand && isExpandableTool(tool)) {
      for (const expanded of tool.getExpandedTools()) this.register(expanded, false);
      return this;
    }
    if (isExpandableTool(tool)) {
      throw new ToolError(`Expandable tool '${tool.name}' requires autoExpand=true`);
    }
    tool.toOpenAISchema();
    this.tools.set(tool.name, tool);
    return this;
  }

  /** `register` 的兼容别名。 */
  public registerTool(tool: RegisteredTool, autoExpand = true): this {
    return this.register(tool, autoExpand);
  }

  /**
   * 将函数包装为标准工具协议并注册。
   *
   * @param tool FunctionTool 实例或函数工具配置。
   * @returns 当前注册表。
   */
  public registerFunction<TSchema extends ZodType>(
    tool: FunctionTool<TSchema> | FunctionToolOptions<TSchema>
  ): this {
    const wrapped = tool instanceof FunctionTool ? tool : new FunctionTool(tool);
    this.register(wrapped);
    this.functions.set(wrapped.name, wrapped);
    return this;
  }

  /**
   * 注销指定名称的工具。
   *
   * @param name 工具名称。
   * @returns 是否存在该注册。
   */
  public unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    this.functions.delete(name);
    return existed;
  }

  /** 按模型侧工具名称获取 Tool 对象。 */
  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** `get` 的兼容别名。 */
  public getTool(name: string): Tool | undefined {
    return this.get(name);
  }

  /** 按名称获取已注册的函数工具。 */
  public getFunction(name: string): FunctionTool | undefined {
    return this.functions.get(name);
  }

  /**
   * 执行工具，并将工具不存在、异常和熔断状态转换为 ToolResponse。
   *
   * @param name 工具名称。
   * @param input 工具输入，可以是对象或 JSON 字符串。
   * @returns 标准化的工具响应对象。
   */
  public async execute(name: string, input: unknown): Promise<ToolResponse> {
    if (!this.circuitBreaker.canExecute(name)) {
      const status = this.circuitBreaker.getStatus(name);
      return ToolResponse.error(
        ToolErrorCode.CIRCUIT_OPEN,
        `工具 '${name}' 当前被禁用，由于连续失败。${status.recover_in_seconds ?? 0} 秒后可用。`,
        undefined,
        { tool_name: name, circuit_status: status }
      );
    }

    const tool = this.tools.get(name);
    let response: ToolResponse;
    if (!tool) {
      response = ToolResponse.error(
        ToolErrorCode.NOT_FOUND,
        `未找到名为 '${name}' 的工具`,
        undefined,
        {
          tool_name: name
        }
      );
    } else {
      try {
        response = await tool.execute(normalizeInput(input));
      } catch (error) {
        response = ToolResponse.error(
          ToolErrorCode.EXECUTION_ERROR,
          `执行工具 '${name}' 时发生异常: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { tool_name: name, input }
        );
      }
    }
    this.circuitBreaker.recordResult(name, response);
    return response;
  }

  /** `execute` 的兼容别名。 */
  public executeTool(name: string, input: unknown): Promise<ToolResponse> {
    return this.execute(name, input);
  }

  /** 按注册顺序列出所有工具名称。 */
  public list(): string[] {
    return [...this.tools.keys()];
  }

  /** `list` 的兼容别名。 */
  public listTools(): string[] {
    return this.list();
  }

  /** 返回具体 Tool 对象，用于构建模式或检查。 */
  public getAllTools(): Tool[] {
    return [...this.tools.values()];
  }

  /** 将所有已注册工具转换为 OpenAI Function Calling 模式。 */
  public toOpenAISchemas(): OpenAIToolSchema[] {
    return this.getAllTools().map((tool) => tool.toOpenAISchema());
  }

  /** 格式化面向模型的工具描述列表。 */
  public getToolsDescription(): string {
    return (
      this.getAllTools()
        .map((tool) => `- ${tool.name}: ${tool.description}`)
        .join('\n') || '暂无可用工具'
    );
  }

  /** 清除工具和函数注册，但保留文件读取元数据缓存。 */
  public clear(): void {
    this.tools.clear();
    this.functions.clear();
  }

  /** 缓存文件元数据，用于会话持久化。 */
  public cacheReadMetadata(path: string, metadata: Record<string, unknown>): void {
    this.readMetadataCache.set(path, metadata);
  }

  /** 获取指定文件路径的缓存元数据。 */
  public getReadMetadata(path: string): Record<string, unknown> | undefined {
    return this.readMetadataCache.get(path);
  }

  /** 清除一个路径或全部路径的缓存元数据。 */
  public clearReadCache(path?: string): void {
    if (path === undefined) this.readMetadataCache.clear();
    else this.readMetadataCache.delete(path);
  }
}

/** 进程级默认注册表，适用于不需要隔离工具集合的应用。 */
export const globalRegistry = new ToolRegistry();
