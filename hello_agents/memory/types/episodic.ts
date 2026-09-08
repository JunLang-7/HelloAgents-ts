/**
 * 情景记忆实现（上游 `memory/types/episodic.py` 的教学版移植）。
 *
 * - 存储具体交互事件（Episode），按会话与时间序列组织
 * - 结构化过滤 + 向量检索（后端由 #84 注入）+ 内存关键词兜底
 * - 近因与重要性加权、模式识别、时间线视图
 *
 * 兼容修复（在 PR 差异清单中登记）：
 * 1. 上游 `get_all()` 读取了 Episode 上不存在的 `metadata` 属性，必然抛
 *    AttributeError；这里按其构造来源补出 `{session_id, context, outcome}`。
 * 2. 上游 `find_patterns()` 使用 timedelta 不存在的 `.hours` 属性；按注释
 *    意图实现为“缓存有效期 1 小时”。
 */
import { BaseMemory, MemoryConfig, MemoryItem, type RetrieveOptions } from '../base.js';
import type {
  AsyncMemoryBackends,
  MemoryBackends,
  StoredMemoryDoc,
  VectorSearchHit
} from '../ports.js';

/** 情景记忆中的单个情景。 */
export class Episode {
  public episodeId: string;
  public userId: string;
  public sessionId: string;
  public timestamp: Date;
  public content: string;
  public context: Record<string, unknown>;
  public outcome: string | undefined;
  public importance: number;

  public constructor(init: {
    episodeId: string;
    userId: string;
    sessionId: string;
    timestamp: Date;
    content: string;
    context: Record<string, unknown>;
    outcome?: string | undefined;
    importance?: number;
  }) {
    this.episodeId = init.episodeId;
    this.userId = init.userId;
    this.sessionId = init.sessionId;
    this.timestamp = init.timestamp;
    this.content = init.content;
    this.context = init.context;
    this.outcome = init.outcome;
    this.importance = init.importance ?? 0.5;
  }

  /** 上游缺失、由本移植补齐的结构化元数据。 */
  public get metadata(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      context: this.context,
      ...(this.outcome === undefined ? {} : { outcome: this.outcome })
    };
  }
}

export interface EpisodicRetrieveOptions extends RetrieveOptions {
  sessionId?: string | undefined;
  timeRange?: readonly [Date, Date] | undefined;
  importanceThreshold?: number | undefined;
}

function recencyScore(timestamp: Date): number {
  const ageDays = Math.max(0, (Date.now() - timestamp.getTime()) / 1000 / 86_400);
  return 1 / (1 + ageDays);
}

/** 情景记忆：交互事件、时间序列与模式识别。 */
export class EpisodicMemory extends BaseMemory {
  public episodes: Episode[];
  public sessions: Map<string, string[]>;
  public patternsCache: Map<string, Array<Record<string, unknown>>>;
  public lastPatternAnalysis: Date | null;

  public constructor(
    config?: MemoryConfig,
    backends?: MemoryBackends,
    asyncBackends?: AsyncMemoryBackends
  );
  public constructor(options?: {
    config?: MemoryConfig;
    backends?: MemoryBackends;
    asyncBackends?: AsyncMemoryBackends;
  });
  public constructor(
    configOrOptions?:
      | MemoryConfig
      | { config?: MemoryConfig; backends?: MemoryBackends; asyncBackends?: AsyncMemoryBackends },
    backends: MemoryBackends = {},
    asyncBackends: AsyncMemoryBackends = {}
  ) {
    const config =
      configOrOptions instanceof MemoryConfig
        ? configOrOptions
        : (configOrOptions?.config ?? new MemoryConfig());
    const resolved =
      configOrOptions instanceof MemoryConfig ? backends : (configOrOptions?.backends ?? {});
    const resolvedAsync =
      configOrOptions instanceof MemoryConfig
        ? asyncBackends
        : (configOrOptions?.asyncBackends ?? {});
    super(config, 'episodic', resolved, undefined, resolvedAsync);
    this.episodes = [];
    this.sessions = new Map();
    this.patternsCache = new Map();
    this.lastPatternAnalysis = null;
    this.restorePersistedCache();
  }

