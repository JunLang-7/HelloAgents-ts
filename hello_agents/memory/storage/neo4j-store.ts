/**
 * Neo4j 图数据库存储实现（上游 `memory/storage/neo4j_store.py` 的教学版移植）。
 *
 * `Neo4jGraphStore` 公开 addEntity / addRelationship / findRelatedEntities /
 * searchEntitiesByName / getEntityRelationships / deleteEntity / clearAll /
 * getStats / healthCheck，Cypher 与上游逐一对应。
 *
 * 依赖与差异（docs/upstream-differences.md）：
 * - DIFF-023：客户端为 `neo4j-driver`（按需加载，重依赖不进入包依赖）；
 *   连接池配置（max_connection_lifetime / max_connection_pool_size /
 *   connection_acquisition_timeout）与上游一一对应。
 * - DIFF-025：neo4j-driver 6.x 的 `session.run` 返回 thenable Result（无
 *   single/records 方法），改用推荐 API `driver.executeQuery`；删除计数用
 *   `DETACH DELETE ... RETURN count(n)` 替代私有 `counters.nodes_deleted`。
 * - 上游 `logger.info/warning/debug` 输出在 TS 侧省略，语义由返回值与错误消息承载。
 */

import type { GraphStorePort } from '../ports.js';

// GraphStorePort 为 memory types 的同步端口（#73）；Neo4jGraphStore 为异步
// 网络后端（DIFF-024），两者不直接兼容。类型导入仅用于文档对照说明。
export type { GraphStorePort };

// ---------------------------------------------------------------------------
// 驱动加载（按需）
// ---------------------------------------------------------------------------

interface Neo4jRecordLike {
  get(key: string): unknown;
}

interface Neo4jExecuteResultLike {
  records: Neo4jRecordLike[];
}

interface Neo4jDriverLike {
  verifyConnectivity(): Promise<void>;
  close(): void;
  executeQuery(
    query: string,
    params?: Record<string, unknown>,
    config?: { database?: string }
  ): Promise<Neo4jExecuteResultLike>;
}

export interface Neo4jDriverModule {
  driver(
    uri: string,
    auth: { type: string; principal: string; credentials: string },
    config?: Record<string, unknown>
  ): Neo4jDriverLike;
  auth: {
    basic(
      principal: string,
      credentials: string
    ): { type: string; principal: string; credentials: string };
  };
  /** 把 JS number 显式包装为 Neo4j Integer（DIFF-027：bun 下 number 参数会序列化为 float）。 */
  int(value: number): { toNumber(): number; toString(): string };
}

let _neo4jLoaded = false;
let _neo4jAvailable = false;
let _neo4jModule: Neo4jDriverModule | null = null;

/** 按需加载 neo4j-driver；未安装时给出安装指引。 */
export async function loadNeo4jDriver(): Promise<Neo4jDriverModule> {
  if (!_neo4jLoaded) {
    try {
      const mod = (await import('neo4j-driver')) as { default?: unknown };
      // neo4j-driver 6.x 默认导出 { driver, auth, ... }
      _neo4jModule = (mod.default ?? mod) as Neo4jDriverModule;
      _neo4jAvailable = true;
    } catch {
      _neo4jAvailable = false;
    }
    _neo4jLoaded = true;
  }
  if (!_neo4jAvailable || _neo4jModule === null) {
    throw new Error('neo4j 未安装。请运行: bun add neo4j-driver');
  }
  return _neo4jModule;
}

/** Neo4j Integer 值统一转 number（避免 Number(Integer) 丢失精度/NaN）。 */
function toNumberValue(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return value;
}

/** 最小记录/值工具：把 Neo4j 值对象转为可序列化的普通数据。 */
function nodeData(node: unknown): Record<string, unknown> {
  if (node === null || node === undefined) return {};
  if (typeof node === 'object' && 'properties' in (node as Record<string, unknown>)) {
    return normalizeProperties((node as { properties: Record<string, unknown> }).properties);
  }
  if (typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = normalizeValue(value);
    }
    return out;
  }
  return { value: node };
}

/** 递归把 Neo4j 值（节点/关系/数组/Integer）转为普通数据。 */
function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  const numeric = toNumberValue(value);
  if (numeric !== value) return numeric;
  const obj = value as Record<string, unknown>;
  if ('properties' in obj) return nodeData(value);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) out[key] = normalizeValue(v);
  return out;
}

/** 属性对象内的值同样归一化。 */
function normalizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) out[key] = normalizeValue(value);
  return out;
}

// ---------------------------------------------------------------------------
// Neo4jGraphStore
// ---------------------------------------------------------------------------

/** Neo4j 图数据库存储实现（上游 `Neo4jGraphStore`）。 */
export class Neo4jGraphStore {
  public readonly uri: string;
  public readonly username: string;
  public readonly password: string;
  public readonly database: string;
  public readonly maxConnectionLifetime: number;
  public readonly maxConnectionPoolSize: number;
  public readonly connectionAcquisitionTimeout: number;
  private driver: Neo4jDriverLike | null = null;
  private int: ((value: number) => { toNumber(): number; toString(): string }) | null = null;

