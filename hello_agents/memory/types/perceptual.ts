/**
 * 感知记忆实现（上游 `memory/types/perceptual.py` 的教学版移植）。
 *
 * 长存的多模态记忆：文本/图像/音频/视频，SQLite 权威存储（#84 注入）+
 * 按模态拆分的向量集合（#84 注入）+ 内存关键词兜底。
 *
 * 上游在 CLIP/CLAP 缺失时把图像/音频编码退化为 SHA-256 确定性哈希向量，
 * 本移植完整保留该轻量路径（Python random.Random 为 MT19937，JS 使用
 * mulberry32：同为确定性伪随机，数值不逐位相同，已在差异清单登记）。
 * 文本嵌入器由 #84 提供；缺失时同样退化为哈希向量而非伪装模型输出。
 */
import { createHash } from 'node:crypto';

import { BaseMemory, MemoryConfig, MemoryItem, type RetrieveOptions } from '../base.js';
import type { MemoryBackends, VectorSearchHit, VectorStorePort } from '../ports.js';

/** 感知数据实体。 */
export class Perception {
  public perceptionId: string;
  public data: unknown;
  public modality: string;
  public encoding: number[];
  public metadata: Record<string, unknown>;
  public timestamp: Date;
  public dataHash: string;

  public constructor(
    perceptionId: string,
    data: unknown,
    modality: string,
    encoding: number[] = [],
    metadata: Record<string, unknown> = {}
  ) {
    this.perceptionId = perceptionId;
    this.data = data;
    this.modality = modality;
    this.encoding = [...encoding];
    this.metadata = { ...metadata };
    this.timestamp = new Date();
    this.dataHash = this.calculateHash();
  }

  private calculateHash(): string {
    if (typeof this.data === 'string')
      return createHash('md5').update(this.data, 'utf8').digest('hex');
    if (this.data instanceof Uint8Array) return createHash('md5').update(this.data).digest('hex');
    return createHash('md5').update(String(this.data), 'utf8').digest('hex');
  }
}

export interface PerceptualRetrieveOptions extends RetrieveOptions {
  targetModality?: string | undefined;
  queryModality?: string | undefined;
}

type Encoder = (data: unknown) => number[];

/** mulberry32 确定性 PRNG（替代上游 random.Random(seed).random()）。 */
function seededRandomSequence(seed: number, length: number): number[] {
  let a = seed >>> 0;
  const values: number[] = [];
  for (let i = 0; i < length; i += 1) {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    values.push(((t ^ (t >>> 14)) >>> 0) / 4_294_967_296);
  }
  return values;
}

/** 长期、多模态的感知记忆。 */
export class PerceptualMemory extends BaseMemory {
  public perceptions: Map<string, Perception>;
  public perceptualMemories: MemoryItem[];
  public modalityIndex: Map<string, string[]>;
  public supportedModalities: Set<string>;
  public vectorDim: number;
  public imageDim: number;
  public audioDim: number;
  public encoders: Record<string, Encoder>;

  public constructor(config?: MemoryConfig, backends?: MemoryBackends);
  public constructor(options?: { config?: MemoryConfig; backends?: MemoryBackends });
  public constructor(
    configOrOptions?: MemoryConfig | { config?: MemoryConfig; backends?: MemoryBackends },
    backends: MemoryBackends = {}
  ) {
    const config =
      configOrOptions instanceof MemoryConfig
        ? configOrOptions
        : (configOrOptions?.config ?? new MemoryConfig());
    const resolved =
      configOrOptions instanceof MemoryConfig ? backends : (configOrOptions?.backends ?? {});
    super(config, 'perceptual', resolved);
    this.perceptions = new Map();
    this.perceptualMemories = [];
    this.modalityIndex = new Map();
    this.supportedModalities = new Set(config.perceptualMemoryModalities);
    this.vectorDim = this.backends.embedder?.dimension ?? 384;
    // CLIP/CLAP 未移植，维度退化为文本维度（与上游缺依赖时一致）。
    this.imageDim = this.vectorDim;
    this.audioDim = this.vectorDim;
    this.encoders = this.initEncoders();
  }