  /**
   * Rebuild the in-memory episode cache from the authoritative document store.
   *
   * Memory instances are intentionally cache-backed, but a new process starts
   * with an empty cache.  The synchronous document-store port makes a small,
   * eager restore possible without changing the public synchronous API or
   * re-writing restored rows through add().
   */
  private restorePersistedCache(): void {
    const docStore = this.backends.docStore ?? this.asyncBackends.docStore;
    if (!docStore) return;

    let docs: StoredMemoryDoc[];
    try {
      docs = docStore.searchMemories({ memory_type: 'episodic', limit: 10_000 });
    } catch {
      // A document-store failure must not make the degraded in-memory path
      // unusable, matching the other optional-backend error handling.
      return;
    }

    for (const doc of docs) {
      if (doc.memory_type !== 'episodic') continue;
      if (this.episodes.some((episode) => episode.episodeId === doc.memory_id)) continue;

      const properties = doc.properties ?? {};
      const sessionId =
        typeof properties.session_id === 'string' ? properties.session_id : 'default_session';
      const context =
        typeof properties.context === 'object' && properties.context !== null
          ? { ...(properties.context as Record<string, unknown>) }
          : {};
      const outcome = typeof properties.outcome === 'string' ? properties.outcome : undefined;
      const episode = new Episode({
        episodeId: doc.memory_id,
        userId: doc.user_id,
        sessionId,
        timestamp: new Date(doc.timestamp * 1000),
        content: doc.content,
        context,
        outcome,
        importance: doc.importance
      });
      this.episodes.push(episode);
      const ids = this.sessions.get(sessionId) ?? [];
      ids.push(episode.episodeId);
      this.sessions.set(sessionId, ids);
    }
  }

  public add(memoryItem: MemoryItem): string {
    const sessionId = (memoryItem.metadata.session_id as string) ?? 'default_session';
    const context = (memoryItem.metadata.context as Record<string, unknown>) ?? {};
    const outcome = memoryItem.metadata.outcome as string | undefined;
    const participants = (memoryItem.metadata.participants as unknown[]) ?? [];
    const tags = (memoryItem.metadata.tags as unknown[]) ?? [];

    const episode = new Episode({
      episodeId: memoryItem.id,
      userId: memoryItem.userId,
      sessionId,
      timestamp: memoryItem.timestamp,
      content: memoryItem.content,
      context,
      outcome,
      importance: memoryItem.importance
    });
    this.episodes.push(episode);
    const list = this.sessions.get(sessionId) ?? [];
    list.push(episode.episodeId);
    this.sessions.set(sessionId, list);

    this.backends.docStore?.addMemory({
      memory_id: memoryItem.id,
      user_id: memoryItem.userId,
      content: memoryItem.content,
      memory_type: 'episodic',
      timestamp: Math.floor(memoryItem.timestamp.getTime() / 1000),
      importance: memoryItem.importance,
      properties: { session_id: sessionId, context, outcome, participants, tags }
    });

    try {
      const embedder = this.backends.embedder;
      const vectorStore = this.backends.vectorStore;
      if (embedder && vectorStore) {
        vectorStore.addVectors({
          vectors: [embedder.encode(memoryItem.content)],
          metadata: [
            {
              memory_id: memoryItem.id,
              user_id: memoryItem.userId,
              memory_type: 'episodic',
              importance: memoryItem.importance,
              session_id: sessionId,
              content: memoryItem.content
            }
          ],
          ids: [memoryItem.id]
        });
      }
    } catch {
      // 向量入库失败不影响权威存储与内存缓存（与上游一致）。
    }
    return memoryItem.id;
  }