  public constructor(
    config: {
      uri?: string | undefined;
      username?: string | undefined;
      password?: string | undefined;
      database?: string | undefined;
      max_connection_lifetime?: number | undefined;
      max_connection_pool_size?: number | undefined;
      connection_acquisition_timeout?: number | undefined;
    } = {}
  ) {
    this.uri = config.uri ?? 'bolt://localhost:7687';
    this.username = config.username ?? 'neo4j';
    this.password = config.password ?? 'hello-agents-password';
    this.database = config.database ?? 'neo4j';
    this.maxConnectionLifetime = config.max_connection_lifetime ?? 3600;
    this.maxConnectionPoolSize = config.max_connection_pool_size ?? 50;
    this.connectionAcquisitionTimeout = config.connection_acquisition_timeout ?? 60;
    // 构造后需 await ensureInitialized()（上游构造即连接）
  }

  /** 初始化驱动、验证连接并创建索引（上游 `_initialize_driver` + `_create_indexes`）。 */
  public async ensureInitialized(): Promise<void> {
    if (this.driver !== null) return;
    const neo4j = await loadNeo4jDriver();
    try {
      // DIFF-027：neo4j-driver 的时长参数单位为毫秒；上游 Python 为秒，此处换算。
      const driver = neo4j.driver(this.uri, neo4j.auth.basic(this.username, this.password), {
        maxConnectionLifetime: this.maxConnectionLifetime * 1000,
        maxConnectionPoolSize: this.maxConnectionPoolSize,
        connectionAcquisitionTimeout: this.connectionAcquisitionTimeout * 1000
      });
      await driver.verifyConnectivity();
      this.driver = driver;
      this.int = neo4j.int.bind(neo4j);
    } catch (cause) {
      const hint = this.uri.includes('localhost')
        ? '本地连接失败，可考虑 Neo4j Aura 云服务，或启动本地服务: docker run -p 7474:7474 -p 7687:7687 neo4j:5.14'
        : '请检查 NEO4J_URI 和网络连接';
      throw new Error(`Neo4j 连接失败: ${hint}`, { cause });
    }
    await this._createIndexes();
  }

  private async _createIndexes(): Promise<void> {
    const indexes = [
      'CREATE INDEX entity_id_index IF NOT EXISTS FOR (e:Entity) ON (e.id)',
      'CREATE INDEX entity_name_index IF NOT EXISTS FOR (e:Entity) ON (e.name)',
      'CREATE INDEX entity_type_index IF NOT EXISTS FOR (e:Entity) ON (e.type)',
      'CREATE INDEX memory_id_index IF NOT EXISTS FOR (m:Memory) ON (m.id)',
      'CREATE INDEX memory_type_index IF NOT EXISTS FOR (m:Memory) ON (m.memory_type)',
      'CREATE INDEX memory_timestamp_index IF NOT EXISTS FOR (m:Memory) ON (m.timestamp)'
    ];
    for (const query of indexes) {
      try {
        await this.driver!.executeQuery(query, {}, { database: this.database });
      } catch {
        // 索引已存在则跳过（等价上游 debug 日志）
      }
    }
  }

