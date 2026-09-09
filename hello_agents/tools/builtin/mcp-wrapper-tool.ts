/**
 * MCP 工具包装器（对齐上游 `tools/builtin/mcp_wrapper_tool.py`）。
 *
 * 将单个 MCP 工具包装成独立的 HelloAgents Tool，Agent 调用时只需提供
 * 参数，无需了解 MCP 内部结构。由 `MCPTool.getExpandedToolsAsync()` 创建。
 */
import { z } from 'zod';

import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';
import type { MCPTool } from './protocol-tools.js';
import type { McpToolInfo } from '../../protocols/mcp/types.js';

function buildInputSchema(inputSchema: Record<string, unknown> | undefined): z.ZodTypeAny {
  const properties =
    typeof inputSchema?.properties === 'object' && inputSchema.properties !== null
      ? (inputSchema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = Array.isArray(inputSchema?.required) ? (inputSchema.required as string[]) : [];
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [paramName, paramInfo] of Object.entries(properties)) {
    const type = typeof paramInfo?.type === 'string' ? paramInfo.type : 'string';
    const description = typeof paramInfo?.description === 'string' ? paramInfo.description : '';
    let field: z.ZodTypeAny;
    switch (type) {
      case 'number':
        field = z.number();
        break;
      case 'integer':
        field = z.number().int();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'object':
        field = z.record(z.string(), z.unknown());
        break;
      case 'null':
        field = z.null();
        break;
      default:
        field = z.string();
    }
    if (description) field = field.describe(description);
    if (required.includes(paramName)) {
      shape[paramName] = field;
    } else {
      shape[paramName] = field.optional();
    }
  }
  // 无参数 schema 信息（如内存注册表未携带 properties）时不误杀调用参数；
  // 有 properties 时按 JSON Schema 语义严格校验。
  return Object.keys(shape).length > 0 ? z.object(shape).strict() : z.object({}).passthrough();
}

/**
 * MCP 工具包装器：将 MCP 服务器的单个工具展开为独立 Tool。
 */
export class MCPWrappedTool extends Tool<z.ZodTypeAny> {
  public readonly mcpTool: MCPTool;
  public readonly toolInfo: McpToolInfo;
  public readonly mcpToolName: string;

  public constructor(mcpTool: MCPTool, toolInfo: McpToolInfo, prefix = '') {
    const toolName = prefix ? `${prefix}${toolInfo.name}` : toolInfo.name;
    super({
      name: toolName,
      description: toolInfo.description ?? `MCP工具: ${toolInfo.name}`,
      inputSchema: buildInputSchema(toolInfo.inputSchema)
    });
    this.mcpTool = mcpTool;
    this.toolInfo = toolInfo;
    this.mcpToolName = toolInfo.name;
  }

  protected async run(input: z.output<z.ZodTypeAny>): Promise<ToolResponse> {
    try {
      const result = await this.mcpTool.execute({
        action: 'call_tool',
        tool_name: this.mcpToolName,
        arguments: input
      });
      if (result.status === 'success') {
        return ToolResponse.success(result.text);
      }
      return result;
    } catch (error) {
      return ToolResponse.error(
        'INTERNAL_ERROR',
        `MCP 工具执行失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
