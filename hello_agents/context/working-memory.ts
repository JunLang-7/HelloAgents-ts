import { TokenCounter } from './token-counter.js';

export interface WorkingMemoryItem {
  /** 调用方提供的稳定标识。 */
  readonly id: string;
  /** 可直接加入提示词的记忆内容。 */
  readonly content: string;
  /** 淘汰优先级；优先淘汰较低优先级的条目。 */
  readonly importance?: number;
  /** 调用方定义的元数据。 */
  readonly metadata?: Record<string, unknown>;
  /** Unix 毫秒时间戳；默认使用配置的时钟。 */
  readonly timestamp?: number;
}
export interface WorkingMemoryOptions {
  /** 最多保留的条目数。 */
  readonly capacity?: number;
  /** 保留条目的最大 token 估算总数。 */
  readonly maxTokens?: number;
  /** 读取和写入前应用的过期时间。 */
  readonly ttlMinutes?: number;
  /** 时钟注入，用于确定性过期测试。 */
  readonly now?: () => number;
  /** 用于执行 token 预算的计数器。 */
  readonly tokenCounter?: TokenCounter;
}

interface StoredMemory extends Required<Omit<WorkingMemoryItem, 'metadata'>> {
  metadata: Record<string, unknown>;
}

/** 会话范围内的有界工作记忆，实现 Python 版本的优先级和 TTL 语义。 */
export class WorkingMemory {
  private readonly capacity: number;
  private readonly maxTokens: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly counter: TokenCounter;
  private items: StoredMemory[] = [];

  public constructor(options: WorkingMemoryOptions = {}) {
    this.capacity = options.capacity ?? 10;
    this.maxTokens = options.maxTokens ?? 2_000;
    this.ttlMs = (options.ttlMinutes ?? 120) * 60_000;
    this.now = options.now ?? Date.now;
    this.counter = options.tokenCounter ?? new TokenCounter();
  }

  /** 添加记忆，应用过期和容量限制，并返回其 ID。 */
  public add(item: WorkingMemoryItem): string {
    this.expire();
    this.items.push({
      ...item,
      importance: item.importance ?? 0.5,
      metadata: item.metadata ?? {},
      timestamp: item.timestamp ?? this.now()
    });
    this.enforce();
    return item.id;
  }

  /** 返回尚未过期的记忆条目。 */
  public getAll(): readonly WorkingMemoryItem[] {
    this.expire();
    return [...this.items];
  }

  /** 清空所有工作记忆条目。 */
  public clear(): void {
    this.items = [];
  }

  private expire(): void {
    this.items = this.items.filter((item) => this.now() - item.timestamp <= this.ttlMs);
  }
  private enforce(): void {
    while (
      this.items.length > 0 &&
      (this.items.length > this.capacity ||
        this.items.reduce((sum, item) => sum + this.counter.count(item.content), 0) >
          this.maxTokens)
    ) {
      const lowest = this.items.reduce(
        (best, item, index) =>
          item.importance < (this.items[best]?.importance ?? Number.POSITIVE_INFINITY)
            ? index
            : best,
        0
      );
      this.items.splice(lowest, 1);
    }
  }
}
