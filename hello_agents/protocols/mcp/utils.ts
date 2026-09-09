/**
 * MCP 协议工具函数（对齐上游 `protocols/mcp/utils.py`）。
 *
 * 纯函数、零依赖：上下文创建/解析与统一响应形状。
 */
import type { JsonRpcResponse } from './types.js';

export interface McpContext {
  messages: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  resources: Record<string, unknown>[];
  metadata: Record<string, unknown>;
}

/**
 * 创建 MCP 上下文对象。
 */
export function createContext(
  messages: Record<string, unknown>[] | undefined = [],
  tools: Record<string, unknown>[] | undefined = [],
  resources: Record<string, unknown>[] | undefined = [],
  metadata: Record<string, unknown> | undefined = {}
): McpContext {
  return {
    messages: messages ?? [],
    tools: tools ?? [],
    resources: resources ?? [],
    metadata: metadata ?? {}
  };
}

/**
 * 解析 MCP 上下文（字符串或字典）。
 *
 * @throws {Error} 上下文格式无效时（对应上游 ValueError）。
 */
export function parseContext(context: string | Record<string, unknown>): McpContext {
  let parsed: unknown = context;
  if (typeof context === 'string') {
    try {
      parsed = JSON.parse(context);
    } catch (error) {
      throw new Error(
        `Invalid JSON context: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Context must be a dictionary or JSON string');
  }
  const record = parsed as Record<string, unknown>;
  const result: McpContext = {
    messages: Array.isArray(record.messages) ? (record.messages as Record<string, unknown>[]) : [],
    tools: Array.isArray(record.tools) ? (record.tools as Record<string, unknown>[]) : [],
    resources: Array.isArray(record.resources)
      ? (record.resources as Record<string, unknown>[])
      : [],
    metadata:
      typeof record.metadata === 'object' && record.metadata !== null
        ? (record.metadata as Record<string, unknown>)
        : {}
  };
  return result;
}

/**
 * 创建错误响应（对齐上游 `create_error_response`）。
 */
export function createErrorResponse(
  errorMessage: string,
  errorCode: string | undefined = undefined,
  details: Record<string, unknown> | undefined = undefined
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    error: {
      message: errorMessage,
      code: errorCode ?? 'UNKNOWN_ERROR'
    }
  };
  if (details) {
    (response.error as Record<string, unknown>).details = details;
  }
  return response;
}

/**
 * 创建成功响应（对齐上游 `create_success_response`）。
 */
export function createSuccessResponse(
  data: unknown,
  metadata: Record<string, unknown> | undefined = undefined
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    success: true,
    data
  };
  if (metadata) {
    response.metadata = metadata;
  }
  return response;
}

/** 校验 JSON-RPC 响应形状的辅助函数。 */
export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as JsonRpcResponse).jsonrpc === '2.0' &&
    'id' in value
  );
}
