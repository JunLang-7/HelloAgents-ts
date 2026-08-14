import { Message } from '../core/message.js';
import { TokenCounter } from './token-counter.js';

export interface HistoryManagerOptions {
  /** 尝试压缩前允许的最大 token 总数。 */
  readonly maxTokens: number;
  /** 原样保留的最近完整用户轮数。 */
  readonly retainRecentTurns?: number;
  /** 用于估计消息 token 使用量的计数器。 */
  readonly tokenCounter?: TokenCounter;
  /** 用于压缩较早轮次的可选异步摘要函数。 */
  readonly summarize?: (messages: readonly Message[]) => string | Promise<string>;
}

function turns(messages: readonly Message[]): Message[][] {
  const result: Message[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || result.length === 0) result.push([message]);
    else result.at(-1)?.push(message);
  }
  return result;
}

/** 对话历史管理器，只压缩较早的完整用户轮次。 */
export class HistoryManager {
  private messages: Message[] = [];
  private readonly maxTokens: number;
  private readonly retainRecentTurns: number;
  private readonly counter: TokenCounter;
  private readonly summarize: (messages: readonly Message[]) => string | Promise<string>;

  public constructor(options: HistoryManagerOptions) {
    this.maxTokens = options.maxTokens;
    this.retainRecentTurns = options.retainRecentTurns ?? 2;
    this.counter = options.tokenCounter ?? new TokenCounter();
    this.summarize =
      options.summarize ?? ((items) => items.map((item) => item.toText()).join('\n'));
  }

  /**
   * 添加消息，但不会自动压缩历史。
   *
   * @param message 要追加的消息。
   */
  public add(message: Message): void {
    this.messages.push(message);
  }

  /** 返回所有保留消息的副本。 */
  public getAll(): readonly Message[] {
    return [...this.messages];
  }

  /** 清空所有保留消息。 */
  public clear(): void {
    this.messages = [];
  }

  /** 估算所有保留消息的内容 token 总数。 */
  public tokenCount(): number {
    return this.messages.reduce((sum, message) => sum + this.counter.count(message.content), 0);
  }

  /**
   * 超出 token 预算时，摘要较早的完整轮次。
   *
   * @returns 压缩后的历史消息副本。
   */
  public async compact(): Promise<readonly Message[]> {
    if (this.tokenCount() <= this.maxTokens) return this.getAll();
    const grouped = turns(this.messages);
    const keep = grouped.slice(-this.retainRecentTurns).flat();
    const older = grouped.slice(0, -this.retainRecentTurns).flat();
    if (older.length === 0) return this.getAll();
    const summary = new Message(await this.summarize(older), 'summary');
    this.messages = [summary, ...keep];
    return this.getAll();
  }
}
