/**
 * 记忆系统基础类和配置（上游 `memory/base.py` 的教学版移植）。
 *
 * - {@link MemoryItem}: 记忆项数据结构
 * - {@link MemoryConfig}: 记忆系统配置
 * - {@link BaseMemory}: 记忆基类
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { parseOrThrow } from '../core/errors.js';
import type { AsyncMemoryBackends, MemoryBackends } from './ports.js';

const isoDateSchema = z.union([z.string(), z.number(), z.date()]).transform((value, ctx) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'Invalid timestamp' });
    return z.NEVER;
  }
  return date;
});

/** 记忆项的线格式（snake_case，与 pydantic 序列化保持一致）。 */
export const memoryItemSchema = z
  .object({
    id: z.string().min(1),
    content: z.string(),
    memory_type: z.string().min(1),
    user_id: z.string().min(1),
    timestamp: isoDateSchema,
    importance: z.number().finite().default(0.5),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type MemoryItemJSON = z.input<typeof memoryItemSchema>;

/** 记忆项数据结构（上游 `memory.base.MemoryItem`）。 */
export class MemoryItem {
  public id: string;
  public content: string;
  public memoryType: string;
  public userId: string;
  public timestamp: Date;
  public importance: number;
  public metadata: Record<string, unknown>;

  public constructor(init: {
    id: string;
    content: string;
    memory_type?: string;
    memoryType?: string;
    user_id?: string;
    userId?: string;
    timestamp: Date;
    importance?: number;
    metadata?: Record<string, unknown>;
  }) {
    this.id = init.id;
    this.content = init.content;
    this.memoryType = init.memory_type ?? init.memoryType ?? '';
    this.userId = init.user_id ?? init.userId ?? '';
    this.timestamp = init.timestamp;
    this.importance = init.importance ?? 0.5;
    this.metadata = init.metadata ? { ...init.metadata } : {};
  }

  /** 从线格式字典构造记忆项。 */
  public static fromJSON(input: unknown): MemoryItem {
    const value = parseOrThrow(memoryItemSchema, input, 'MemoryItem');
    return new MemoryItem({
      id: value.id,
      content: value.content,
      memoryType: value.memory_type,
      userId: value.user_id,
      timestamp: value.timestamp,
      importance: value.importance,
      metadata: { ...value.metadata }
    });
  }

  /** 序列化为上游 pydantic 兼容的 snake_case 字典。 */
  public toJSON(): {
    id: string;
    content: string;
    memory_type: string;
    user_id: string;
    timestamp: string;
    importance: number;
    metadata: Record<string, unknown>;
  } {
    return {
      id: this.id,
      content: this.content,
      memory_type: this.memoryType,
      user_id: this.userId,
      timestamp: this.timestamp.toISOString(),
      importance: this.importance,
      metadata: this.metadata
    };
  }

  /** Python 兼容别名。 */
  public to_dict(): ReturnType<MemoryItem['toJSON']> {
    return this.toJSON();
  }
}

const memoryConfigFields = {
  storage_path: z.string().default('./memory_data'),
  max_capacity: z.number().int().positive().default(100),
  importance_threshold: z.number().finite().default(0.1),
  decay_factor: z.number().finite().positive().default(0.95),
  working_memory_capacity: z.number().int().positive().default(10),
  working_memory_tokens: z.number().int().positive().default(2000),
  working_memory_ttl_minutes: z.number().int().positive().default(120),
  perceptual_memory_modalities: z.array(z.string()).default(['text', 'image', 'audio', 'video'])
} as const;

/** 记忆系统配置的 snake_case 校验模式。 */
export const memoryConfigSchema = z.object(memoryConfigFields).strict();
export type MemoryConfigInput = z.input<typeof memoryConfigSchema>;
export type MemoryConfigValues = z.output<typeof memoryConfigSchema>;

/** 记忆系统配置（上游 `memory.base.MemoryConfig`）。 */
export type MemoryConfigOverrides = Partial<
  MemoryConfigValues & {
    storagePath: string;
    maxCapacity: number;
    importanceThreshold: number;
    decayFactor: number;
    workingMemoryCapacity: number;
    workingMemoryTokens: number;
    workingMemoryTtlMinutes: number;
    perceptualMemoryModalities: string[];
  }
>;

export class MemoryConfig {
  public storagePath: string;
  public maxCapacity: number;
  public importanceThreshold: number;
  public decayFactor: number;
  public workingMemoryCapacity: number;
  public workingMemoryTokens: number;
  public workingMemoryTtlMinutes: number;
  public perceptualMemoryModalities: string[];

  public constructor(overrides: MemoryConfigOverrides = {}) {
    const merged = {
      storage_path: overrides.storagePath ?? overrides.storage_path,
      max_capacity: overrides.maxCapacity ?? overrides.max_capacity,
      importance_threshold: overrides.importanceThreshold ?? overrides.importance_threshold,
      decay_factor: overrides.decayFactor ?? overrides.decay_factor,
      working_memory_capacity: overrides.workingMemoryCapacity ?? overrides.working_memory_capacity,
      working_memory_tokens: overrides.workingMemoryTokens ?? overrides.working_memory_tokens,
      working_memory_ttl_minutes:
        overrides.workingMemoryTtlMinutes ?? overrides.working_memory_ttl_minutes,
      perceptual_memory_modalities:
        overrides.perceptualMemoryModalities ?? overrides.perceptual_memory_modalities
    };
    const value = memoryConfigSchema.parse(merged);
    this.storagePath = value.storage_path;
    this.maxCapacity = value.max_capacity;
    this.importanceThreshold = value.importance_threshold;
    this.decayFactor = value.decay_factor;
    this.workingMemoryCapacity = value.working_memory_capacity;
    this.workingMemoryTokens = value.working_memory_tokens;
    this.workingMemoryTtlMinutes = value.working_memory_ttl_minutes;
    this.perceptualMemoryModalities = [...value.perceptual_memory_modalities];
  }

  /** 序列化为上游 snake_case 配置字典。 */
  public toDict(): MemoryConfigValues {
    return memoryConfigSchema.parse({
      storage_path: this.storagePath,
      max_capacity: this.maxCapacity,
      importance_threshold: this.importanceThreshold,
      decay_factor: this.decayFactor,
      working_memory_capacity: this.workingMemoryCapacity,
      working_memory_tokens: this.workingMemoryTokens,
      working_memory_ttl_minutes: this.workingMemoryTtlMinutes,
      perceptual_memory_modalities: [...this.perceptualMemoryModalities]
    });
  }

  public to_dict(): MemoryConfigValues {
    return this.toDict();
  }
}

/**
 * 各记忆类型 retrieve 的通用过滤参数（对应 Python 的 **kwargs）。
 *
 * 与上游一致：minImportance 会被传入但类型层并不保证生效——上游各类型
 * retrieve 均以 **kwargs 接收后从不读取（死参数语义）；TS 保留该字段仅为
 * 模拟上游 kwargs 的"可传、可忽略"。具体类型是否消费见各自实现。
 */
export interface RetrieveOptions {
  userId?: string | undefined;
  minImportance?: number | undefined;
  [key: string]: unknown;
}

/** 记忆基类：定义所有记忆类型的通用接口和行为。 */
export abstract class BaseMemory {
  public readonly config: MemoryConfig;
  public readonly storage: MemoryBackends | undefined;
  /** Optional Promise-based backends used only by explicit async methods. */
  public readonly asyncStorage: AsyncMemoryBackends | undefined;
  public readonly memoryType: string;
  /** 注入的可选后端（#84 提供真实实现）。 */
  protected readonly backends: MemoryBackends;
  protected readonly asyncBackends: AsyncMemoryBackends;

  public constructor(
    config: MemoryConfig,
    memoryType: string,
    backends: MemoryBackends = {},
    /** 上游构造参数 storage_backend（单一后端的旧式入口）。 */
    storageBackend?: unknown,
    asyncBackends: AsyncMemoryBackends = {}
  ) {
    this.config = config;
    this.memoryType = memoryType;
    this.backends = backends;
    this.storage = Object.keys(backends).length > 0 ? backends : undefined;
    this.asyncBackends = asyncBackends;
    this.asyncStorage = Object.keys(asyncBackends).length > 0 ? asyncBackends : undefined;
    if (storageBackend !== undefined && this.storage === undefined) {
      this.storage = { docStore: storageBackend as never };
    }
  }

  /** Whether this instance has an explicitly configured async backend bundle. */
  protected hasAsyncBackends(): boolean {
    return Object.keys(this.asyncBackends).length > 0;
  }

  /** 添加记忆项，返回记忆 ID。 */
  abstract add(memoryItem: MemoryItem): string;
  /** 检索相关记忆（上游为同步接口）。 */
  abstract retrieve(query: string, limit?: number, options?: RetrieveOptions): MemoryItem[];
  /** 更新记忆。 */
  abstract update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: Record<string, unknown>
  ): boolean;
  /** 删除记忆。 */
  abstract remove(memoryId: string): boolean;
  /** 检查记忆是否存在。 */
  abstract hasMemory(memoryId: string): boolean;
  /** 清空所有记忆。 */
  abstract clear(): void;
  /** 获取记忆统计信息。 */
  abstract getStats(): Record<string, unknown>;

  /** 生成记忆 ID（uuid4）。 */
  protected generateId(): string {
    return randomUUID();
  }
  /** Python 兼容别名。 */
  protected _generate_id(): string {
    return this.generateId();
  }

  /**
   * 计算记忆重要性：内容超过 100 字符 +0.1，命中重要关键词 +0.2，截断到 [0,1]。
   */
  public calculateImportance(content: string, baseImportance = 0.5): number {
    let importance = baseImportance;
    if (content.length > 100) importance += 0.1;
    const importantKeywords = ['重要', '关键', '必须', '注意', '警告', '错误'];
    if (importantKeywords.some((keyword) => content.includes(keyword))) importance += 0.2;
    return Math.max(0, Math.min(1, importance));
  }
  protected _calculate_importance(content: string, baseImportance = 0.5): number {
    return this.calculateImportance(content, baseImportance);
  }

  public toString(): string {
    const stats = this.getStats();
    const count = typeof stats.count === 'number' ? stats.count : 0;
    return `${this.constructor.name}(count=${count})`;
  }
}

/** 四种具体记忆类型额外具备的遗忘与全量列举能力。 */
export interface ForgettableMemory extends BaseMemory {
  forget(strategy?: string, threshold?: number, maxAgeDays?: number): number;
  getAll(): MemoryItem[];
}