  public add(memoryItem: MemoryItem): string {
    const modality = (memoryItem.metadata.modality as string) ?? 'text';
    const rawData = memoryItem.metadata.raw_data ?? memoryItem.content;
    if (!this.supportedModalities.has(modality)) throw new Error(`不支持的模态类型: ${modality}`);

    const perception = this.encodePerception(rawData, modality, memoryItem.id);
    this.perceptions.set(perception.perceptionId, perception);
    const ids = this.modalityIndex.get(modality) ?? [];
    ids.push(perception.perceptionId);
    this.modalityIndex.set(modality, ids);

    memoryItem.metadata.perception_id = perception.perceptionId;
    memoryItem.metadata.modality = modality;
    this.perceptualMemories.push(memoryItem);

    this.backends.docStore?.addMemory({
      memory_id: memoryItem.id,
      user_id: memoryItem.userId,
      content: memoryItem.content,
      memory_type: 'perceptual',
      timestamp: Math.floor(memoryItem.timestamp.getTime() / 1000),
      importance: memoryItem.importance,
      properties: {
        perception_id: perception.perceptionId,
        modality,
        context: memoryItem.metadata.context ?? {},
        tags: memoryItem.metadata.tags ?? []
      }
    });

    try {
      const store = this.getVectorStoreForModality(modality);
      store?.addVectors({
        vectors: [perception.encoding],
        metadata: [
          {
            memory_id: memoryItem.id,
            user_id: memoryItem.userId,
            memory_type: 'perceptual',
            modality,
            importance: memoryItem.importance,
            content: memoryItem.content
          }
        ],
        ids: [memoryItem.id]
      });
    } catch {
      // 向量入库失败不影响缓存与权威存储。
    }
    return memoryItem.id;
  }

  public retrieve(query: string, limit = 5, options: PerceptualRetrieveOptions = {}): MemoryItem[] {
    const userId = typeof options.userId === 'string' ? options.userId : undefined;
    const targetModality =
      typeof options.targetModality === 'string' ? options.targetModality : undefined;
    const queryModality =
      (typeof options.queryModality === 'string' ? options.queryModality : undefined) ??
      targetModality ??
      'text';

    let hits: VectorSearchHit[] = [];
    try {
      const qvec = this.encodeData(query, queryModality);
      const where: Record<string, unknown> = { memory_type: 'perceptual' };
      if (userId) where.user_id = userId;
      if (targetModality) where.modality = targetModality;
      hits =
        this.getVectorStoreForModality(targetModality ?? queryModality)?.searchSimilar({
          queryVector: qvec,
          limit: Math.max(limit * 5, 20),
          where
        }) ?? [];
    } catch {
      hits = [];
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const results: Array<[number, MemoryItem]> = [];
    const seen = new Set<string>();
    const docStore = this.backends.docStore;
    for (const hit of hits) {
      const meta = hit.metadata ?? {};
      const memId = meta.memory_id as string | undefined;
      if (!memId || seen.has(memId)) continue;
      if (targetModality && meta.modality !== targetModality) continue;
      const doc = docStore?.getMemory(memId);
      if (!doc) continue;
      const recency = 1 / (1 + Math.max(0, (nowSec - doc.timestamp) / 86_400));
      const combined = (hit.score * 0.8 + recency * 0.2) * (0.8 + doc.importance * 0.4);
      results.push([
        combined,
        new MemoryItem({
          id: doc.memory_id,
          content: doc.content,
          memoryType: doc.memory_type,
          userId: doc.user_id,
          timestamp: new Date(doc.timestamp * 1000),
          importance: doc.importance,
          metadata: {
            ...doc.properties,
            relevance_score: combined,
            vector_score: hit.score,
            recency_score: recency
          }
        })
      ]);
      seen.add(memId);
    }

    // 无向量命中时的结构化 + 关键词兜底（上游同路径，按模态过滤）。
    if (results.length === 0) {
      const queryLower = query.toLowerCase();
      for (const memory of this.perceptualMemories) {
        if (targetModality && memory.metadata.modality !== targetModality) continue;
        if (!(memory.content ?? '').toLowerCase().includes(queryLower)) continue;
        const recency =
          1 / (1 + Math.max(0, (nowSec - memory.timestamp.getTime() / 1000) / 86_400));
        const combined = (0.5 * 0.8 + recency * 0.2) * (0.8 + memory.importance * 0.4);
        results.push([combined, memory]);
      }
    }

    results.sort((a, b) => b[0] - a[0]);
    return results.slice(0, limit).map(([, item]) => item);
  }

  public update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: Record<string, unknown>
  ): boolean {
    let updated = false;
    let modalityCache: string | undefined;
    for (const memory of this.perceptualMemories) {
      if (memory.id !== memoryId) continue;
      if (content !== undefined) memory.content = content;
      if (importance !== undefined) memory.importance = importance;
      if (metadata !== undefined) Object.assign(memory.metadata, metadata);
      modalityCache = (memory.metadata.modality as string) ?? 'text';
      updated = true;
      break;
    }

    this.backends.docStore?.updateMemory({
      memory_id: memoryId,
      ...(content !== undefined ? { content } : {}),
      ...(importance !== undefined ? { importance } : {}),
      ...(metadata !== undefined ? { properties: metadata } : {})
    });

    if (content !== undefined || (metadata && 'raw_data' in metadata)) {
      const modality = metadata
        ? ((metadata.modality as string | undefined) ?? modalityCache ?? 'text')
        : (modalityCache ?? 'text');
      const raw = metadata ? (metadata.raw_data ?? content) : content;
      try {
        const perception = this.encodePerception(raw ?? '', modality, memoryId);
        const payload = this.backends.docStore?.getMemory(memoryId);
        this.getVectorStoreForModality(modality)?.addVectors({
          vectors: [perception.encoding],
          metadata: [
            {
              memory_id: memoryId,
              user_id: payload?.user_id ?? '',
              memory_type: 'perceptual',
              modality,
              importance: payload?.importance ?? importance ?? 0.5,
              content: content ?? payload?.content ?? ''
            }
          ],
          ids: [memoryId]
        });
      } catch {
        // 重嵌入失败不影响更新结果。
      }
    }
    return updated;
  }

