/**
 * 记忆管理器（上游 `memory/manager.py` 的教学版移植）——记忆核心层的统一接口。
 *
 * 负责记忆生命周期、自动分类、重要性评估、遗忘清理、跨类型整合与统计。
 */
import { randomUUID } from 'node:crypto';

import { MemoryConfig, MemoryItem } from './base.js';
import type { BaseMemory, ForgettableMemory } from './base.js';
import type { MemoryBackends } from './ports.js';
import { EpisodicMemory } from './types/episodic.js';
import { PerceptualMemory } from './types/perceptual.js';
import { SemanticMemory } from './types/semantic.js';
import { WorkingMemory } from './types/working.js';

export interface MemoryManagerOptions {
  config?: MemoryConfig | undefined;
  userId?: string | undefined;
  enableWorking?: boolean | undefined;
  enableEpisodic?: boolean | undefined;
  enableSemantic?: boolean | undefined;
  enablePerceptual?: boolean | undefined;
  /** 透传给各记忆类型的可选后端（#84）。 */
  backends?: MemoryBackends | undefined;
  /** 按记忆类型分别指定后端。 */
  backendsByType?: Partial<Record<MemoryTypeName, MemoryBackends>> | undefined;
}

export type MemoryTypeName = 'working' | 'episodic' | 'semantic' | 'perceptual';

export interface RetrieveMemoriesOptions {
  memoryTypes?: string[] | undefined;
  limit?: number | undefined;
  minImportance?: number | undefined;
  timeRange?: readonly [Date, Date] | undefined;
}

/** 多类型分层记忆的统一操作门面。 */
export class MemoryManager {
  public config: MemoryConfig;
  public userId: string;
  public memoryTypes: Record<string, BaseMemory>;

  public constructor(options?: MemoryManagerOptions);
  public constructor(
    config?: MemoryConfig,
    userId?: string,
    enableWorking?: boolean,
    enableEpisodic?: boolean,
    enableSemantic?: boolean,
    enablePerceptual?: boolean
  );
  public constructor(
    configOrOptions?: MemoryConfig | MemoryManagerOptions,
    userId = 'default_user',
    enableWorking = true,
    enableEpisodic = true,
    enableSemantic = true,
    enablePerceptual = false
  ) {
    let options: MemoryManagerOptions;
    if (configOrOptions instanceof MemoryConfig) {
      options = {
        config: configOrOptions,
        userId,
        enableWorking,
        enableEpisodic,
        enableSemantic,
        enablePerceptual
      };
    } else {
      options = configOrOptions ?? {};
    }
    this.config = options.config ?? new MemoryConfig();
    this.userId = options.userId ?? 'default_user';
    const backends = options.backends ?? {};
    const byType = options.backendsByType ?? {};
    this.memoryTypes = {};
    if (options.enableWorking ?? true)
      this.memoryTypes.working = new WorkingMemory(this.config, byType.working ?? backends);
    if (options.enableEpisodic ?? true)
      this.memoryTypes.episodic = new EpisodicMemory(this.config, byType.episodic ?? backends);
    if (options.enableSemantic ?? true)
      this.memoryTypes.semantic = new SemanticMemory(this.config, byType.semantic ?? backends);
    if (options.enablePerceptual ?? false)
      this.memoryTypes.perceptual = new PerceptualMemory(
        this.config,
        byType.perceptual ?? backends
      );
  }

  /** Python 属性名兼容别名。 */
  public get memory_types(): Record<string, BaseMemory> {
    return this.memoryTypes;
  }

  public addMemory(
    content: string,
    memoryType = 'working',
    importance?: number,
    metadata?: Record<string, unknown>,
    autoClassify = true
  ): string {
    let resolvedType = memoryType;
    if (autoClassify) resolvedType = this.classifyMemoryType(content, metadata);
    const resolvedImportance = importance ?? this.calculateImportance(content, metadata);
    const item = new MemoryItem({
      id: randomUUID(),
      content,
      memoryType: resolvedType,
      userId: this.userId,
      timestamp: new Date(),
      importance: resolvedImportance,
      metadata: metadata ? { ...metadata } : {}
    });
    const target = this.memoryTypes[resolvedType];
    if (!target) throw new Error(`不支持的记忆类型: ${resolvedType}`);
    return target.add(item);
  }
  public add_memory(
    content: string,
    memoryType?: string,
    importance?: number,
    metadata?: Record<string, unknown>,
    autoClassify?: boolean
  ): string {
    return this.addMemory(
      content,
      memoryType ?? 'working',
      importance,
      metadata,
      autoClassify ?? true
    );
  }

