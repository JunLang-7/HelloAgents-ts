/**
 * 数据库配置管理（上游 `core/database_config.py` 的教学版移植）。
 *
 * 管理 Qdrant 向量数据库与 Neo4j 图数据库的连接配置：
 * - `QdrantConfig` / `Neo4jConfig`：单后端配置（含 `fromEnv()` / `toDict()`）。
 * - `DatabaseConfig`：聚合两个后端，提供 `validateConnections()` 健康验证。
 * - `dbConfig` 单例 + `getDatabaseConfig()` / `updateDatabaseConfig()`。
 *
 * 环境变量与上游一致：
 * - Qdrant: `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION`,
 *   `QDRANT_VECTOR_SIZE`, `QDRANT_DISTANCE`, `QDRANT_TIMEOUT`
 * - Neo4j: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`,
 *   `NEO4J_MAX_CONNECTION_LIFETIME`, `NEO4J_MAX_CONNECTION_POOL_SIZE`,
 *   `NEO4J_CONNECTION_TIMEOUT`
 *
 * 与上游差异（DIFF 登记见 docs/upstream-differences.md）：
 * - pydantic BaseModel 由普通类替代；`model_dump` → `toDict()`。
 * - `validate_connections` 采用动态 import，保证基础入口不加载重型存储依赖。
 */

export interface QdrantConfigValues {
  url?: string | undefined;
  api_key?: string | undefined;
  collection_name: string;
  vector_size: number;
  distance: string;
  timeout: number;
}

export interface Neo4jConfigValues {
  uri: string;
  username: string;
  password: string;
  database: string;
  max_connection_lifetime: number;
  max_connection_pool_size: number;
  connection_acquisition_timeout: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Qdrant 向量数据库配置（上游 `QdrantConfig`）。 */
export class QdrantConfig {
  url?: string | undefined;
  api_key?: string | undefined;
  collection_name: string;
  vector_size: number;
  distance: string;
  timeout: number;

  public constructor(values: Partial<QdrantConfigValues> = {}) {
    this.url = values.url;
    this.api_key = values.api_key;
    this.collection_name = values.collection_name ?? 'hello_agents_vectors';
    this.vector_size = values.vector_size ?? 384;
    this.distance = values.distance ?? 'cosine';
    this.timeout = values.timeout ?? 30;
  }

  /** 从环境变量创建配置（上游 `QdrantConfig.from_env`）。 */
  public static fromEnv(): QdrantConfig {
    return new QdrantConfig({
      url: process.env.QDRANT_URL || undefined,
      api_key: process.env.QDRANT_API_KEY || undefined,
      collection_name: process.env.QDRANT_COLLECTION || 'hello_agents_vectors',
      vector_size: envInt('QDRANT_VECTOR_SIZE', 384),
      distance: process.env.QDRANT_DISTANCE || 'cosine',
      timeout: envInt('QDRANT_TIMEOUT', 30)
    });
  }

  /** 转换为字典，忽略未定义的 url/api_key（上游 `to_dict(exclude_none=True)`）。 */
  public toDict(): QdrantConfigValues {
    const out: QdrantConfigValues = {
      collection_name: this.collection_name,
      vector_size: this.vector_size,
      distance: this.distance,
      timeout: this.timeout
    };
    if (this.url !== undefined) out.url = this.url;
    if (this.api_key !== undefined) out.api_key = this.api_key;
    return out;
  }
}

/** Neo4j 图数据库配置（上游 `Neo4jConfig`）。 */
export class Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
  max_connection_lifetime: number;
  max_connection_pool_size: number;
  connection_acquisition_timeout: number;

  public constructor(values: Partial<Neo4jConfigValues> = {}) {
    this.uri = values.uri ?? 'bolt://localhost:7687';
    this.username = values.username ?? 'neo4j';
    this.password = values.password ?? 'hello-agents-password';
    this.database = values.database ?? 'neo4j';
    this.max_connection_lifetime = values.max_connection_lifetime ?? 3600;
    this.max_connection_pool_size = values.max_connection_pool_size ?? 50;
    this.connection_acquisition_timeout = values.connection_acquisition_timeout ?? 60;
  }