  public remove(memoryId: string): boolean {
    let removed = false;
    const index = this.perceptualMemories.findIndex((memory) => memory.id === memoryId);
    if (index >= 0) {
      const [removedMemory] = this.perceptualMemories.splice(index, 1);
      if (removedMemory) {
        const perceptionId = removedMemory.metadata.perception_id as string | undefined;
        if (perceptionId) {
          const perception = this.perceptions.get(perceptionId);
          if (perception) {
            this.perceptions.delete(perceptionId);
            const list = this.modalityIndex.get(perception.modality);
            if (list) {
              const at = list.indexOf(perceptionId);
              if (at >= 0) list.splice(at, 1);
              if (list.length === 0) this.modalityIndex.delete(perception.modality);
            }
          }
        }
      }
      removed = true;
    }
    this.backends.docStore?.deleteMemory(memoryId);
    for (const store of Object.values(this.backends.vectorStores ?? {})) {
      try {
        store.deleteMemories([memoryId]);
      } catch {
        // 忽略单集合删除异常。
      }
    }
    return removed;
  }

  public hasMemory(memoryId: string): boolean {
    return this.perceptualMemories.some((memory) => memory.id === memoryId);
  }
  public has_memory(memoryId: string): boolean {
    return this.hasMemory(memoryId);
  }

  public forget(strategy = 'importance_based', threshold = 0.1, maxAgeDays = 30): number {
    const toRemove: string[] = [];
    const now = Date.now();
    for (const memory of this.perceptualMemories) {
      let shouldForget = false;
      if (strategy === 'importance_based') {
        shouldForget = memory.importance < threshold;
      } else if (strategy === 'time_based') {
        shouldForget = memory.timestamp.getTime() < now - maxAgeDays * 86_400_000;
      } else if (strategy === 'capacity_based') {
        if (this.perceptualMemories.length > this.config.maxCapacity) {
          const ordered = [...this.perceptualMemories].sort((a, b) => a.importance - b.importance);
          const excess = this.perceptualMemories.length - this.config.maxCapacity;
          if (ordered.slice(0, excess).includes(memory)) shouldForget = true;
        }
      }
      if (shouldForget) toRemove.push(memory.id);
    }
    let forgotten = 0;
    for (const id of toRemove) if (this.remove(id)) forgotten += 1;
    return forgotten;
  }

