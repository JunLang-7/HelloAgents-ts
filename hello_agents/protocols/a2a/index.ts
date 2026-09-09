/**
 * A2A 模块桶（对齐上游 `protocols/a2a/__init__.py`）。
 *
 * 别名政策（与上游一致，DIFF-038）：
 * - `A2AAgent` = `A2AServer`（运行时同一类）
 * - `A2AMessage` = `Record<string, unknown>`（上游 `dict`）
 * - `MessageType` = `string`（上游 `str`）
 * - `createMessage`/`parseMessage` 保持上游占位行为：a2a-sdk 提供的消息
 *   助手不在教学端内置，调用即抛错（对应上游占位函数抛 ImportError）。
 */
import {
  A2A_AVAILABLE,
  A2AClient,
  A2AServer,
  AgentNetwork,
  AgentRegistry,
  createExampleAgent
} from './implementation.js';

export const A2AAgent = A2AServer;
export type A2AAgent = A2AServer;
export type A2AMessage = Record<string, unknown>;
export type MessageType = string;

/** 占位：a2a-sdk 消息助手不内置（保持上游行为，DIFF-038）。 */
export function createMessage(content: string, metadata?: Record<string, unknown>): never {
  void content;
  void metadata;
  throw new Error(
    'createMessage requires the official a2a-sdk message helpers (DIFF-038): ' +
      'not built into the TypeScript teaching implementation.'
  );
}

/** 占位：a2a-sdk 消息助手不内置（保持上游行为，DIFF-038）。 */
export function parseMessage(message: unknown): never {
  void message;
  throw new Error(
    'parseMessage requires the official a2a-sdk message helpers (DIFF-038): ' +
      'not built into the TypeScript teaching implementation.'
  );
}

export { A2A_AVAILABLE, A2AClient, A2AServer, AgentNetwork, AgentRegistry, createExampleAgent };
