/**
 * 工作记忆实现（上游 `memory/types/working.py` 的教学版移植）。
 *
 * - 短期上下文管理，容量与 token 双限制
 * - 分钟级 TTL 惰性过期
 * - 重要性 + 指数时间衰减的优先级管理
 *
 * 上游在检索时优先尝试 sklearn TF-IDF 向量检索，失败后回退关键词匹配；
 * sklearn/嵌入后端属于 #84，因此本实现固定走上游同一条关键词回退路径，
 * 评分公式（关键词分 × 时间衰减 × 重要性权重）保持一致。
 */
import { BaseMemory, MemoryConfig, type MemoryItem, type RetrieveOptions } from '../base.js';
import type { MemoryBackends } from '../ports.js';

/** Python `str.split()` 等价的词元计数（空白序列分词，空串为 0）。 */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

interface HeapEntry {
  negPriority: number;
  timestamp: Date;
  item: MemoryItem;
}

export interface WorkingMemoryOptions {
  readonly config?: MemoryConfig | undefined;
  readonly backends?: MemoryBackends | undefined;
}

/** 工作记忆：会话级、容量有限、按优先级自动淘汰。 */
export class WorkingMemory extends BaseMemory {
  public maxCapacity: number;
  public maxTokens: number;
  public maxAgeMinutes: number;
  public currentTokens: number;
  public sessionStart: Date;
  public memories: MemoryItem[];
  /** (priority, timestamp, item) 堆的镜像，仅用于保持上游内部结构。 */
  public memoryHeap: HeapEntry[];

  public constructor(config?: MemoryConfig, backends?: MemoryBackends);
  public constructor(options?: WorkingMemoryOptions);
  public constructor(
    configOrOptions?: MemoryConfig | WorkingMemoryOptions,
    backends: MemoryBackends = {}
  ) {
    const config =
      configOrOptions instanceof MemoryConfig
        ? configOrOptions
        : (configOrOptions?.config ?? new MemoryConfig());
    const resolvedBackends =
      configOrOptions instanceof MemoryConfig ? backends : (configOrOptions?.backends ?? {});
    super(config, 'working', resolvedBackends);
    this.maxCapacity = config.workingMemoryCapacity;
    this.maxTokens = config.workingMemoryTokens;
    this.maxAgeMinutes = config.workingMemoryTtlMinutes;
    this.currentTokens = 0;
    this.sessionStart = new Date();
    this.memories = [];
    this.memoryHeap = [];
  }

  public add(memoryItem: MemoryItem): string {
    this.expireOldMemories();
    const priority = this.calculatePriority(memoryItem);
    this.memoryHeap.push({
      negPriority: -priority,
      timestamp: memoryItem.timestamp,
      item: memoryItem
    });
    this.memories.push(memoryItem);
    this.currentTokens += wordCount(memoryItem.content);
    this.enforceCapacityLimits();
    return memoryItem.id;
  }

