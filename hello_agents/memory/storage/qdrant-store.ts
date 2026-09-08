/**
 * Qdrant 向量数据库存储实现（上游 `memory/storage/qdrant_store.py` 的教学版移植）。
 *
 * - `QdrantConnectionManager`：连接管理器（单例，防止重复连接与集合初始化）。
 * - `QdrantVectorStore`：Qdrant 向量存储，公开 addVectors / searchSimilar /
 *   deleteVectors / clearCollection / deleteMemories / getCollectionInfo /
 *   getCollectionStats / healthCheck。
 *
 * 依赖与差异（docs/upstream-differences.md）：
 * - DIFF-010：上游构造器急切连接 localhost:6333 且失败即抛；TS 保留 eager
 *   连接语义，但默认配置经 `QdrantConfig`/端口注入，错误消息给出本地启动指引。
 * - DIFF-021：客户端为 `@qdrant/js-client-rest`（按需加载，重依赖不进入包依赖）；
 *   JS 客户端无 `close()`（无状态 HTTP），`close()` 为空实现。
 * - DIFF-022：JS `CollectionInfo` 无顶层 `vectors_count`（Python 客户端有），
 *   `getCollectionInfo` 用 `points_count` 填充该键并登记差异。
 * - 上游 `logger.info/warning/debug` 输出在 TS 侧省略，语义由返回值与错误消息承载。
 */

import type { VectorSearchHit } from '../ports.js';

// ---------------------------------------------------------------------------
// 客户端加载（按需）
// ---------------------------------------------------------------------------

export interface QdrantDistanceMap {
  cosine: string;
  dot: string;
  euclidean: string;
}

export interface QdrantCollectionConfig {
  size: number;
  distance: string;
}

interface ScoredPointLike {
  id: string | number;
  score: number;
  payload?: Record<string, unknown> | null;
}

interface CollectionInfoLike {
  points_count?: number | null;
  indexed_vectors_count?: number | null;
  segments_count?: number;
  config?: { params?: { vectors?: { size?: number } | Record<string, unknown> } };
}

/** js-client-rest 的最小客户端接口（真实类型由动态加载模块提供）。 */
export interface QdrantClientLike {
  getCollections(): Promise<{ collections?: Array<{ name: string }> }>;
  collectionExists(collection_name: string): Promise<{ exists: boolean }>;
  createCollection(
    collection_name: string,
    args: {
      vectors: QdrantCollectionConfig;
      hnsw_config?: { m?: number; ef_construct?: number } | null;
    }
  ): Promise<unknown>;
  updateCollection(
    collection_name: string,
    args: { hnsw_config?: { m?: number; ef_construct?: number } }
  ): Promise<unknown>;
  createPayloadIndex(
    collection_name: string,
    args: { field_name: string; field_schema: string }
  ): Promise<unknown>;
  upsert(
    collection_name: string,
    args: { points: Array<Record<string, unknown>>; wait: boolean }
  ): Promise<unknown>;
  query(
    collection_name: string,
    args: {
      query: number[];
      filter?: Record<string, unknown> | null;
      limit: number;
      score_threshold?: number | null;
      with_payload: boolean;
      with_vector: boolean;
      params?: { hnsw_ef?: number; exact?: boolean } | null;
    }
  ): Promise<{ points: ScoredPointLike[] }>;
  delete(
    collection_name: string,
    args: { points?: Array<string | number>; filter?: Record<string, unknown>; wait: boolean }
  ): Promise<unknown>;
  getCollection(collection_name: string): Promise<CollectionInfoLike>;
  deleteCollection(collection_name: string): Promise<unknown>;
}

let _qdrantLoaded = false;
let _qdrantAvailable = false;
let _QdrantClientCtor:
  | (new (args: {
      url?: string;
      host?: string;
      port?: number;
      api_key?: string;
      timeout?: number;
    }) => QdrantClientLike)
  | null = null;

/** 按需加载 @qdrant/js-client-rest；未安装时给出安装指引。 */
export async function loadQdrantClient(): Promise<
  new (args: {
    url?: string;
    host?: string;
    port?: number;
    api_key?: string;
    timeout?: number;
  }) => QdrantClientLike
