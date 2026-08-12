import type { ZodType } from 'zod';

import { ToolErrorCode } from './errors.js';
import { ToolError } from '../core/errors.js';
import { ToolResponse } from './response.js';
import type { ExpandableTool, FunctionToolOptions, OpenAIToolSchema, Tool } from './tool.js';
import { FunctionTool } from './tool.js';

type RegisteredTool = Tool | ExpandableTool;

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

  public registerTool(tool: RegisteredTool, autoExpand = true): this {
    return this.register(tool, autoExpand);
  }

  public registerFunction<TSchema extends ZodType>(
    tool: FunctionTool<TSchema> | FunctionToolOptions<TSchema>
  ): this {
    const wrapped = tool instanceof FunctionTool ? tool : new FunctionTool(tool);
    this.register(wrapped);
    this.functions.set(wrapped.name, wrapped);
    return this;
  }

  public unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    this.functions.delete(name);
    return existed;
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public getTool(name: string): Tool | undefined {
    return this.get(name);
  }

  public getFunction(name: string): FunctionTool | undefined {
    return this.functions.get(name);
  }

  public async execute(name: string, input: unknown): Promise<ToolResponse> {
    const tool = this.tools.get(name);
    if (!tool) {
      return ToolResponse.error(ToolErrorCode.NOT_FOUND, `未找到名为 '${name}' 的工具`, undefined, {
        tool_name: name
      });
    }
    return tool.execute(normalizeInput(input));
  }

  public executeTool(name: string, input: unknown): Promise<ToolResponse> {
    return this.execute(name, input);
  }

  public list(): string[] {
    return [...this.tools.keys()];
  }

  public listTools(): string[] {
    return this.list();
  }

  public getAllTools(): Tool[] {
    return [...this.tools.values()];
  }

  public toOpenAISchemas(): OpenAIToolSchema[] {
    return this.getAllTools().map((tool) => tool.toOpenAISchema());
  }

  public getToolsDescription(): string {
    return (
      this.getAllTools()
        .map((tool) => `- ${tool.name}: ${tool.description}`)
        .join('\n') || '暂无可用工具'
    );
  }

  public clear(): void {
    this.tools.clear();
    this.functions.clear();
  }

  public cacheReadMetadata(path: string, metadata: Record<string, unknown>): void {
    this.readMetadataCache.set(path, metadata);
  }

  public getReadMetadata(path: string): Record<string, unknown> | undefined {
    return this.readMetadataCache.get(path);
  }

  public clearReadCache(path?: string): void {
    if (path === undefined) this.readMetadataCache.clear();
    else this.readMetadataCache.delete(path);
  }
}

export const globalRegistry = new ToolRegistry();
