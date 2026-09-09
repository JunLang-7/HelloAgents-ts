/**
 * `@junlang-7/helloagents/context` — 教学版上下文子包入口。
 *
 * 对齐上游 `hello_agents/context/__init__.py`：ContextBuilder / ContextConfig /
 * ContextPacket。补充教学工具：TokenCounter（ContextBuilder 兼容契约的注入
 * 通道）、HistoryManager、ObservationTruncator、countTokens。
 * 1.x 的 `context/working-memory.ts` 与教学版 `memory` 工作记忆同名异义
 * （#81），教学入口只暴露 memory 子包的教学实现，不在此导出。
 */
export { TokenCounter } from './token-counter.js';
export type { TokenCounterOptions, TokenCounterStats } from './token-counter.js';
export { HistoryManager } from './history.js';
export type { HistoryManagerOptions } from './history.js';
export { ObservationTruncator } from './truncator.js';
export type {
  ObservationTruncatorOptions,
  TruncationReason,
  TruncationResult
} from './truncator.js';
export { ContextBuilder, ContextConfig, ContextPacket, countTokens } from './builder.js';
export type {
  MemoryToolLike,
  RagToolLike,
  ContextBuilderOptions,
  BuildContextOptions,
  ContextPacketLike
} from './builder.js';