> {
  if (!_qdrantLoaded) {
    try {
      const mod = (await import('@qdrant/js-client-rest')) as { QdrantClient: unknown };
      _QdrantClientCtor = mod.QdrantClient as typeof _QdrantClientCtor;
      _qdrantAvailable = true;
    } catch {
      _qdrantAvailable = false;
    }
    _qdrantLoaded = true;
  }
  if (!_qdrantAvailable || _QdrantClientCtor === null) {
    throw new Error('qdrant-client 未安装。请运行: bun add @qdrant/js-client-rest');
  }
  return _QdrantClientCtor;
}

// ---------------------------------------------------------------------------
// QdrantVectorStore
// ---------------------------------------------------------------------------

const DISTANCE_MAP: Record<string, string> = {
  cosine: 'Cosine',
  dot: 'Dot',
  euclidean: 'Euclid'
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Qdrant 向量数据库存储实现（上游 `QdrantVectorStore`）。
 *
 * 注意：网络后端为异步公开接口，与 memory types 的同步 `VectorStorePort`
 * 端口不直接兼容（DIFF-024）；SQLite/TF-IDF 等同步实现可直接注入。
 */
export class QdrantVectorStore {
  public readonly url: string | undefined;
  public readonly api_key: string | undefined;
  public readonly collection_name: string;
  public readonly vector_size: number;
  public readonly distance: string;
  public readonly timeout: number;
  public readonly hnsw_m: number;
  public readonly hnsw_ef_construct: number;
  public readonly search_ef: number;
  public readonly search_exact: boolean;
  private client: QdrantClientLike | null = null;

  public constructor(
    config: {
      url?: string | undefined;
      api_key?: string | undefined;
      collection_name?: string | undefined;
      vector_size?: number | undefined;
      distance?: string | undefined;
      timeout?: number | undefined;
    } = {}
  ) {
    this.url = config.url;
    this.api_key = config.api_key;
    this.collection_name = config.collection_name ?? 'hello_agents_vectors';
    this.vector_size = config.vector_size ?? 384;
    this.timeout = config.timeout ?? 30;
    this.hnsw_m = envInt('QDRANT_HNSW_M', 32);
    this.hnsw_ef_construct = envInt('QDRANT_HNSW_EF_CONSTRUCT', 256);
    this.search_ef = envInt('QDRANT_SEARCH_EF', 128);
    this.search_exact = process.env.QDRANT_SEARCH_EXACT === '1';
    this.distance = DISTANCE_MAP[(config.distance ?? 'cosine').toLowerCase()] ?? 'Cosine';
    // 构造即初始化（上游 eager 连接语义，DIFF-010）
  }

  /** 初始化客户端与集合（惰性异步；构造后需 await ensureInitialized()）。 */
  public async ensureInitialized(): Promise<void> {
    if (this.client !== null) return;
    const QdrantClient = await loadQdrantClient();
    // DIFF-026：上游 Python 客户端 timeout 单位为秒；@qdrant/js-client-rest 为毫秒。
    const timeoutMs = this.timeout * 1000;
    let client: QdrantClientLike;
    if (this.url && this.api_key) {
      client = new QdrantClient({ url: this.url, api_key: this.api_key, timeout: timeoutMs });
    } else if (this.url) {
      client = new QdrantClient({ url: this.url, timeout: timeoutMs });
    } else {
      client = new QdrantClient({ host: 'localhost', port: 6333, timeout: timeoutMs });
    }
    try {
      // 连接检查
      await client.getCollections();
      this.client = client;
      await this._ensureCollection();
    } catch (cause) {
      const hint = this.url
        ? '请检查 QDRANT_URL 和 QDRANT_API_KEY 是否正确'
        : '本地连接失败，可考虑 Qdrant 云服务，或启动本地服务: docker run -p 6333:6333 qdrant/qdrant';
      throw new Error(`Qdrant 连接失败: ${hint}`, { cause });
    }
  }

  private async _ensureCollection(): Promise<void> {
    const client = this.client!;
    const exists = (await client.collectionExists(this.collection_name)).exists;
    if (!exists) {
      await client.createCollection(this.collection_name, {
        vectors: { size: this.vector_size, distance: this.distance },
        hnsw_config: { m: this.hnsw_m, ef_construct: this.hnsw_ef_construct }
      });
    } else {
      try {
        await client.updateCollection(this.collection_name, {
          hnsw_config: { m: this.hnsw_m, ef_construct: this.hnsw_ef_construct }
        });
      } catch {
        // 跳过 HNSW 配置更新失败（等价上游 debug 日志）
      }
    }
    await this._ensurePayloadIndexes();
  }

  private async _ensurePayloadIndexes(): Promise<void> {
    const client = this.client!;
    const indexFields: Array<[string, string]> = [
      ['memory_type', 'keyword'],
      ['user_id', 'keyword'],
      ['memory_id', 'keyword'],
      ['timestamp', 'integer'],
      ['modality', 'keyword'],
      ['source', 'keyword'],
      ['external', 'bool'],
      ['namespace', 'keyword'],
      ['is_rag_data', 'bool'],
      ['rag_namespace', 'keyword'],
      ['data_source', 'keyword']
    ];
    for (const [fieldName, schemaType] of indexFields) {
      try {
        await client.createPayloadIndex(this.collection_name, {
          field_name: fieldName,
          field_schema: schemaType
        });
      } catch {
        // 索引已存在会报错，忽略（等价上游 debug 日志）
      }
    }
  }

  /** 添加向量（上游 `add_vectors`）。维度不匹配的点被跳过并返回 false。 */
  public async addVectors(request: {
    vectors: number[][];
    metadata: Array<Record<string, unknown>>;
    ids: string[];
  }): Promise<boolean> {
    await this.ensureInitialized();
    const { vectors, metadata, ids } = request;
    if (vectors.length === 0) return false;

    const now = Math.floor(Date.now() / 1000);
    const points: Array<Record<string, unknown>> = [];
    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i];
      if (!Array.isArray(vector)) continue;
      if (vector.length !== this.vector_size) {
        // 维度不匹配：跳过（等价上游 logger.warning + continue）
        continue;
      }
      const meta = { ...(metadata[i] ?? {}) };
      meta.timestamp = now;
      meta.added_at = now;
      if ('external' in meta && typeof meta.external !== 'boolean') {
        const val = String(meta.external).toLowerCase();
        meta.external = ['1', 'true', 'yes'].includes(val);
      }
      // 点 ID 安全化：无符号整数或 UUID 字符串；否则替换为新 UUID
      let safeId: string | number;
      const rawId = ids[i];
      if (typeof rawId === 'number' && Number.isInteger(rawId) && rawId >= 0) {
        safeId = rawId;
      } else if (typeof rawId === 'string') {
        safeId = isUuid(rawId) ? rawId : crypto.randomUUID();
      } else {
        safeId = crypto.randomUUID();
      }
      points.push({ id: safeId, vector, payload: meta });
    }
    if (points.length === 0) return false;

    await this.client!.upsert(this.collection_name, { points, wait: true });
    return true;
  }

  /** 搜索相似向量（上游 `search_similar`）。查询向量维度错误返回空数组。 */
  public async searchSimilar(request: {
    queryVector: number[];
    limit: number;
    score_threshold?: number | undefined;
    where?: Record<string, unknown> | undefined;
  }): Promise<VectorSearchHit[]> {
    await this.ensureInitialized();
    const { queryVector, limit, score_threshold, where } = request;
    if (queryVector.length !== this.vector_size) return [];

    let queryFilter: Record<string, unknown> | null = null;
    if (where) {
      const conditions: Array<Record<string, unknown>> = [];
      for (const [key, value] of Object.entries(where)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          conditions.push({ key, match: { value } });
        }
      }
      if (conditions.length > 0) queryFilter = { must: conditions };
    }

    const response = await this.client!.query(this.collection_name, {
      query: queryVector,
      filter: queryFilter,
      limit,
      score_threshold: score_threshold ?? null,
      with_payload: true,
      with_vector: false,
      params: { hnsw_ef: this.search_ef, exact: this.search_exact }
    });

    return response.points.map((hit) => ({
      id: String(hit.id),
      score: hit.score,
      metadata: hit.payload ?? {}
    }));
  }

  /** 删除向量（按点 ID；上游 `delete_vectors`）。 */
  public async deleteVectors(ids: Array<string | number>): Promise<boolean> {
    await this.ensureInitialized();
    if (ids.length === 0) return true;
    await this.client!.delete(this.collection_name, { points: ids, wait: true });
    return true;
  }

  /** 清空集合（删除并重建；上游 `clear_collection`）。 */
  public async clearCollection(): Promise<boolean> {
    await this.ensureInitialized();
    await this.client!.deleteCollection(this.collection_name);
    await this._ensureCollection();
    return true;
  }

  /**
   * 删除指定记忆（通过 payload 中的 memory_id 过滤删除；上游 `delete_memories`）。
   * 与上游一致：写入时非 UUID 点 ID 可能被替换，因此不依赖点 ID。
   */
  public async deleteMemories(memoryIds: string[]): Promise<boolean> {
    await this.ensureInitialized();
    if (memoryIds.length === 0) return true;
    const conditions = memoryIds.map((mid) => ({ key: 'memory_id', match: { value: mid } }));
    await this.client!.delete(this.collection_name, {
      filter: { should: conditions },
      wait: true
    });
    return true;
  }

  /** 获取集合信息（上游 `get_collection_info`）。 */
  public async getCollectionInfo(): Promise<Record<string, unknown>> {
    await this.ensureInitialized();
    const info = await this.client!.getCollection(this.collection_name);
    // DIFF-022：JS CollectionInfo 无顶层 vectors_count，用 points_count 填充。
    return {
      name: this.collection_name,
      vectors_count: info.points_count ?? 0,
      indexed_vectors_count: info.indexed_vectors_count ?? 0,
      points_count: info.points_count ?? 0,
      segments_count: info.segments_count ?? 0,
      config: {
        vector_size: this.vector_size,
        distance: this.distance
      }
    };
  }

  /** 获取集合统计信息（兼容抽象接口；上游 `get_collection_stats`）。 */
  public async getCollectionStats(): Promise<Record<string, unknown>> {
    const info = await this.getCollectionInfo();
    if (Object.keys(info).length === 0) {
      return { store_type: 'qdrant', name: this.collection_name };
    }
    return { ...info, store_type: 'qdrant' };
  }

  /** 健康检查（上游 `health_check`）。 */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      await this.client!.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  /** 无状态 HTTP 客户端，无需资源释放（上游 `__del__` 的等价空实现）。 */
  public close(): void {
    // DIFF-021：js-client-rest 无 close()。
  }
}

/** UUID 检测（宽松：接受标准 8-4-4-4-12 形式）。 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ---------------------------------------------------------------------------
// QdrantConnectionManager
// ---------------------------------------------------------------------------

/** Qdrant 连接管理器（上游 `QdrantConnectionManager`）。 */
export class QdrantConnectionManager {
  private static instances = new Map<string, QdrantVectorStore>();

  /** 获取或创建 Qdrant 实例（单例；key=(url|"local", collection_name)）。 */
  public static getInstance(
    config: {
      url?: string | undefined;
      api_key?: string | undefined;
      collection_name?: string | undefined;
      vector_size?: number | undefined;
      distance?: string | undefined;
      timeout?: number | undefined;
    } = {}
  ): QdrantVectorStore {
    const key = `${config.url ?? 'local'}::${config.collection_name ?? 'hello_agents_vectors'}`;
    let instance = QdrantConnectionManager.instances.get(key);
    if (!instance) {
      instance = new QdrantVectorStore(config);
      QdrantConnectionManager.instances.set(key, instance);
    }
    return instance;
  }

  /** 测试辅助：清空单例注册表。 */
  public static resetForTesting(): void {
    QdrantConnectionManager.instances.clear();
  }
}
