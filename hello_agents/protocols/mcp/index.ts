/**
 * MCP 模块桶（对齐上游 `protocols/mcp/__init__.py`）。
 *
 * 上游 `MCPServer` 依赖 fastmcp、`MCPClient` 依赖 mcp 库（缺失时占位抛
 * ImportError）。TS 教学端（DIFF-036）内置两种参考实现（内存/stdio），
 * 因此不设占位；`MCP_SERVER_AVAILABLE`/`MCP_CLIENT_AVAILABLE` 恒为 true。
 */
import { MCPServer, MCPServerBuilder, createExampleServer } from './server.js';
import { MCPClient, MemoryTransport, StdioJsonRpcTransport } from './client.js';
import {
  createContext,
  createErrorResponse,
  createSuccessResponse,
  parseContext
} from './utils.js';
import type {
  McpPromptInfo,
  McpPromptMessage,
  McpResourceInfo,
  McpServerLike,
  McpToolInfo
} from './types.js';

export const MCP_SERVER_AVAILABLE = true;
export const MCP_CLIENT_AVAILABLE = true;
/** 对齐上游根 `protocols/__init__.py` 的 `MCP_AVAILABLE` 标志。 */
export const MCP_AVAILABLE = true;

export {
  MCPServer,
  MCPServerBuilder,
  createExampleServer,
  MCPClient,
  MemoryTransport,
  StdioJsonRpcTransport,
  createContext,
  createErrorResponse,
  createSuccessResponse,
  parseContext
};

export type { McpPromptInfo, McpPromptMessage, McpResourceInfo, McpServerLike, McpToolInfo };
