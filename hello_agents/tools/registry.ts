import type { ZodType } from 'zod';

import { ToolError } from '../core/errors.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { ToolErrorCode } from './errors.js';
import { ToolResponse } from './response.js';
import type { ExpandableTool, FunctionToolOptions, OpenAIToolSchema, Tool } from './tool.js';
import { FunctionTool } from './tool.js';

type RegisteredTool = Tool | ExpandableTool;

export interface ToolRegistryOptions {
  /** Shared breaker used to temporarily disable repeatedly failing tools. */
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

/** Registry for protocol tools and directly-wrapped functions. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly functions = new Map<string, FunctionTool>();
  public readonly readMetadataCache = new Map<string, Record<string, unknown>>();
  public readonly circuitBreaker: CircuitBreaker;

  public constructor(options: ToolRegistryOptions = {}) {
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker();
  }

  /** Registers a concrete tool, expanding tool groups by default. Replaces same-named tools. */
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

  /** Compatibility alias for `register`. */
  public registerTool(tool: RegisteredTool, autoExpand = true): this {
    return this.register(tool, autoExpand);
  }

  /** Registers a handler wrapped in the standard tool protocol. */
  public registerFunction<TSchema extends ZodType>(
    tool: FunctionTool<TSchema> | FunctionToolOptions<TSchema>
  ): this {
    const wrapped = tool instanceof FunctionTool ? tool : new FunctionTool(tool);
    this.register(wrapped);
    this.functions.set(wrapped.name, wrapped);
    return this;
  }

  /** Removes a tool and returns whether a matching registration existed. */
  public unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    this.functions.delete(name);
    return existed;
  }

  /** Finds a registered tool by its model-facing name. */
  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Compatibility alias for `get`. */
  public getTool(name: string): Tool | undefined {
    return this.get(name);
  }

  /** Finds a registered function wrapper by name. */
  public getFunction(name: string): FunctionTool | undefined {
    return this.functions.get(name);
  }

  /** Executes a tool and converts missing tools, exceptions, and open circuits to responses. */
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

  /** Compatibility alias for `execute`. */
  public executeTool(name: string, input: unknown): Promise<ToolResponse> {
    return this.execute(name, input);
  }

  /** Lists registered tool names in registration order. */
  public list(): string[] {
    return [...this.tools.keys()];
  }

  /** Compatibility alias for `list`. */
  public listTools(): string[] {
    return this.list();
  }

  /** Returns concrete tools for schema construction or inspection. */
  public getAllTools(): Tool[] {
    return [...this.tools.values()];
  }

  /** Converts all registered tools to OpenAI function-calling schemas. */
  public toOpenAISchemas(): OpenAIToolSchema[] {
    return this.getAllTools().map((tool) => tool.toOpenAISchema());
  }

  /** Formats a concise model-facing list of registered tool descriptions. */
  public getToolsDescription(): string {
    return (
      this.getAllTools()
        .map((tool) => `- ${tool.name}: ${tool.description}`)
        .join('\n') || '暂无可用工具'
    );
  }

  /** Removes tool and function registrations without clearing read metadata. */
  public clear(): void {
    this.tools.clear();
    this.functions.clear();
  }

  /** Caches file metadata for session persistence. */
  public cacheReadMetadata(path: string, metadata: Record<string, unknown>): void {
    this.readMetadataCache.set(path, metadata);
  }

  /** Retrieves metadata cached for a file path. */
  public getReadMetadata(path: string): Record<string, unknown> | undefined {
    return this.readMetadataCache.get(path);
  }

  /** Clears cached metadata for one path or the entire cache. */
  public clearReadCache(path?: string): void {
    if (path === undefined) this.readMetadataCache.clear();
    else this.readMetadataCache.delete(path);
  }
}

/** Process-wide default registry for applications that do not need isolated tool sets. */
export const globalRegistry = new ToolRegistry();
