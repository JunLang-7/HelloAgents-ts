import type { Message } from '../core/message.js';
import { TokenCounter } from './token-counter.js';

export interface ContextPacket {
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: number;
  readonly tokenCount?: number;
  readonly relevanceScore?: number;
}
export interface ContextBuilderOptions {
  readonly maxTokens?: number;
  readonly reserveRatio?: number;
  readonly minRelevance?: number;
  readonly enableCompression?: boolean;
  readonly tokenCounter?: TokenCounter;
}
export interface BuildContextOptions {
  readonly userQuery: string;
  readonly conversationHistory?: readonly Message[];
  readonly systemInstructions?: string;
  readonly additionalPackets?: readonly ContextPacket[];
}

/** Python V1 ContextBuilder's Gather-Select-Structure-Compress pipeline. */
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
