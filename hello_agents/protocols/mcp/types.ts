/**
 * MCP 协议公共类型（TS 侧教学参考实现）。
 *
 * 上游通过 fastmcp 暴露工具/资源/提示词。TS 端定义等价的平面契约，
 * 供内存与 stdio 两种内置参考传输共用。
 */

/** MCP 工具信息（与 fastmcp `list_tools` 返回结构对齐）。 */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP 资源信息。 */
export interface McpResourceInfo {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

/** MCP 提示词信息。 */
export interface McpPromptInfo {
  name: string;
  description: string;
  arguments: readonly McpPromptArgument[];
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** 提示词渲染出的消息。 */
export interface McpPromptMessage {
  role: string;
  content: string;
}

/**
 * 内存 MCP 服务器契约（对应上游 FastMCP 实例）。
 *
 * MCPServer 实现该接口；MCPClient 通过 MemoryTransport 直接调用。
 */
export interface McpServerLike {
  readonly name: string;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listResources?(): Promise<McpResourceInfo[]>;
  readResource?(uri: string): Promise<unknown>;
  listPrompts?(): Promise<McpPromptInfo[]>;
  getPrompt?(name: string, args: Record<string, string>): Promise<McpPromptMessage[]>;
  ping?(): Promise<boolean>;
}

/** JSON-RPC 2.0 请求/响应（stdio 参考传输的线协议）。 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}