  /**
   * Async counterpart for real Qdrant/model backends. The synchronous `add`
   * method intentionally remains unchanged; callers must opt into this method
   * when injecting `asyncBackends`.
   */
  public async addAsync(memoryItem: MemoryItem): Promise<string> {
    const vectorStore = this.asyncBackends.vectorStore;
    if (!vectorStore && !this.asyncBackends.docStore) return this.add(memoryItem);

    const sessionId = (memoryItem.metadata.session_id as string) ?? 'default_session';
    const context = (memoryItem.metadata.context as Record<string, unknown>) ?? {};
    const outcome = memoryItem.metadata.outcome as string | undefined;
    const participants = (memoryItem.metadata.participants as unknown[]) ?? [];
    const tags = (memoryItem.metadata.tags as unknown[]) ?? [];
    const episode = new Episode({
      episodeId: memoryItem.id,
      userId: memoryItem.userId,
      sessionId,
      timestamp: memoryItem.timestamp,
      content: memoryItem.content,
      context,
      outcome,
      importance: memoryItem.importance
    });
    this.episodes.push(episode);
    const list = this.sessions.get(sessionId) ?? [];
    list.push(episode.episodeId);
    this.sessions.set(sessionId, list);
    (this.asyncBackends.docStore ?? this.backends.docStore)?.addMemory({
      memory_id: memoryItem.id,
      user_id: memoryItem.userId,
      content: memoryItem.content,
      memory_type: 'episodic',
      timestamp: Math.floor(memoryItem.timestamp.getTime() / 1000),
      importance: memoryItem.importance,
      properties: { session_id: sessionId, context, outcome, participants, tags }
    });

    if (vectorStore) {
      try {
        const vector = await this.encodeAsync(memoryItem.content);
        await vectorStore.addVectors({
          vectors: [vector],
          metadata: [
            {
              memory_id: memoryItem.id,
              user_id: memoryItem.userId,
              memory_type: 'episodic',
              importance: memoryItem.importance,
              session_id: sessionId,
              content: memoryItem.content
            }
          ],
          ids: [memoryItem.id]
        });
      } catch {
        // A failed optional vector write must not discard the authoritative row.
      }
    }
    return memoryItem.id;
  }

  public retrieve(query: string, limit = 5, options: EpisodicRetrieveOptions = {}): MemoryItem[] {
    const userId = options.userId;
    const sessionId = options.sessionId;
    const timeRange = options.timeRange;
    const importanceThreshold = options.importanceThreshold;

    let candidateIds: Set<string> | null = null;
    const docStore = this.backends.docStore;
    if (docStore && (timeRange !== undefined || importanceThreshold !== undefined)) {
      const docs = docStore.searchMemories({
        ...(userId ? { user_id: userId } : {}),
        memory_type: 'episodic',
        ...(timeRange
          ? {
              start_time: Math.floor(timeRange[0].getTime() / 1000),
              end_time: Math.floor(timeRange[1].getTime() / 1000)
            }
          : {}),
        ...(importanceThreshold !== undefined ? { importance_threshold: importanceThreshold } : {}),
        limit: 1000
      });
      candidateIds = new Set(docs.map((doc) => doc.memory_id));
    }

    let hits: VectorSearchHit[] = [];
    try {
      const embedder = this.backends.embedder;
      const vectorStore = this.backends.vectorStore;
      if (embedder && vectorStore) {
        const where: Record<string, unknown> = { memory_type: 'episodic' };
        if (userId) where.user_id = userId;
        hits = vectorStore.searchSimilar({
          queryVector: embedder.encode(query),
          limit: Math.max(limit * 5, 20),
          where
        });
      }
    } catch {
      hits = [];
    }

    const results: Array<[number, MemoryItem]> = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const meta = hit.metadata ?? {};
      const memId = meta.memory_id as string | undefined;
      if (!memId || seen.has(memId)) continue;
      const episode = this.episodes.find((item) => item.episodeId === memId);
      if (episode && episode.context.forgotten === true) continue;
      if (candidateIds && !candidateIds.has(memId)) continue;
      if (sessionId && meta.session_id !== sessionId) continue;
      const doc = docStore?.getMemory(memId);
      if (!doc) continue;
      if (userId && doc.user_id !== userId) continue;

      const vecScore = hit.score;
      const recency = 1 / (1 + Math.max(0, (Date.now() / 1000 - doc.timestamp) / 86_400));
      const importance = doc.importance;
      const combined = (vecScore * 0.8 + recency * 0.2) * (0.8 + importance * 0.4);
      const item = new MemoryItem({
        id: doc.memory_id,
        content: doc.content,
        memoryType: doc.memory_type,
        userId: doc.user_id,
        timestamp: new Date(doc.timestamp * 1000),
        importance,
        metadata: {
          ...doc.properties,
          relevance_score: combined,
          vector_score: vecScore,
          recency_score: recency
        }
      });
      results.push([combined, item]);
      seen.add(memId);
    }

