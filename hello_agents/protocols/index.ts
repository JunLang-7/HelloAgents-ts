/**
 * 智能体通信协议模块（对齐上游 `protocols/__init__.py`）。
 *
 * 三种协议：
 * - MCP（Model Context Protocol）：模型上下文协议（memory/stdio 参考实现）
 * - A2A（Agent-to-Agent Protocol）：智能体间通信协议（真实 HTTP）
 * - ANP（Agent Network Protocol）：智能体网络协议（概念性实现）
 *
 * 上游 MCP 依赖 fastmcp（缺失时占位抛 ImportError）。TS 教学端
 * （DIFF-036）内置两种参考传输，因此 `MCP_AVAILABLE` 恒为 true，
 * 不设占位类。
 */
import { Protocol } from './base.js';

import {
  MCP_AVAILABLE as MCP_CLIENT_FLAG,
  MCPClient,
  MCPServer,
  createContext,
  parseContext
} from './mcp/index.js';

import {
  A2AAgent,
  A2AClient,
  A2AServer,
  AgentNetwork,
  AgentRegistry,
  createMessage,
  parseMessage
} from './a2a/index.js';
import type { A2AMessage, MessageType } from './a2a/index.js';

import {
  ANPDiscovery,
  ANPNetwork,
  ServiceInfo,
  discoverService,
  registerService
} from './anp/index.js';

export const MCP_AVAILABLE = MCP_CLIENT_FLAG;

export {
  // 基础协议
  Protocol,
  // MCP 协议
  MCPClient,
  MCPServer,
  createContext,
  parseContext,
  // A2A 协议
  A2AAgent,
  A2AServer,
  A2AClient,
  AgentNetwork,
  AgentRegistry,
  createMessage,
  parseMessage,
  // ANP 协议
  ANPDiscovery,
  ANPNetwork,
  ServiceInfo,
  registerService,
  discoverService
};

export type { A2AMessage, MessageType };
