import { z, type ZodType } from 'zod';

import { ToolError } from '../core/errors.js';
import { ToolErrorCode } from './errors.js';
import { ToolResponse } from './response.js';
import type { ExpandableTool, FunctionToolOptions, OpenAIToolSchema, Tool } from './tool.js';
import { FunctionTool } from './tool.js';

const awaitableStringSchema = z.object({ input: z.string() }).strict();
type RegisteredTool = Tool | ExpandableTool;
type NormalizedInput = Record<string, unknown>;

function isExpandableTool(tool: RegisteredTool): tool is ExpandableTool {
  return (
    'expandable' in tool && tool.expandable === true && typeof tool.getExpandedTools === 'function'
  );
}
function normalizeInput(input: unknown): NormalizedInput {
  if (input !== null && typeof input === 'object' && !Array.isArray(input))
    return input as NormalizedInput;
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as NormalizedInput;
    } catch {
      /* plain text maps to input */
    }
  }
  return { input };
}

/** Teaching-line registry: only tool and direct-function maps from upstream. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly functions = new Map<string, FunctionTool>();

  public register(tool: RegisteredTool, autoExpand = true): this {
    if (autoExpand && isExpandableTool(tool)) {
      for (const expanded of tool.getExpandedTools() ?? []) this.register(expanded, false);
      return this;
    }
    if (isExpandableTool(tool))
      throw new ToolError(`Expandable tool '${tool.name}' requires autoExpand=true`);
    tool.toOpenAISchema();
    this.tools.set(tool.name, tool);
    return this;
  }
  public registerTool(tool: RegisteredTool, autoExpand = true): this {
    return this.register(tool, autoExpand);
  }
  public register_tool(tool: RegisteredTool, autoExpand = true): this {
    return this.register(tool, autoExpand);
  }

  public registerFunction<TSchema extends ZodType>(
    tool: FunctionTool<TSchema> | FunctionToolOptions<TSchema>
  ): this;
  public registerFunction(
    name: string,
    description: string,
    handler: (input: string) => unknown | Promise<unknown>
  ): this;
  public registerFunction<TSchema extends ZodType>(
    toolOrName: FunctionTool<TSchema> | FunctionToolOptions<TSchema> | string,
    description?: string,
    handler?: (input: string) => unknown | Promise<unknown>
  ): this {
    const wrapped =
      typeof toolOrName === 'string'
        ? new FunctionTool({
            name: toolOrName,
            description: description ?? '',
            inputSchema: awaitableStringSchema,
            handler: ({ input }) => handler?.(input)
          })
        : toolOrName instanceof FunctionTool
          ? toolOrName
          : new FunctionTool(toolOrName);
    this.register(wrapped);
    this.functions.set(wrapped.name, wrapped);
    return this;
  }
  public register_function(
    name: string,
    description: string,
    handler: (input: string) => unknown | Promise<unknown>
  ): this {
    return this.registerFunction(name, description, handler);
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
  public get_tool(name: string): Tool | undefined {
    return this.get(name);
  }
  public getFunction(name: string): FunctionTool | undefined {
    return this.functions.get(name);
  }
  public get_function(name: string): FunctionTool | undefined {
    return this.getFunction(name);
  }

  public async execute(name: string, input: unknown): Promise<ToolResponse> {
    const tool = this.tools.get(name);
    if (!tool)
      return ToolResponse.error(ToolErrorCode.NOT_FOUND, `未找到名为 '${name}' 的工具`, undefined, {
        tool_name: name
      });
    try {
      return await tool.execute(normalizeInput(input));
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.EXECUTION_ERROR,
        `执行工具 '${name}' 时发生异常: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { tool_name: name, input }
      );
    }
  }
  public executeTool(name: string, input: unknown): Promise<ToolResponse> {
    return this.execute(name, input);
  }
  public execute_tool(name: string, input: unknown): Promise<ToolResponse> {
    return this.execute(name, input);
  }
  public list(): string[] {
    return [...this.tools.keys()];
  }
  public listTools(): string[] {
    return this.list();
  }
  public list_tools(): string[] {
    return this.list();
  }
  public getAllTools(): Tool[] {
    return [...this.tools.values()];
  }
  public get_all_tools(): Tool[] {
    return this.getAllTools();
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
  public get_tools_description(): string {
    return this.getToolsDescription();
  }
  public clear(): void {
    this.tools.clear();
    this.functions.clear();
  }
}

export const globalRegistry = new ToolRegistry();
export const global_registry = globalRegistry;