  public clear(): void {
    this.perceptualMemories = [];
    this.perceptions.clear();
    this.modalityIndex.clear();
    const docStore = this.backends.docStore;
    let ids: string[] = [];
    if (docStore) {
      ids = docStore
        .searchMemories({ memory_type: 'perceptual', limit: 10_000 })
        .map((doc) => doc.memory_id);
      for (const id of ids) docStore.deleteMemory(id);
    }
    for (const store of Object.values(this.backends.vectorStores ?? {})) {
      try {
        if (ids.length > 0) store.deleteMemories(ids);
      } catch {
        // 忽略单集合异常。
      }
    }
  }

  public getAll(): MemoryItem[] {
    return [...this.perceptualMemories];
  }
  public get_all(): MemoryItem[] {
    return this.getAll();
  }

  public getStats(): Record<string, unknown> {
    const modalityCounts: Record<string, number> = {};
    for (const [modality, ids] of this.modalityIndex) modalityCounts[modality] = ids.length;
    const vectorStatsAll: Record<string, unknown> = {};
    for (const [mod, store] of Object.entries(this.backends.vectorStores ?? {})) {
      try {
        vectorStatsAll[mod] = store.getCollectionStats();
      } catch {
        vectorStatsAll[mod] = { store_type: 'in_memory_cache' };
      }
    }
    const dbStats = this.backends.docStore?.getDatabaseStats() ?? {};
    const documentStore: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dbStats)) {
      if (key.endsWith('_count') || key === 'store_type' || key === 'db_path')
        documentStore[key] = value;
    }
    if (Object.keys(documentStore).length === 0) documentStore.store_type = 'in_memory_cache';
    const active = this.perceptualMemories;
    return {
      count: active.length,
      forgotten_count: 0,
      total_count: this.perceptualMemories.length,
      perceptions_count: this.perceptions.size,
      modality_counts: modalityCounts,
      supported_modalities: [...this.supportedModalities],
      avg_importance:
        active.length > 0
          ? active.reduce((sum, memory) => sum + memory.importance, 0) / active.length
          : 0,
      memory_type: 'perceptual',
      vector_stores: vectorStatsAll,
      document_store: documentStore
    };
  }
  public get_stats(): Record<string, unknown> {
    return this.getStats();
  }

  public crossModalSearch(
    query: unknown,
    queryModality: string,
    targetModality?: string,
    limit = 5
  ): MemoryItem[] {
    return this.retrieve(String(query), limit, { queryModality, targetModality });
  }
  public cross_modal_search(
    query: unknown,
    queryModality: string,
    targetModality?: string,
    limit = 5
  ): MemoryItem[] {
    return this.crossModalSearch(query, queryModality, targetModality, limit);
  }

  public getByModality(modality: string, limit = 10): MemoryItem[] {
    const perceptionIds = this.modalityIndex.get(modality);
    if (!perceptionIds) return [];
    const results: MemoryItem[] = [];
    for (const memory of this.perceptualMemories) {
      const id = memory.metadata.perception_id;
      if (id && perceptionIds.includes(id as string)) {
        results.push(memory);
        if (results.length >= limit) break;
      }
    }
    return results;
  }
  public get_by_modality(modality: string, limit = 10): MemoryItem[] {
    return this.getByModality(modality, limit);
  }

  public generateContent(prompt: string, targetModality: string): string | null {
    if (!this.supportedModalities.has(targetModality)) return null;
    const relevant = this.retrieve(prompt, 3);
    if (relevant.length === 0) return null;
    if (targetModality === 'text') {
      return `基于感知记忆生成的内容：\n${relevant.map((memory) => memory.content).join('\n')}`;
    }
    return `生成的${targetModality}内容（基于${relevant.length}个相关记忆）`;
  }
  public generate_content(prompt: string, targetModality: string): string | null {
    return this.generateContent(prompt, targetModality);
  }

  private initEncoders(): Record<string, Encoder> {
    const encoders: Record<string, Encoder> = {};
    for (const modality of this.supportedModalities) {
      if (modality === 'text') encoders[modality] = (data) => this.textEncoder(String(data));
      else if (modality === 'image') encoders[modality] = (data) => this.imageEncoder(data);
      else if (modality === 'audio') encoders[modality] = (data) => this.audioEncoder(data);
      else encoders[modality] = (data) => this.defaultEncoder(data);
    }
    return encoders;
  }

  public encodePerception(data: unknown, modality: string, memoryId: string): Perception {
    return new Perception(
      `perception_${memoryId}`,
      data,
      modality,
      this.encodeData(data, modality),
      { source: 'memory_system' }
    );
  }

  public encodeData(data: unknown, modality: string): number[] {
    const targetDim = this.getDimForModality(modality);
    const encoder = this.encoders[modality] ?? ((value: unknown) => this.defaultEncoder(value));
    let vector = encoder(data);
    if (vector.length < targetDim)
      vector = [...vector, ...new Array<number>(targetDim - vector.length).fill(0)];
    else if (vector.length > targetDim) vector = vector.slice(0, targetDim);
    return vector;
  }

  private textEncoder(text: string): number[] {
    const embedder = this.backends.embedder;
    if (embedder) return embedder.encode(text ?? '');
    return this.hashToVector(String(text ?? ''), this.vectorDim);
  }

  private imageEncoderHash(imageData: unknown): number[] {
    const bytes =
      imageData instanceof Uint8Array ? imageData : Buffer.from(String(imageData), 'utf8');
    const hex = createHash('sha256').update(bytes).digest('hex');
    return this.hashToVector(hex, this.getDimForModality('image'));
  }

  private imageEncoder(imageData: unknown): number[] {
    // CLIP 未移植，固定走上游的哈希退化路径。
    return this.imageEncoderHash(imageData);
  }

  private audioEncoderHash(audioData: unknown): number[] {
    const bytes =
      audioData instanceof Uint8Array ? audioData : Buffer.from(String(audioData), 'utf8');
    const hex = createHash('sha256').update(bytes).digest('hex');
    return this.hashToVector(hex, this.getDimForModality('audio'));
  }

  private audioEncoder(audioData: unknown): number[] {
    // CLAP 未移植，固定走上游的哈希退化路径。
    return this.audioEncoderHash(audioData);
  }

  private defaultEncoder(data: unknown): number[] {
    const embedder = this.backends.embedder;
    if (embedder) return embedder.encode(String(data));
    return this.hashToVector(String(data), this.vectorDim);
  }

  public calculateSimilarity(encoding1: number[], encoding2: number[]): number {
    if (encoding1.length === 0 || encoding2.length === 0) return 0;
    const minLen = Math.min(encoding1.length, encoding2.length);
    if (minLen === 0) return 0;
    let dot = 0;
    let norm1 = 0;
    let norm2 = 0;
    for (let i = 0; i < minLen; i += 1) {
      dot += encoding1[i]! * encoding2[i]!;
      norm1 += encoding1[i]! ** 2;
      norm2 += encoding2[i]! ** 2;
    }
    if (norm1 === 0 || norm2 === 0) return 0;
    return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
  }
  protected _calculate_similarity(encoding1: number[], encoding2: number[]): number {
    return this.calculateSimilarity(encoding1, encoding2);
  }

  public hashToVector(dataStr: string, dim: number): number[] {
    const hex = createHash('sha256').update(dataStr, 'utf8').digest('hex');
    const seed = Number(BigInt(`0x${hex.slice(0, 8)}`) % BigInt(2 ** 32));
    return seededRandomSequence(seed, dim);
  }
  protected _hash_to_vector(dataStr: string, dim: number): number[] {
    return this.hashToVector(dataStr, dim);
  }

  public getVectorStoreForModality(modality?: string): VectorStorePort | undefined {
    const mod = (modality ?? 'text').toLowerCase();
    return this.backends.vectorStores?.[mod] ?? this.backends.vectorStore;
  }

  public getDimForModality(modality?: string): number {
    const mod = (modality ?? 'text').toLowerCase();
    if (mod === 'image') return this.imageDim;
    if (mod === 'audio') return this.audioDim;
    return this.vectorDim;
  }
}
