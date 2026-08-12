import { TokenCounter } from './token-counter.js';

export interface WorkingMemoryItem {
  readonly id: string;
  readonly content: string;
  readonly importance?: number;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: number;
}
export interface WorkingMemoryOptions {
  readonly capacity?: number;
  readonly maxTokens?: number;
  readonly ttlMinutes?: number;
  readonly now?: () => number;
  readonly tokenCounter?: TokenCounter;
}

interface StoredMemory extends Required<Omit<WorkingMemoryItem, 'metadata'>> {
  metadata: Record<string, unknown>;
}

/** Session-scoped, bounded working memory matching Python's priority/TTL intent. */
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

  public getAll(): readonly WorkingMemoryItem[] {
    this.expire();
    return [...this.items];
  }

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