    // 向量检索无结果时的内存关键词兜底（上游同名路径）。
    if (results.length === 0) {
      const queryLower = query.toLowerCase();
      for (const episode of this.filterEpisodes(userId, sessionId, timeRange)) {
        if (!episode.content.toLowerCase().includes(queryLower)) continue;
        const recency = recencyScore(episode.timestamp);
        const combined = (0.5 * 0.8 + recency * 0.2) * (0.8 + episode.importance * 0.4);
        const item = new MemoryItem({
          id: episode.episodeId,
          content: episode.content,
          memoryType: 'episodic',
          userId: episode.userId,
          timestamp: episode.timestamp,
          importance: episode.importance,
          metadata: { ...episode.metadata, relevance_score: combined }
        });
        results.push([combined, item]);
      }
    }

    results.sort((a, b) => b[0] - a[0]);
    return results.slice(0, limit).map(([, item]) => item);
  }

  /** Async vector retrieval; filtering and ranking stay identical to retrieve(). */
  public async retrieveAsync(
    query: string,
    limit = 5,
    options: EpisodicRetrieveOptions = {}
  ): Promise<MemoryItem[]> {
    const vectorStore = this.asyncBackends.vectorStore;
    if (!vectorStore) return this.retrieve(query, limit, options);
    const userId = options.userId;
    const sessionId = options.sessionId;
    const timeRange = options.timeRange;
    const importanceThreshold = options.importanceThreshold;
    let candidateIds: Set<string> | null = null;
    const docStore = this.asyncBackends.docStore ?? this.backends.docStore;
    if (docStore && (timeRange !== undefined || importanceThreshold !== undefined)) {
      const docs = docStore.searchMemories({
        ...(userId ? { user_id: userId } : {}),
        memory_type: 'episodic',
        ...(timeRange
          ? {
              start_time: Math.floor(timeRange[0].getTime() / 1000),
              end_time: Math.floor(timeRange[1].getTime() / 1000)
            }
          : {}),
        ...(importanceThreshold !== undefined ? { importance_threshold: importanceThreshold } : {}),
        limit: 1000
      });
      candidateIds = new Set(docs.map((doc) => doc.memory_id));
    }

    let hits: VectorSearchHit[] = [];
    try {
      const vector = await this.encodeAsync(query);
      const where: Record<string, unknown> = { memory_type: 'episodic' };
      if (userId) where.user_id = userId;
      hits = await vectorStore.searchSimilar({
        queryVector: vector,
        limit: Math.max(limit * 5, 20),
        where
      });
    } catch {
      // Fall through to the same in-memory keyword path as retrieve().
    }

    const results: Array<[number, MemoryItem]> = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const meta = hit.metadata ?? {};
      const memId = typeof meta.memory_id === 'string' ? meta.memory_id : undefined;
      if (!memId || seen.has(memId)) continue;
      const episode = this.episodes.find((item) => item.episodeId === memId);
      if (episode && episode.context.forgotten === true) continue;
      if (candidateIds && !candidateIds.has(memId)) continue;
      if (sessionId && meta.session_id !== sessionId) continue;
      const doc = docStore?.getMemory(memId);
      if (!doc || (userId && doc.user_id !== userId)) continue;
      const vecScore = hit.score;
      const recency = 1 / (1 + Math.max(0, (Date.now() / 1000 - doc.timestamp) / 86_400));
      const combined = (vecScore * 0.8 + recency * 0.2) * (0.8 + doc.importance * 0.4);
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
            vector_score: vecScore,
            recency_score: recency
          }
        })
      ]);
      seen.add(memId);
    }
    if (results.length === 0) {
      const queryLower = query.toLowerCase();
      for (const episode of this.filterEpisodes(userId, sessionId, timeRange)) {
        if (!episode.content.toLowerCase().includes(queryLower)) continue;
        const recency = recencyScore(episode.timestamp);
        const combined = (0.5 * 0.8 + recency * 0.2) * (0.8 + episode.importance * 0.4);
        results.push([
          combined,
          new MemoryItem({
            id: episode.episodeId,
            content: episode.content,
            memoryType: 'episodic',
            userId: episode.userId,
            timestamp: episode.timestamp,
            importance: episode.importance,
            metadata: { ...episode.metadata, relevance_score: combined }
          })
        ]);
      }
    }
    results.sort((a, b) => b[0] - a[0]);
    return results.slice(0, limit).map(([, item]) => item);
  }

  private async encodeAsync(text: string): Promise<number[]> {
    if (this.asyncBackends.embedder) return this.asyncBackends.embedder.encode(text);
    const sync = this.backends.embedder?.encode(text);
    if (sync) return sync;
    throw new Error('Async memory backend requires an embedder');
  }

  public update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: Record<string, unknown>
  ): boolean {
    let updated = false;
    for (const episode of this.episodes) {
      if (episode.episodeId !== memoryId) continue;
      if (content !== undefined) episode.content = content;
      if (importance !== undefined) episode.importance = importance;
      if (metadata !== undefined) {
        const nestedContext = metadata.context as Record<string, unknown> | undefined;
        if (nestedContext) Object.assign(episode.context, nestedContext);
        if ('outcome' in metadata) episode.outcome = metadata.outcome as string | undefined;
      }
      updated = true;
      break;
    }

    let docUpdated = false;
    if (this.backends.docStore) {
      docUpdated = this.backends.docStore.updateMemory({
        memory_id: memoryId,
        ...(content !== undefined ? { content } : {}),
        ...(importance !== undefined ? { importance } : {}),
        ...(metadata !== undefined ? { properties: metadata } : {})
      });
    }

    if (content !== undefined) {
      try {
        const embedder = this.backends.embedder;
        const vectorStore = this.backends.vectorStore;
        if (embedder && vectorStore) {
          const doc = this.backends.docStore?.getMemory(memoryId);
          vectorStore.addVectors({
            vectors: [embedder.encode(content)],
            metadata: [
              {
                memory_id: memoryId,
                user_id: doc?.user_id ?? '',
                memory_type: 'episodic',
                importance: doc?.importance ?? importance ?? 0.5,
                session_id: (doc?.properties as Record<string, unknown> | undefined)?.session_id,
                content
              }
            ],
            ids: [memoryId]
          });
        }
      } catch {
        // 与上游一致：重嵌入失败不影响更新结果。
      }
    }
    return updated || docUpdated;
  }

  /** Async update counterpart; uses only the explicitly async vector port. */
  public async updateAsync(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    const vectorStore = this.asyncBackends.vectorStore;
    if (!vectorStore) return this.update(memoryId, content, importance, metadata);
    let updated = false;
    for (const episode of this.episodes) {
      if (episode.episodeId !== memoryId) continue;
      if (content !== undefined) episode.content = content;
      if (importance !== undefined) episode.importance = importance;
      if (metadata !== undefined) {
        const nestedContext = metadata.context as Record<string, unknown> | undefined;
        if (nestedContext) Object.assign(episode.context, nestedContext);
        if ('outcome' in metadata) episode.outcome = metadata.outcome as string | undefined;
      }
      updated = true;
      break;
    }
    const docStore = this.asyncBackends.docStore ?? this.backends.docStore;
    const docUpdated =
      docStore?.updateMemory({
        memory_id: memoryId,
        ...(content !== undefined ? { content } : {}),
        ...(importance !== undefined ? { importance } : {}),
        ...(metadata !== undefined ? { properties: metadata } : {})
      }) ?? false;
    if (content !== undefined) {
      try {
        const vector = await this.encodeAsync(content);
        const doc = docStore?.getMemory(memoryId);
        await vectorStore.addVectors({
          vectors: [vector],
          metadata: [
            {
              memory_id: memoryId,
              user_id: doc?.user_id ?? '',
              memory_type: 'episodic',
              importance: doc?.importance ?? importance ?? 0.5,
              session_id: (doc?.properties as Record<string, unknown> | undefined)?.session_id,
              content
            }
          ],
          ids: [memoryId]
        });
      } catch {
        // Keep update result independent from optional vector refresh failures.
      }
    }
    return updated || docUpdated;
  }

  public remove(memoryId: string): boolean {
    let removed = false;
    const index = this.episodes.findIndex((episode) => episode.episodeId === memoryId);
    if (index >= 0) {
      const [removedEpisode] = this.episodes.splice(index, 1);
      if (removedEpisode) {
        const list = this.sessions.get(removedEpisode.sessionId);
        if (list) {
          const at = list.indexOf(memoryId);
          if (at >= 0) list.splice(at, 1);
          if (list.length === 0) this.sessions.delete(removedEpisode.sessionId);
        }
      }
      removed = true;
    }
    let docDeleted = false;
    if (this.backends.docStore) docDeleted = this.backends.docStore.deleteMemory(memoryId);
    try {
      this.backends.vectorStore?.deleteMemories([memoryId]);
    } catch {
      // 忽略向量库删除异常。
    }
    return removed || docDeleted;
  }

  public async removeAsync(memoryId: string): Promise<boolean> {
    const vectorStore = this.asyncBackends.vectorStore;
    if (!vectorStore) return this.remove(memoryId);
    let removed = false;
    const index = this.episodes.findIndex((episode) => episode.episodeId === memoryId);
    if (index >= 0) {
      const [episode] = this.episodes.splice(index, 1);
      if (episode) {
        const ids = this.sessions.get(episode.sessionId);
        if (ids) {
          const at = ids.indexOf(memoryId);
          if (at >= 0) ids.splice(at, 1);
          if (ids.length === 0) this.sessions.delete(episode.sessionId);
        }
      }
      removed = true;
    }
    const docDeleted =
      (this.asyncBackends.docStore ?? this.backends.docStore)?.deleteMemory(memoryId) ?? false;
    try {
      await vectorStore.deleteMemories([memoryId]);
    } catch {
      // Optional vector cleanup failure does not hide local/document deletion.
    }
    return removed || docDeleted;
  }

  public hasMemory(memoryId: string): boolean {
    return this.episodes.some((episode) => episode.episodeId === memoryId);
  }
  public has_memory(memoryId: string): boolean {
    return this.hasMemory(memoryId);
  }

  public clear(): void {
    this.episodes = [];
    this.sessions.clear();
    this.patternsCache.clear();
    const docStore = this.backends.docStore;
    if (docStore) {
      const docs = docStore.searchMemories({ memory_type: 'episodic', limit: 10_000 });
      const ids = docs.map((doc) => doc.memory_id);
      for (const id of ids) docStore.deleteMemory(id);
      try {
        if (ids.length > 0) this.backends.vectorStore?.deleteMemories(ids);
      } catch {
        // 忽略向量库异常。
      }
    }
  }

  public forget(strategy = 'importance_based', threshold = 0.1, maxAgeDays = 30): number {
    const toRemove: string[] = [];
    const now = Date.now();
    for (const episode of this.episodes) {
      let shouldForget = false;
      if (strategy === 'importance_based') {
        shouldForget = episode.importance < threshold;
      } else if (strategy === 'time_based') {
        shouldForget = episode.timestamp.getTime() < now - maxAgeDays * 86_400_000;
      } else if (strategy === 'capacity_based') {
        if (this.episodes.length > this.config.maxCapacity) {
          const ordered = [...this.episodes].sort((a, b) => a.importance - b.importance);
          const excess = this.episodes.length - this.config.maxCapacity;
          if (ordered.slice(0, excess).includes(episode)) shouldForget = true;
        }
      }
      if (shouldForget) toRemove.push(episode.episodeId);
    }
    let forgotten = 0;
    for (const id of toRemove) if (this.remove(id)) forgotten += 1;
    return forgotten;
  }

  public getAll(): MemoryItem[] {
    return this.episodes.map(
      (episode) =>
        new MemoryItem({
          id: episode.episodeId,
          content: episode.content,
          memoryType: 'episodic',
          userId: episode.userId,
          timestamp: episode.timestamp,
          importance: episode.importance,
          // 兼容修复：上游此处访问不存在的 episode.metadata。
          metadata: episode.metadata
        })
    );
  }
  public get_all(): MemoryItem[] {
    return this.getAll();
  }

  public getStats(): Record<string, unknown> {
    const active = this.episodes;
    const avgImportance =
      active.length > 0
        ? active.reduce((sum, episode) => sum + episode.importance, 0) / active.length
        : 0;
    const dbStats = this.backends.docStore?.getDatabaseStats() ?? {};
    let vectorStats: Record<string, unknown> = { store_type: 'in_memory_cache' };
    try {
      if (this.backends.vectorStore) vectorStats = this.backends.vectorStore.getCollectionStats();
    } catch {
      vectorStats = { store_type: 'in_memory_cache' };
    }
    const documentStore: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(dbStats)) {
      if (key.endsWith('_count') || key === 'store_type' || key === 'db_path')
        documentStore[key] = value;
    }
    if (Object.keys(documentStore).length === 0) documentStore.store_type = 'in_memory_cache';
    return {
      count: active.length,
      forgotten_count: 0,
      total_count: this.episodes.length,
      sessions_count: this.sessions.size,
      avg_importance: avgImportance,
      time_span_days: this.calculateTimeSpan(),
      memory_type: 'episodic',
      vector_store: vectorStats,
      document_store: documentStore
    };
  }
  public get_stats(): Record<string, unknown> {
    return this.getStats();
  }

  public getSessionEpisodes(sessionId: string): Episode[] {
    const ids = this.sessions.get(sessionId);
    if (!ids) return [];
    return this.episodes.filter((episode) => ids.includes(episode.episodeId));
  }
  public get_session_episodes(sessionId: string): Episode[] {
    return this.getSessionEpisodes(sessionId);
  }

  public findPatterns(userId?: string, minFrequency = 2): Array<Record<string, unknown>> {
    const cacheKey = `${userId ?? 'null'}_${minFrequency}`;
    const cached = this.patternsCache.get(cacheKey);
    if (cached && this.lastPatternAnalysis) {
      const ageHours = (Date.now() - this.lastPatternAnalysis.getTime()) / 3600_000;
      if (ageHours < 1) return cached;
    }

    const episodes = userId
      ? this.episodes.filter((episode) => episode.userId === userId)
      : this.episodes;
    const keywordPatterns = new Map<string, number>();
    const contextPatterns = new Map<string, number>();
    for (const episode of episodes) {
      for (const word of episode.content.toLowerCase().split(/\s+/)) {
        if (word.length > 3) keywordPatterns.set(word, (keywordPatterns.get(word) ?? 0) + 1);
      }
      for (const [key, value] of Object.entries(episode.context)) {
        const patternKey = `${key}:${String(value)}`;
        contextPatterns.set(patternKey, (contextPatterns.get(patternKey) ?? 0) + 1);
      }
    }

    const patterns: Array<Record<string, unknown>> = [];
    for (const [pattern, frequency] of keywordPatterns) {
      if (frequency >= minFrequency)
        patterns.push({
          type: 'keyword',
          pattern,
          frequency,
          confidence: episodes.length > 0 ? frequency / episodes.length : 0
        });
    }
    for (const [pattern, frequency] of contextPatterns) {
      if (frequency >= minFrequency)
        patterns.push({
          type: 'context',
          pattern,
          frequency,
          confidence: episodes.length > 0 ? frequency / episodes.length : 0
        });
    }
    patterns.sort((a, b) => (b.frequency as number) - (a.frequency as number));
    this.patternsCache.set(cacheKey, patterns);
    this.lastPatternAnalysis = new Date();
    return patterns;
  }
  public find_patterns(userId?: string, minFrequency = 2): Array<Record<string, unknown>> {
    return this.findPatterns(userId, minFrequency);
  }

  public getTimeline(userId?: string, limit = 50): Array<Record<string, unknown>> {
    return [...this.episodes]
      .filter((episode) => userId === undefined || episode.userId === userId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit)
      .map((episode) => ({
        episode_id: episode.episodeId,
        timestamp: episode.timestamp.toISOString(),
        content:
          episode.content.length > 100 ? `${episode.content.slice(0, 100)}...` : episode.content,
        session_id: episode.sessionId,
        importance: episode.importance,
        outcome: episode.outcome
      }));
  }
  public get_timeline(userId?: string, limit = 50): Array<Record<string, unknown>> {
    return this.getTimeline(userId, limit);
  }

  public filterEpisodes(
    userId?: string,
    sessionId?: string,
    timeRange?: readonly [Date, Date]
  ): Episode[] {
    return this.episodes.filter((episode) => {
      if (userId && episode.userId !== userId) return false;
      if (sessionId && episode.sessionId !== sessionId) return false;
      if (timeRange) {
        const [start, end] = timeRange;
        if (episode.timestamp < start || episode.timestamp > end) return false;
      }
      return true;
    });
  }

  private calculateTimeSpan(): number {
    if (this.episodes.length === 0) return 0;
    const timestamps = this.episodes.map((episode) => episode.timestamp.getTime());
    return Math.floor((Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000);
  }
}