  public retrieveMemories(
    query: string,
    memoryTypes?: string[],
    limit = 10,
    minImportance = 0,
    timeRange?: readonly [Date, Date]
  ): MemoryItem[] {
    const types = memoryTypes ?? Object.keys(this.memoryTypes);
    const all: MemoryItem[] = [];
    const perTypeLimit = Math.max(1, Math.floor(limit / types.length));
    for (const type of types) {
      const instance = this.memoryTypes[type];
      if (!instance) continue;
      try {
        const result = instance.retrieve(query, perTypeLimit, {
          minImportance,
          userId: this.userId,
          ...(timeRange ? { timeRange } : {})
        });
        all.push(...result);
      } catch {
        // 与上游一致：单类型检索失败不影响其他类型。
      }
    }
    all.sort((a, b) => b.importance - a.importance);
    return all.slice(0, limit);
  }
  public retrieve_memories(
    query: string,
    memoryTypes?: string[],
    limit?: number,
    minImportance?: number
  ): MemoryItem[] {
    return this.retrieveMemories(query, memoryTypes, limit ?? 10, minImportance ?? 0);
  }

  public updateMemory(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: Record<string, unknown>
  ): boolean {
    for (const instance of Object.values(this.memoryTypes)) {
      if (instance.hasMemory(memoryId))
        return instance.update(memoryId, content, importance, metadata);
    }
    return false;
  }
  public update_memory(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: Record<string, unknown>
  ): boolean {
    return this.updateMemory(memoryId, content, importance, metadata);
  }

  public removeMemory(memoryId: string): boolean {
    for (const instance of Object.values(this.memoryTypes)) {
      if (instance.hasMemory(memoryId)) return instance.remove(memoryId);
    }
    return false;
  }
  public remove_memory(memoryId: string): boolean {
    return this.removeMemory(memoryId);
  }

  public forgetMemories(strategy = 'importance_based', threshold = 0.1, maxAgeDays = 30): number {
    let total = 0;
    for (const instance of Object.values(this.memoryTypes)) {
      const forgettable = instance as ForgettableMemory;
      if (typeof forgettable.forget === 'function')
        total += forgettable.forget(strategy, threshold, maxAgeDays);
    }
    return total;
  }
  public forget_memories(strategy?: string, threshold?: number, maxAgeDays?: number): number {
    return this.forgetMemories(strategy, threshold, maxAgeDays);
  }

  public consolidateMemories(
    fromType = 'working',
    toType = 'episodic',
    importanceThreshold = 0.7
  ): number {
    const source = this.memoryTypes[fromType];
    const target = this.memoryTypes[toType];
    if (!source || !target) return 0;
    const candidates = (source as ForgettableMemory)
      .getAll()
      .filter((memory) => memory.importance >= importanceThreshold);
    let count = 0;
    for (const memory of candidates) {
      if (source.remove(memory.id)) {
        memory.memoryType = toType;
        memory.importance *= 1.1; // 与上游一致：整合后提升 10%，不做截断。
        target.add(memory);
        count += 1;
      }
    }
    return count;
  }
  public consolidate_memories(
    fromType?: string,
    toType?: string,
    importanceThreshold?: number
  ): number {
    return this.consolidateMemories(fromType, toType, importanceThreshold);
  }

  public getMemoryStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {
      user_id: this.userId,
      enabled_types: Object.keys(this.memoryTypes),
      total_memories: 0,
      memories_by_type: {},
      config: {
        max_capacity: this.config.maxCapacity,
        importance_threshold: this.config.importanceThreshold,
        decay_factor: this.config.decayFactor
      }
    };
    const byType = stats.memories_by_type as Record<string, unknown>;
    let total = 0;
    for (const [type, instance] of Object.entries(this.memoryTypes)) {
      const typeStats = instance.getStats();
      byType[type] = typeStats;
      total += typeof typeStats.count === 'number' ? typeStats.count : 0;
    }
    stats.total_memories = total;
    return stats;
  }
  public get_memory_stats(): Record<string, unknown> {
    return this.getMemoryStats();
  }

  public clearAllMemories(): void {
    for (const instance of Object.values(this.memoryTypes)) instance.clear();
  }
  public clear_all_memories(): void {
    this.clearAllMemories();
  }

  public classifyMemoryType(content: string, metadata?: Record<string, unknown>): MemoryTypeName {
    if (metadata && typeof metadata.type === 'string') return metadata.type as MemoryTypeName;
    if (this.isEpisodicContent(content)) return 'episodic';
    if (this.isSemanticContent(content)) return 'semantic';
    return 'working';
  }

  private isEpisodicContent(content: string): boolean {
    const keywords = ['昨天', '今天', '明天', '上次', '记得', '发生', '经历'];
    return keywords.some((keyword) => content.includes(keyword));
  }

  private isSemanticContent(content: string): boolean {
    const keywords = ['定义', '概念', '规则', '知识', '原理', '方法'];
    return keywords.some((keyword) => content.includes(keyword));
  }

  public calculateImportance(content: string, metadata?: Record<string, unknown>): number {
    let importance = 0.5;
    if (content.length > 100) importance += 0.1;
    const keywords = ['重要', '关键', '必须', '注意', '警告', '错误'];
    if (keywords.some((keyword) => content.includes(keyword))) importance += 0.2;
    if (metadata) {
      if (metadata.priority === 'high') importance += 0.3;
      else if (metadata.priority === 'low') importance -= 0.2;
    }
    return Math.max(0, Math.min(1, importance));
  }

  public toString(): string {
    const stats = this.getMemoryStats();
    return `MemoryManager(user=${this.userId}, total=${stats.total_memories})`;
  }
}