  /** 从环境变量创建配置（上游 `Neo4jConfig.from_env`）。 */
  public static fromEnv(): Neo4jConfig {
    return new Neo4jConfig({
      uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
      username: process.env.NEO4J_USERNAME || 'neo4j',
      password: process.env.NEO4J_PASSWORD || 'hello-agents-password',
      database: process.env.NEO4J_DATABASE || 'neo4j',
      max_connection_lifetime: envInt('NEO4J_MAX_CONNECTION_LIFETIME', 3600),
      max_connection_pool_size: envInt('NEO4J_MAX_CONNECTION_POOL_SIZE', 50),
      connection_acquisition_timeout: envInt('NEO4J_CONNECTION_TIMEOUT', 60)
    });
  }

  /** 转换为字典（上游 `to_dict()`）。 */
  public toDict(): Neo4jConfigValues {
    return {
      uri: this.uri,
      username: this.username,
      password: this.password,
      database: this.database,
      max_connection_lifetime: this.max_connection_lifetime,
      max_connection_pool_size: this.max_connection_pool_size,
      connection_acquisition_timeout: this.connection_acquisition_timeout
    };
  }
}

/** 数据库配置聚合（上游 `DatabaseConfig`）。 */
export class DatabaseConfig {
  qdrant: QdrantConfig;
  neo4j: Neo4jConfig;

  public constructor(
    values: { qdrant?: QdrantConfig | undefined; neo4j?: Neo4jConfig | undefined } = {}
  ) {
    this.qdrant = values.qdrant ?? new QdrantConfig();
    this.neo4j = values.neo4j ?? new Neo4jConfig();
  }

  /** 从环境变量创建配置（上游 `DatabaseConfig.from_env`）。 */
  public static fromEnv(): DatabaseConfig {
    return new DatabaseConfig({ qdrant: QdrantConfig.fromEnv(), neo4j: Neo4jConfig.fromEnv() });
  }

  /** 获取 Qdrant 配置字典（上游 `get_qdrant_config`）。 */
  public getQdrantConfig(): QdrantConfigValues {
    return this.qdrant.toDict();
  }

  /** 获取 Neo4j 配置字典（上游 `get_neo4j_config`）。 */
  public getNeo4jConfig(): Neo4jConfigValues {
    return this.neo4j.toDict();
  }

  /**
   * 验证数据库连接配置（上游 `validate_connections`）。
   *
   * 惰性加载存储实现，避免基础入口拉入重型依赖。任一后端不可用（服务未启动、
   * 客户端未安装等）只将该后端标记为 false，不抛出。
   */
  public async validateConnections(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    try {
      const { QdrantVectorStore } = await import('../memory/storage/qdrant-store.js');
      const store = new QdrantVectorStore(this.getQdrantConfig());
      results.qdrant = await store.healthCheck();
    } catch {
      results.qdrant = false;
    }
    try {
      const { Neo4jGraphStore } = await import('../memory/storage/neo4j-store.js');
      const store = new Neo4jGraphStore(this.getNeo4jConfig());
      results.neo4j = await store.healthCheck();
    } catch {
      results.neo4j = false;
    }
    return results;
  }
}

/** 全局配置实例（上游 `db_config = DatabaseConfig.from_env()`）。 */
export const dbConfig: DatabaseConfig = DatabaseConfig.fromEnv();

/** 获取数据库配置（上游 `get_database_config`）。 */
export function getDatabaseConfig(): DatabaseConfig {
  return dbConfig;
}

/**
 * 更新数据库配置（上游 `update_database_config`）。
 *
 * 接受 `{ qdrant?: Partial<QdrantConfigValues>, neo4j?: Partial<Neo4jConfigValues> }`，
 * 与上游 `QdrantConfig(**kwargs)` / `Neo4jConfig(**kwargs)` 重建语义一致。
 */
export function updateDatabaseConfig(kwargs: {
  qdrant?: Partial<QdrantConfigValues> | undefined;
  neo4j?: Partial<Neo4jConfigValues> | undefined;
}): void {
  if (kwargs.qdrant !== undefined) {
    dbConfig.qdrant = new QdrantConfig(kwargs.qdrant);
  }
  if (kwargs.neo4j !== undefined) {
    dbConfig.neo4j = new Neo4jConfig(kwargs.neo4j);
  }
}