  public retrieve(query: string, limit = 5, options: RetrieveOptions = {}): MemoryItem[] {
    this.expireOldMemories();
    if (this.memories.length === 0) return [];

    const activeMemories = this.memories.filter((memory) => memory.metadata.forgotten !== true);
    const userId = typeof options.userId === 'string' ? options.userId : undefined;
    const userFiltered = userId
      ? activeMemories.filter((memory) => memory.userId === userId)
      : activeMemories;
    if (userFiltered.length === 0) return [];

    const queryLower = query.toLowerCase();
    const scored: Array<[number, MemoryItem]> = [];
    for (const memory of userFiltered) {
      const contentLower = memory.content.toLowerCase();
      let keywordScore = 0;
      if (contentLower.includes(queryLower)) {
        keywordScore = queryLower.length / contentLower.length;
      } else {
        const queryWords = new Set(queryLower.split(/\s+/));
        const contentWords = new Set(contentLower.split(/\s+/));
        let intersection = 0;
        for (const word of queryWords) if (contentWords.has(word)) intersection += 1;
        if (intersection > 0) {
          keywordScore = (intersection / new Set([...queryWords, ...contentWords]).size) * 0.8;
        }
      }
      const timeDecay = this.calculateTimeDecay(memory.timestamp);
      const baseRelevance = keywordScore * timeDecay;
      const importanceWeight = 0.8 + memory.importance * 0.4;
      const finalScore = baseRelevance * importanceWeight;
      if (finalScore > 0) scored.push([finalScore, memory]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(([, memory]) => memory);
  }

  public update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: Record<string, unknown>
  ): boolean {
    for (const memory of this.memories) {
      if (memory.id === memoryId) {
        const oldTokens = wordCount(memory.content);
        if (content !== undefined) {
          memory.content = content;
          this.currentTokens = this.currentTokens - oldTokens + wordCount(content);
        }
        if (importance !== undefined) memory.importance = importance;
        if (metadata !== undefined) Object.assign(memory.metadata, metadata);
        this.updateHeapPriority();
        return true;
      }
    }
    return false;
  }

  public remove(memoryId: string): boolean {
    const index = this.memories.findIndex((memory) => memory.id === memoryId);
    if (index < 0) return false;
    const [removed] = this.memories.splice(index, 1);
    this.markDeletedInHeap(memoryId);
    if (removed) this.currentTokens = Math.max(0, this.currentTokens - wordCount(removed.content));
    return true;
  }

  public hasMemory(memoryId: string): boolean {
    return this.memories.some((memory) => memory.id === memoryId);
  }
  public has_memory(memoryId: string): boolean {
    return this.hasMemory(memoryId);
  }

  public clear(): void {
    this.memories = [];
    this.memoryHeap = [];
    this.currentTokens = 0;
  }

  public getStats(): Record<string, unknown> {
    this.expireOldMemories();
    const active = this.memories;
    const avgImportance =
      active.length > 0
        ? active.reduce((sum, memory) => sum + memory.importance, 0) / active.length
        : 0;
    return {
      count: active.length,
      forgotten_count: 0,
      total_count: this.memories.length,
      current_tokens: this.currentTokens,
      max_capacity: this.maxCapacity,
      max_tokens: this.maxTokens,
      max_age_minutes: this.maxAgeMinutes,
      session_duration_minutes: (Date.now() - this.sessionStart.getTime()) / 1000 / 60,
      avg_importance: avgImportance,
      capacity_usage: this.maxCapacity > 0 ? active.length / this.maxCapacity : 0,
      token_usage: this.maxTokens > 0 ? this.currentTokens / this.maxTokens : 0,
      memory_type: 'working'
    };
  }
  public get_stats(): Record<string, unknown> {
    return this.getStats();
  }

  public getRecent(limit = 10): MemoryItem[] {
    return [...this.memories]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }
  public get_recent(limit = 10): MemoryItem[] {
    return this.getRecent(limit);
  }

  public getImportant(limit = 10): MemoryItem[] {
    return [...this.memories].sort((a, b) => b.importance - a.importance).slice(0, limit);
  }
  public get_important(limit = 10): MemoryItem[] {
    return this.getImportant(limit);
  }

  public getAll(): MemoryItem[] {
    return [...this.memories];
  }
  public get_all(): MemoryItem[] {
    return this.getAll();
  }

  public getContextSummary(maxLength = 500): string {
    if (this.memories.length === 0) return 'No working memories available.';
    const ordered = [...this.memories].sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.timestamp.getTime() - a.timestamp.getTime();
    });
    const parts: string[] = [];
    let currentLength = 0;
    for (const memory of ordered) {
      const content = memory.content;
      if (currentLength + content.length <= maxLength) {
        parts.push(content);
        currentLength += content.length;
      } else {
        const remaining = maxLength - currentLength;
        if (remaining > 50) parts.push(`${content.slice(0, remaining)}...`);
        break;
      }
    }
    return `Working Memory Context:\n${parts.join('\n')}`;
  }
  public get_context_summary(maxLength = 500): string {
    return this.getContextSummary(maxLength);
  }

  public forget(strategy = 'importance_based', threshold = 0.1, maxAgeDays = 1): number {
    let forgottenCount = 0;
    const now = Date.now();
    const toRemove = new Set<string>();

    const ttlCutoff = now - this.maxAgeMinutes * 60_000;
    for (const memory of this.memories) {
      if (memory.timestamp.getTime() < ttlCutoff) toRemove.add(memory.id);
    }

    if (strategy === 'importance_based') {
      for (const memory of this.memories) {
        if (memory.importance < threshold) toRemove.add(memory.id);
      }
    } else if (strategy === 'time_based') {
      const cutoff = now - maxAgeDays * 24 * 3_600_000;
      for (const memory of this.memories) {
        if (memory.timestamp.getTime() < cutoff) toRemove.add(memory.id);
      }
    } else if (strategy === 'capacity_based') {
      if (this.memories.length > this.maxCapacity) {
        const ordered = [...this.memories].sort(
          (a, b) => this.calculatePriority(a) - this.calculatePriority(b)
        );
        const excess = this.memories.length - this.maxCapacity;
        for (const memory of ordered.slice(0, excess)) toRemove.add(memory.id);
      }
    }

    for (const memoryId of toRemove) if (this.remove(memoryId)) forgottenCount += 1;
    return forgottenCount;
  }

  public calculatePriority(memory: MemoryItem): number {
    return memory.importance * this.calculateTimeDecay(memory.timestamp);
  }
  protected _calculate_priority(memory: MemoryItem): number {
    return this.calculatePriority(memory);
  }

  public calculateTimeDecay(timestamp: Date): number {
    const hoursPassed = (Date.now() - timestamp.getTime()) / 1000 / 3600;
    const decayed = this.config.decayFactor ** (hoursPassed / 6);
    return Math.max(0.1, decayed);
  }
  protected _calculate_time_decay(timestamp: Date): number {
    return this.calculateTimeDecay(timestamp);
  }

  private enforceCapacityLimits(): void {
    while (this.memories.length > this.maxCapacity) this.removeLowestPriorityMemory();
    while (this.currentTokens > this.maxTokens) this.removeLowestPriorityMemory();
  }

  private expireOldMemories(): void {
    if (this.memories.length === 0) return;
    const cutoff = Date.now() - this.maxAgeMinutes * 60_000;
    const kept: MemoryItem[] = [];
    let removedTokens = 0;
    for (const memory of this.memories) {
      if (memory.timestamp.getTime() >= cutoff) kept.push(memory);
      else removedTokens += wordCount(memory.content);
    }
    if (kept.length === this.memories.length) return;
    this.memories = kept;
    this.currentTokens = Math.max(0, this.currentTokens - removedTokens);
    this.memoryHeap = [];
    for (const memory of this.memories) {
      this.memoryHeap.push({
        negPriority: -this.calculatePriority(memory),
        timestamp: memory.timestamp,
        item: memory
      });
    }
  }
  protected _expire_old_memories(): void {
    this.expireOldMemories();
  }

  private removeLowestPriorityMemory(): void {
    if (this.memories.length === 0) return;
    let lowest: MemoryItem | undefined;
    let lowestPriority = Number.POSITIVE_INFINITY;
    for (const memory of this.memories) {
      const priority = this.calculatePriority(memory);
      if (priority < lowestPriority) {
        lowestPriority = priority;
        lowest = memory;
      }
    }
    if (lowest) this.remove(lowest.id);
  }

  private updateHeapPriority(): void {
    this.memoryHeap = [];
    for (const item of this.memories) {
      this.memoryHeap.push({
        negPriority: -this.calculatePriority(item),
        timestamp: item.timestamp,
        item
      });
    }
  }

  private markDeletedInHeap(memoryId: string): void {
    // 与上游一致：heapq 不支持直接删除，惰性重建时自然清理。
    void memoryId;
  }
}
