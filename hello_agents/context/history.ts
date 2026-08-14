import { Message } from '../core/message.js';
import { TokenCounter } from './token-counter.js';

export interface HistoryManagerOptions {
  /** Maximum aggregate token count before compaction is attempted. */
  readonly maxTokens: number;
  /** Number of complete recent user turns to preserve verbatim. */
  readonly retainRecentTurns?: number;
  /** Counter used to estimate message token usage. */
  readonly tokenCounter?: TokenCounter;
  /** Optional async summarizer for compacted older turns. */
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

/** Conversation history that only compacts complete older user turns. */
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

  /** Appends a message without automatically compacting history. */
  public add(message: Message): void {
    this.messages.push(message);
  }

  /** Returns a mutable-safe snapshot of all retained messages. */
  public getAll(): readonly Message[] {
    return [...this.messages];
  }

  /** Removes all retained messages. */
  public clear(): void {
    this.messages = [];
  }

  /** Estimates total content tokens across retained messages. */
  public tokenCount(): number {
    return this.messages.reduce((sum, message) => sum + this.counter.count(message.content), 0);
  }

  /** Summarizes complete older turns when the configured token budget is exceeded. */
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
