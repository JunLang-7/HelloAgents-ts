import type { Message } from '../core/message.js';
import { TokenCounter } from './token-counter.js';

export interface ContextPacket {
  /** 提供给上下文构建器的文本内容。 */
  readonly content: string;
  /** 可选的分类和来源元数据。 */
  readonly metadata?: Record<string, unknown>;
  /** 可选的来源时间戳，供调用方自行排序。 */
  readonly timestamp?: number;
  /** 可选的预计算 token 数。 */
  readonly tokenCount?: number;
  /** 可选的相关性分数，用于和 `minRelevance` 比较。 */
  readonly relevanceScore?: number;
}
export interface ContextBuilderOptions {
  /** 为响应预留 token 后的最大上下文预算。 */
  readonly maxTokens?: number;
  /** 为模型响应预留的预算比例。 */
  readonly reserveRatio?: number;
  /** 非指令数据包的最低词法相关性。 */
  readonly minRelevance?: number;
  /** 超出预算时是否压缩到可用预算。 */
  readonly enableCompression?: boolean;
  /** 用于执行预算限制的 token 计数器。 */
  readonly tokenCounter?: TokenCounter;
}
export interface BuildContextOptions {
  /** 当前用户请求，始终包含在任务部分。 */
  readonly userQuery: string;
  /** 用于构建上下文部分的最近消息。 */
  readonly conversationHistory?: readonly Message[];
  /** 高优先级指令，存在时始终包含。 */
  readonly systemInstructions?: string;
  /** 检索事实、任务状态和其他上下文数据包。 */
  readonly additionalPackets?: readonly ContextPacket[];
}

/** Python V1 ContextBuilder 的 Gather-Select-Structure-Compress 流程。 */
export class ContextBuilder {
  public readonly tokenCounter: TokenCounter;
  private readonly maxTokens: number;
  private readonly reserveRatio: number;
  private readonly minRelevance: number;
  private readonly enableCompression: boolean;
  public constructor(options: ContextBuilderOptions = {}) {
    this.maxTokens = options.maxTokens ?? 8_000;
    this.reserveRatio = options.reserveRatio ?? 0.15;
    this.minRelevance = options.minRelevance ?? 0.3;
    this.enableCompression = options.enableCompression ?? true;
    this.tokenCounter = options.tokenCounter ?? new TokenCounter();
  }
  /** 收集、筛选、组织并限制上下文，生成可直接用于提示词的字符串。 */
  public build(options: BuildContextOptions): string {
    const packets: ContextPacket[] = [
      ...(options.systemInstructions
        ? [{ content: options.systemInstructions, metadata: { type: 'instructions' } }]
        : []),
      ...(options.conversationHistory?.length
        ? [
            {
              content: options.conversationHistory
                .slice(-10)
                .map((message) => message.toText())
                .join('\n'),
              metadata: { type: 'history' }
            }
          ]
        : []),
      ...(options.additionalPackets ?? [])
    ];
    const query = new Set(options.userQuery.toLowerCase().split(/\s+/).filter(Boolean));
    const selected = packets.filter((packet) => {
      const type = packet.metadata?.type;
      if (type === 'instructions') return true;
      const words = new Set(packet.content.toLowerCase().split(/\s+/));
      const score =
        packet.relevanceScore ??
        (query.size === 0 ? 0 : [...query].filter((word) => words.has(word)).length / query.size);
      return score >= this.minRelevance;
    });
    const byType = (type: string | readonly string[]) =>
      selected.filter((packet) => {
        const value = packet.metadata?.type;
        return Array.isArray(type) ? type.includes(String(value)) : value === type;
      });
    const sections = [
      ...byType('instructions').map((packet) => `[Role & Policies]\n${packet.content}`),
      `[Task]\n用户问题：${options.userQuery}`,
      ...(byType(['task_state']).length
        ? [
            `[State]\n关键进展与未决问题：\n${byType('task_state')
              .map((packet) => packet.content)
              .join('\n')}`
          ]
        : []),
      ...(byType(['related_memory', 'knowledge_base', 'retrieval', 'tool_result']).length
        ? [
            `[Evidence]\n事实与引用：\n${byType([
              'related_memory',
              'knowledge_base',
              'retrieval',
              'tool_result'
            ])
              .map((packet) => packet.content)
              .join('\n')}`
          ]
        : []),
      ...(byType('history').length
        ? [
            `[Context]\n对话历史与背景：\n${byType('history')
              .map((packet) => packet.content)
              .join('\n')}`
          ]
        : []),
      '[Output]\n请按以下格式回答：\n1. 结论（简洁明确）\n2. 依据（列出支撑证据及来源）\n3. 风险与假设（如有）\n4. 下一步行动建议（如适用）'
    ];
    const budget = Math.floor(this.maxTokens * (1 - this.reserveRatio));
    const result = sections.join('\n\n');
    if (!this.enableCompression || this.tokenCounter.count(result) <= budget) return result;
    const kept: string[] = [];
    for (const line of result.split('\n')) {
      if (this.tokenCounter.count([...kept, line].join('\n')) > budget) break;
      kept.push(line);
    }
    return kept.join('\n');
  }
}