  /** 添加实体节点（上游 `add_entity`）。 */
  public async addEntity(request: {
    entity_id: string;
    name: string;
    entity_type: string;
    properties?: Record<string, unknown> | undefined;
  }): Promise<boolean> {
    await this.ensureInitialized();
    const props = {
      ...(request.properties ?? {}),
      id: request.entity_id,
      name: request.name,
      type: request.entity_type,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const result = await this.driver!.executeQuery(
      'MERGE (e:Entity {id: $entity_id}) SET e += $properties RETURN e',
      { entity_id: request.entity_id, properties: props },
      { database: this.database }
    );
    return result.records.length > 0;
  }

  /** 添加实体间关系（上游 `add_relationship`）。 */
  public async addRelationship(request: {
    from_entity_id: string;
    to_entity_id: string;
    relationship_type: string;
    properties?: Record<string, unknown> | undefined;
  }): Promise<boolean> {
    await this.ensureInitialized();
    const props = {
      ...(request.properties ?? {}),
      type: request.relationship_type,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const query = `MATCH (from:Entity {id: $from_id})
      MATCH (to:Entity {id: $to_id})
      MERGE (from)-[r:${request.relationship_type}]->(to)
      SET r += $properties
      RETURN r`;
    const result = await this.driver!.executeQuery(
      query,
      { from_id: request.from_entity_id, to_id: request.to_entity_id, properties: props },
      { database: this.database }
    );
    return result.records.length > 0;
  }

  /** 查找相关实体（上游 `find_related_entities`）。 */
  public async findRelatedEntities(request: {
    entity_id: string;
    relationship_types?: string[] | undefined;
    max_depth?: number | undefined;
    limit?: number | undefined;
  }): Promise<Array<Record<string, unknown>>> {
    await this.ensureInitialized();
    const relFilter =
      request.relationship_types && request.relationship_types.length > 0
        ? `:${request.relationship_types.join('|')}`
        : '';
    const maxDepth = request.max_depth ?? 2;
    const limit = request.limit ?? 50;
    const query = `MATCH path = (start:Entity {id: $entity_id})-[r${relFilter}*1..${maxDepth}]-(related:Entity)
      WHERE start.id <> related.id
      RETURN DISTINCT related,
             length(path) as distance,
             [rel in relationships(path) | type(rel)] as relationship_path
      ORDER BY distance, related.name
      LIMIT $limit`;
    const result = await this.driver!.executeQuery(
      query,
      // DIFF-027：limit 显式包装为 Integer，避免 bun 下序列化为 float 导致 LIMIT 报错
      { entity_id: request.entity_id, limit: this.int!(limit) },
      { database: this.database }
    );
    return result.records.map((record) => {
      const entityData = nodeData(record.get('related'));
      entityData.distance = toNumberValue(record.get('distance'));
      entityData.relationship_path = normalizeValue(record.get('relationship_path'));
      return entityData;
    });
  }

  /** 按名称搜索实体（上游 `search_entities_by_name`）。 */
  public async searchEntitiesByName(request: {
    name_pattern: string;
    entity_types?: string[] | undefined;
    limit?: number | undefined;
  }): Promise<Array<Record<string, unknown>>> {
    await this.ensureInitialized();
    const params: Record<string, unknown> = {
      pattern: `.*${request.name_pattern}.*`,
      // DIFF-027：同 findRelatedEntities
      limit: this.int!(request.limit ?? 20)
    };
    const typeFilter =
      request.entity_types && request.entity_types.length > 0 ? 'AND e.type IN $types' : '';
    if (request.entity_types && request.entity_types.length > 0) {
      params.types = request.entity_types;
    }
    const query = `MATCH (e:Entity)
      WHERE e.name =~ $pattern ${typeFilter}
      RETURN e
      ORDER BY e.name
      LIMIT $limit`;
    const result = await this.driver!.executeQuery(query, params, { database: this.database });
    return result.records.map((record) => nodeData(record.get('e')));
  }

  /** 获取实体的所有关系（上游 `get_entity_relationships`）。 */
  public async getEntityRelationships(entityId: string): Promise<Array<Record<string, unknown>>> {
    await this.ensureInitialized();
    const query = `MATCH (e:Entity {id: $entity_id})-[r]-(other:Entity)
      RETURN r, other,
             CASE WHEN startNode(r).id = $entity_id THEN 'outgoing' ELSE 'incoming' END as direction`;
    const result = await this.driver!.executeQuery(
      query,
      { entity_id: entityId },
      { database: this.database }
    );
    return result.records.map((record) => ({
      relationship: normalizeValue(record.get('r')),
      other_entity: nodeData(record.get('other')),
      direction: record.get('direction')
    }));
  }

  /**
   * 删除实体及其所有关系（上游 `delete_entity`）。
   * DIFF-025：用 `DETACH DELETE ... RETURN count(n)` 返回删除数（存在 1 / 不存在 0）。
   */
  public async deleteEntity(entityId: string): Promise<boolean> {
    await this.ensureInitialized();
    const result = await this.driver!.executeQuery(
      'MATCH (e:Entity {id: $entity_id}) DETACH DELETE e RETURN count(e) as deleted',
      { entity_id: entityId },
      { database: this.database }
    );
    const record = result.records[0];
    if (!record) return false;
    return Number(toNumberValue(record.get('deleted'))) > 0;
  }

  /** 清空所有数据（上游 `clear_all`）。 */
  public async clearAll(): Promise<boolean> {
    await this.ensureInitialized();
    await this.driver!.executeQuery('MATCH (n) DETACH DELETE n', {}, { database: this.database });
    return true;
  }

  /** 获取图数据库统计信息（上游 `get_stats`）。 */
  public async getStats(): Promise<Record<string, unknown>> {
    await this.ensureInitialized();
    const queries: Array<[string, string]> = [
      ['total_nodes', 'MATCH (n) RETURN count(n) as count'],
      ['total_relationships', 'MATCH ()-[r]->() RETURN count(r) as count'],
      ['entity_nodes', 'MATCH (n:Entity) RETURN count(n) as count'],
      ['memory_nodes', 'MATCH (n:Memory) RETURN count(n) as count']
    ];
    const stats: Record<string, unknown> = {};
    for (const [key, query] of queries) {
      const result = await this.driver!.executeQuery(query, {}, { database: this.database });
      const record = result.records[0];
      stats[key] = record ? toNumberValue(record.get('count')) : 0;
    }
    return stats;
  }

  /** 健康检查（上游 `health_check`）。 */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const result = await this.driver!.executeQuery(
        'RETURN 1 as health',
        {},
        { database: this.database }
      );
      const record = result.records[0];
      return record !== undefined && Number(toNumberValue(record.get('health'))) === 1;
    } catch {
      return false;
    }
  }

  /** 关闭驱动（上游 `__del__`）。 */
  public close(): void {
    if (this.driver !== null) {
      this.driver.close();
      this.driver = null;
    }
  }
}
