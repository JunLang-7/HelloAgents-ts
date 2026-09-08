/**
 * 语义记忆实现（上游 `memory/types/semantic.py` 的教学版移植）。
 *
 * 向量检索（Qdrant）与知识图谱（Neo4j）后端由 #84 通过构造参数注入；
 * spaCy 实体识别属于可选重依赖，上游在模型缺失时实体提取返回空数组，
 * 本移植固定走该降级分支（规则 NER 不做伪装实现）。无后端时：
 * - add 仍写入内存缓存与实体/关系元数据（上游在后端初始化失败时会直接
 *   抛错，TS 离线降级差异已在 PR 兼容清单登记）；
 * - retrieve 的向量/图候选均为空，返回空数组（与上游后端不可用时一致）。
 *
 * 兼容修复（PR 差异清单登记）：上游 update/remove 的成功返回值被嵌套在
 * 内层条件块中，仅更新内容或缺少嵌入时会错误返回 False；这里按意图返回。
 */
import { BaseMemory, MemoryConfig, MemoryItem, type RetrieveOptions } from '../base.js';
import type {
  AsyncMemoryBackends,
  AsyncGraphStorePort,
  GraphStorePort,
  MemoryBackends,
  VectorSearchHit
} from '../ports.js';

/** 知识图谱实体（PERSON/ORG/PRODUCT/SKILL/CONCEPT/MISC 等）。 */
export class Entity {
  public entityId: string;
  public name: string;
  public entityType: string;
  public description: string;
  public properties: Record<string, unknown>;
  public createdAt: Date;
  public updatedAt: Date;
  public frequency: number;

  public constructor(
    entityId: string,
    name: string,
    entityType = 'MISC',
    description = '',
    properties: Record<string, unknown> = {}
  ) {
    this.entityId = entityId;
    this.name = name;
    this.entityType = entityType;
    this.description = description;
    this.properties = { ...properties };
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.frequency = 1;
  }

  public toDict(): Record<string, unknown> {
    return {
      entity_id: this.entityId,
      name: this.name,
      entity_type: this.entityType,
      description: this.description,
      properties: this.properties,
      frequency: this.frequency
    };
  }
  public to_dict(): Record<string, unknown> {
    return this.toDict();
  }
}

/** 实体间关系。 */
export class Relation {
  public fromEntity: string;
  public toEntity: string;
  public relationType: string;
  public strength: number;
  public evidence: string;
  public properties: Record<string, unknown>;
  public createdAt: Date;
  public frequency: number;

  public constructor(
    fromEntity: string,
    toEntity: string,
    relationType: string,
    strength = 1,
    evidence = '',
    properties: Record<string, unknown> = {}
  ) {
    this.fromEntity = fromEntity;
    this.toEntity = toEntity;
    this.relationType = relationType;
    this.strength = strength;
    this.evidence = evidence;
    this.properties = { ...properties };
    this.createdAt = new Date();
    this.frequency = 1;
  }

  public toDict(): Record<string, unknown> {
    return {
      from_entity: this.fromEntity,
      to_entity: this.toEntity,
      relation_type: this.relationType,
      strength: this.strength,
      evidence: this.evidence,
      properties: this.properties,
      frequency: this.frequency
    };
  }
  public to_dict(): Record<string, unknown> {
    return this.toDict();
  }
}

interface CombinedResult {
  memory_id: string;
  content: string;
  user_id?: string;
  memory_type?: string;
  importance: number;
  timestamp?: number | string;
  metadata: Record<string, unknown>;
  vector_score: number;
  graph_score: number;
  combined_score: number;
  [key: string]: unknown;
}

/** 结合向量检索与知识图谱的混合语义记忆。 */
export class SemanticMemory extends BaseMemory {
  public entities: Map<string, Entity>;
  public relations: Relation[];
  public semanticMemories: MemoryItem[];
  public memoryEmbeddings: Map<string, number[]>;

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
    super(config, 'semantic', resolved, undefined, resolvedAsync);
    this.entities = new Map();
    this.relations = [];
    this.semanticMemories = [];
    this.memoryEmbeddings = new Map();
  }

  public add(memoryItem: MemoryItem): string {
    const embedding = this.backends.embedder?.encode(memoryItem.content);
    if (embedding) this.memoryEmbeddings.set(memoryItem.id, embedding);

    const entities = this.extractEntities(memoryItem.content);
    const relations = this.extractRelations(memoryItem.content, entities);
    for (const entity of entities) this.addEntityToGraph(entity, memoryItem);
    for (const relation of relations) this.addRelationToGraph(relation, memoryItem);

    if (embedding && this.backends.vectorStore) {
      this.backends.vectorStore.addVectors({
        vectors: [embedding],
        metadata: [
          {
            memory_id: memoryItem.id,
            user_id: memoryItem.userId,
            content: memoryItem.content,
            memory_type: memoryItem.memoryType,
            timestamp: Math.floor(memoryItem.timestamp.getTime() / 1000),
            importance: memoryItem.importance,
            entities: entities.map((entity) => entity.entityId),
            entity_count: entities.length,
            relation_count: relations.length
          }
        ],
        ids: [memoryItem.id]
      });
    }

    memoryItem.metadata.entities = entities.map((entity) => entity.entityId);
    memoryItem.metadata.relations = relations.map(
      (relation) => `${relation.fromEntity}-${relation.relationType}-${relation.toEntity}`
    );
    this.semanticMemories.push(memoryItem);
    return memoryItem.id;
  }

  /** Async write path for real Qdrant + Neo4j backends. */
  public async addAsync(memoryItem: MemoryItem): Promise<string> {
    const vectorStore = this.asyncBackends.vectorStore;
    const graphStore = this.asyncBackends.graphStore;
    if (!vectorStore && !graphStore) return this.add(memoryItem);

    let embedding: number[] | undefined;
    try {
      embedding = await this.encodeAsync(memoryItem.content);
      this.memoryEmbeddings.set(memoryItem.id, embedding);
    } catch {
      // Embedding is optional when only the graph backend is configured.
    }
    const entities = this.extractEntities(memoryItem.content);
    const relations = this.extractRelations(memoryItem.content, entities);
    for (const entity of entities) await this.addEntityToGraphAsync(entity, memoryItem, graphStore);
    for (const relation of relations)
      await this.addRelationToGraphAsync(relation, memoryItem, graphStore);

    if (embedding && vectorStore) {
      try {
        await vectorStore.addVectors({
          vectors: [embedding],
          metadata: [
            {
              memory_id: memoryItem.id,
              user_id: memoryItem.userId,
              content: memoryItem.content,
              memory_type: memoryItem.memoryType,
              timestamp: Math.floor(memoryItem.timestamp.getTime() / 1000),
              importance: memoryItem.importance,
              entities: entities.map((entity) => entity.entityId),
              entity_count: entities.length,
              relation_count: relations.length
            }
          ],
          ids: [memoryItem.id]
        });
      } catch {
        // Keep memory cache usable if the optional vector write fails.
      }
    }
    memoryItem.metadata.entities = entities.map((entity) => entity.entityId);
    memoryItem.metadata.relations = relations.map(
      (relation) => `${relation.fromEntity}-${relation.relationType}-${relation.toEntity}`
    );
    this.semanticMemories.push(memoryItem);
    return memoryItem.id;
  }

  public retrieve(query: string, limit = 5, options: RetrieveOptions = {}): MemoryItem[] {
    try {
      const userId = typeof options.userId === 'string' ? options.userId : undefined;
      const vectorResults = this.vectorSearch(query, limit * 2, userId);
      const graphResults = this.graphSearch(query, limit * 2, userId);
      const combined = this.combineAndRank(vectorResults, graphResults, limit);

      const scores = combined.map((result) => result.combined_score);
      let probabilities: number[] = [];
      if (scores.length > 0) {
        const maxScore = Math.max(...scores);
        const exps = scores.map((score) => Math.exp(score - maxScore));
        const denom = exps.reduce((sum, value) => sum + value, 0) || 1;
        probabilities = exps.map((value) => value / denom);
      }

      const resultMemories: MemoryItem[] = [];
      combined.forEach((result, index) => {
        const memory = this.semanticMemories.find((item) => item.id === result.memory_id);
        if (memory && memory.metadata.forgotten === true) return;
        let timestamp = new Date();
        if (typeof result.timestamp === 'string') {
          const parsed = new Date(result.timestamp);
          if (!Number.isNaN(parsed.getTime())) timestamp = parsed;
        } else if (typeof result.timestamp === 'number') {
          timestamp = new Date(result.timestamp * 1000);
        }
        resultMemories.push(
          new MemoryItem({
            id: result.memory_id,
            content: result.content,
            memoryType: 'semantic',
            userId: result.user_id ?? 'default',
            timestamp,
            importance: result.importance,
            metadata: {
              ...result.metadata,
              combined_score: result.combined_score,
              vector_score: result.vector_score,
              graph_score: result.graph_score,
              probability: probabilities[index] ?? 0
            }
          })
        );
      });
      return resultMemories.slice(0, limit);
    } catch {
      return [];
    }
  }

  /** Async hybrid retrieval path for Promise-based vector and graph stores. */
  public async retrieveAsync(
    query: string,
    limit = 5,
    options: RetrieveOptions = {}
  ): Promise<MemoryItem[]> {
    if (!this.asyncBackends.vectorStore && !this.asyncBackends.graphStore)
      return this.retrieve(query, limit, options);
    const userId = typeof options.userId === 'string' ? options.userId : undefined;
    const [vectorResults, graphResults] = await Promise.all([
      this.vectorSearchAsync(query, limit * 2, userId),
      this.graphSearchAsync(query, limit * 2, userId)
    ]);
    const combined = this.combineAndRank(vectorResults, graphResults, limit);
    const scores = combined.map((result) => result.combined_score);
    const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
    const exps = scores.map((score) => Math.exp(score - maxScore));
    const denom = exps.reduce((sum, value) => sum + value, 0) || 1;
    return combined
      .map((result, index) => {
        const timestamp =
          typeof result.timestamp === 'string'
            ? new Date(result.timestamp)
            : typeof result.timestamp === 'number'
              ? new Date(result.timestamp * 1000)
              : new Date();
        return new MemoryItem({
          id: result.memory_id,
          content: result.content,
          memoryType: 'semantic',
          userId: result.user_id ?? 'default',
          timestamp,
          importance: result.importance,
          metadata: {
            ...result.metadata,
            combined_score: result.combined_score,
            vector_score: result.vector_score,
            graph_score: result.graph_score,
            probability: (exps[index] ?? 0) / denom
          }
        });
      })
      .filter((memory) => memory.metadata.forgotten !== true)
      .slice(0, limit);
  }

  private async encodeAsync(text: string): Promise<number[]> {
    if (this.asyncBackends.embedder) return this.asyncBackends.embedder.encode(text);
    const sync = this.backends.embedder?.encode(text);
    if (sync) return sync;
    throw new Error('Async memory backend requires an embedder');
  }

  private async vectorSearchAsync(
    query: string,
    limit: number,
    userId?: string
  ): Promise<Array<Record<string, unknown>>> {
    const store = this.asyncBackends.vectorStore;
    if (!store) return this.vectorSearch(query, limit, userId);
    try {
      const where: Record<string, unknown> = { memory_type: 'semantic' };
      if (userId) where.user_id = userId;
      const results = await store.searchSimilar({
        queryVector: await this.encodeAsync(query),
        limit,
        where
      });
      return results.map((result: VectorSearchHit) => ({
        id: result.id,
        memory_id: result.metadata.memory_id ?? result.id,
        score: result.score,
        ...result.metadata
      }));
    } catch {
      return [];
    }
  }

  private async graphSearchAsync(
    query: string,
    limit: number,
    userId?: string
  ): Promise<Array<Record<string, unknown>>> {
    const graphStore = this.asyncBackends.graphStore;
    if (!graphStore) return this.graphSearch(query, limit, userId);
    try {
      let queryEntities = this.extractEntities(query);
      if (queryEntities.length === 0) {
        const byName = await graphStore.searchEntitiesByName({ name_pattern: query, limit: 10 });
        queryEntities = byName
          .slice(0, 3)
          .map(
            (entry) =>
              new Entity(
                String(entry.id ?? ''),
                String(entry.name ?? ''),
                String(entry.type ?? 'MISC')
              )
          );
      }
      const relatedMemoryIds = new Set<string>();
      for (const entity of queryEntities) {
        const related = await graphStore.findRelatedEntities({
          entity_id: entity.entityId,
          max_depth: 2,
          limit: 20
        });
        for (const row of related)
          if ('memory_id' in row) relatedMemoryIds.add(String(row.memory_id));
        const relationships = await graphStore.getEntityRelationships(entity.entityId);
        for (const row of relationships) {
          const relationship = row.relationship as Record<string, unknown> | undefined;
          if (relationship && 'memory_id' in relationship)
            relatedMemoryIds.add(String(relationship.memory_id));
        }
      }
      const results: Array<Record<string, unknown>> = [];
      for (const memoryId of [...relatedMemoryIds].slice(0, limit * 2)) {
        const memory = this.findMemoryById(memoryId);
        if (!memory || (userId && memory.userId !== userId)) continue;
        const metadata = {
          content: memory.content,
          user_id: memory.userId,
          memory_type: memory.memoryType,
          importance: memory.importance,
          timestamp: Math.floor(memory.timestamp.getTime() / 1000),
          entities: (memory.metadata.entities as string[]) ?? []
        };
        const score = this.calculateGraphRelevance(metadata, queryEntities);
        results.push({
          id: memoryId,
          memory_id: memoryId,
          content: metadata.content,
          similarity: score,
          user_id: metadata.user_id,
          memory_type: metadata.memory_type,
          importance: metadata.importance,
          timestamp: metadata.timestamp,
          entities: metadata.entities
        });
      }
      return results
        .sort((a, b) => (b.similarity as number) - (a.similarity as number))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  private vectorSearch(
    query: string,
    limit: number,
    userId?: string
  ): Array<Record<string, unknown>> {
    try {
      const embedder = this.backends.embedder;
      const vectorStore = this.backends.vectorStore;
      if (!embedder || !vectorStore) return [];
      const where: Record<string, unknown> = { memory_type: 'semantic' };
      if (userId) where.user_id = userId;
      const results = vectorStore.searchSimilar({
        queryVector: embedder.encode(query),
        limit,
        where
      });
      return results.map((result: VectorSearchHit) => ({
        id: result.id,
        memory_id: result.metadata.memory_id ?? result.id,
        score: result.score,
        ...result.metadata
      }));
    } catch {
      return [];
    }
  }

  private graphSearch(
    query: string,
    limit: number,
    userId?: string
  ): Array<Record<string, unknown>> {
    try {
      const graphStore = this.backends.graphStore;
      if (!graphStore) return [];
      let queryEntities = this.extractEntities(query);
      if (queryEntities.length === 0) {
        const byName = graphStore.searchEntitiesByName({ name_pattern: query, limit: 10 });
        if (byName.length > 0) {
          queryEntities = byName
            .slice(0, 3)
            .map(
              (entry) =>
                new Entity(
                  String(entry.id ?? ''),
                  String(entry.name ?? ''),
                  String(entry.type ?? 'MISC')
                )
            );
        } else {
          return [];
        }
      }

      const relatedMemoryIds = new Set<string>();
      for (const entity of queryEntities) {
        try {
          const related = graphStore.findRelatedEntities({
            entity_id: entity.entityId,
            max_depth: 2,
            limit: 20
          });
          for (const relEntity of related) {
            if ('memory_id' in relEntity) relatedMemoryIds.add(String(relEntity.memory_id));
          }
          const entityRels = graphStore.getEntityRelationships(entity.entityId);
          for (const rel of entityRels) {
            const relationship = rel.relationship as Record<string, unknown> | undefined;
            if (relationship && 'memory_id' in relationship)
              relatedMemoryIds.add(String(relationship.memory_id));
          }
        } catch {
          continue;
        }
      }

      const results: Array<Record<string, unknown>> = [];
      for (const memoryId of [...relatedMemoryIds].slice(0, limit * 2)) {
        try {
          const mem = this.findMemoryById(memoryId);
          if (!mem) continue;
          if (userId && mem.userId !== userId) continue;
          const metadata = {
            content: mem.content,
            user_id: mem.userId,
            memory_type: mem.memoryType,
            importance: mem.importance,
            timestamp: Math.floor(mem.timestamp.getTime() / 1000),
            entities: (mem.metadata.entities as string[]) ?? []
          };
          const graphScore = this.calculateGraphRelevance(metadata, queryEntities);
          results.push({
            id: memoryId,
            memory_id: memoryId,
            content: metadata.content,
            similarity: graphScore,
            user_id: metadata.user_id,
            memory_type: metadata.memory_type,
            importance: metadata.importance,
            timestamp: metadata.timestamp,
            entities: metadata.entities
          });
        } catch {
          continue;
        }
      }
      results.sort((a, b) => (b.similarity as number) - (a.similarity as number));
      return results.slice(0, limit);
    } catch {
      return [];
    }
  }

  private combineAndRank(
    vectorResults: Array<Record<string, unknown>>,
    graphResults: Array<Record<string, unknown>>,
    limit: number
  ): CombinedResult[] {
    const combined = new Map<string, CombinedResult>();
    const contentSeen = new Set<string>();

    for (const result of vectorResults) {
      const memoryId = String(result.memory_id ?? result.id);
      const content = String(result.content ?? '');
      const contentKey = content.trim();
      if (contentSeen.has(contentKey)) continue;
      contentSeen.add(contentKey);
      combined.set(memoryId, {
        ...(result as Record<string, never>),
        memory_id: memoryId,
        content,
        metadata: (result.metadata as Record<string, unknown>) ?? {},
        importance: (result.importance as number) ?? 0.5,
        vector_score: (result.score as number) ?? 0,
        graph_score: 0,
        combined_score: 0
      });
    }

    for (const result of graphResults) {
      const memoryId = String(result.memory_id ?? result.id);
      const content = String(result.content ?? '');
      const contentKey = content.trim();
      const existing = combined.get(memoryId);
      if (existing) {
        existing.graph_score = (result.similarity as number) ?? 0;
      } else if (!contentSeen.has(contentKey)) {
        contentSeen.add(contentKey);
        combined.set(memoryId, {
          ...(result as Record<string, never>),
          memory_id: memoryId,
          content,
          metadata: (result.metadata as Record<string, unknown>) ?? {},
          importance: (result.importance as number) ?? 0.5,
          vector_score: 0,
          graph_score: (result.similarity as number) ?? 0,
          combined_score: 0
        });
      }
    }

    for (const result of combined.values()) {
      const baseRelevance = result.vector_score * 0.7 + result.graph_score * 0.3;
      const importanceWeight = 0.8 + result.importance * 0.4;
      result.combined_score = baseRelevance * importanceWeight;
      result.debug_info = {
        base_relevance: baseRelevance,
        importance_weight: importanceWeight,
        combined_score: result.combined_score
      };
    }

    return [...combined.values()]
      .filter((result) => result.combined_score >= 0.1)
      .sort((a, b) => b.combined_score - a.combined_score)
      .slice(0, limit);
  }

  public detectLanguage(text: string): 'zh' | 'en' {
    let chineseChars = 0;
    for (const ch of text) if (ch >= '\u4e00' && ch <= '\u9fff') chineseChars += 1;
    const totalChars = text.replace(/ /g, '').length;
    if (totalChars === 0) return 'en';
    return chineseChars / totalChars > 0.3 ? 'zh' : 'en';
  }
  protected _detect_language(text: string): 'zh' | 'en' {
    return this.detectLanguage(text);
  }

  /**
   * 实体提取：上游在 spaCy 模型可用时做 NER，否则返回空数组。
   * TypeScript 教学线不引入 spaCy 等价重依赖，固定走空数组降级分支。
   */
  public extractEntities(text: string): Entity[] {
    // spaCy 模型未移植，固定走上游“模型不可用”降级分支：不产出实体。
    void text;
    return [];
  }
  protected _extract_entities(text: string): Entity[] {
    return this.extractEntities(text);
  }

  public extractRelations(text: string, entities: Entity[]): Relation[] {
    const relations: Relation[] = [];
    for (let i = 0; i < entities.length; i += 1) {
      for (let j = i + 1; j < entities.length; j += 1) {
        const from = entities[i];
        const to = entities[j];
        if (!from || !to) continue;
        relations.push(
          new Relation(from.entityId, to.entityId, 'CO_OCCURS', 0.5, text.slice(0, 100))
        );
      }
    }
    return relations;
  }
  protected _extract_relations(text: string, entities: Entity[]): Relation[] {
    return this.extractRelations(text, entities);
  }

  public addEntityToGraph(entity: Entity, memoryItem: MemoryItem): boolean {
    try {
      const properties = {
        name: entity.name,
        description: entity.description,
        frequency: entity.frequency,
        memory_id: memoryItem.id,
        user_id: memoryItem.userId,
        importance: memoryItem.importance,
        ...entity.properties
      };
      let success = true;
      if (this.backends.graphStore) {
        success = this.backends.graphStore.addEntity({
          entity_id: entity.entityId,
          name: entity.name,
          entity_type: entity.entityType,
          properties
        });
      }
      if (success) {
        const existing = this.entities.get(entity.entityId);
        if (existing) {
          existing.frequency += 1;
          existing.updatedAt = new Date();
        } else {
          this.entities.set(entity.entityId, entity);
        }
      }
      return success;
    } catch {
      return false;
    }
  }

  public addRelationToGraph(relation: Relation, memoryItem: MemoryItem): boolean {
    try {
      let success = true;
      if (this.backends.graphStore) {
        success = this.backends.graphStore.addRelationship({
          from_entity_id: relation.fromEntity,
          to_entity_id: relation.toEntity,
          relationship_type: relation.relationType,
          properties: {
            strength: relation.strength,
            memory_id: memoryItem.id,
            user_id: memoryItem.userId,
            importance: memoryItem.importance,
            evidence: relation.evidence
          }
        });
      }
      if (success) this.relations.push(relation);
      return success;
    } catch {
      return false;
    }
  }

  private async addEntityToGraphAsync(
    entity: Entity,
    memoryItem: MemoryItem,
    graphStore?: AsyncGraphStorePort
  ): Promise<boolean> {
    try {
      const properties = {
        name: entity.name,
        description: entity.description,
        frequency: entity.frequency,
        memory_id: memoryItem.id,
        user_id: memoryItem.userId,
        importance: memoryItem.importance,
        ...entity.properties
      };
      const success = graphStore
        ? await graphStore.addEntity({
            entity_id: entity.entityId,
            name: entity.name,
            entity_type: entity.entityType,
            properties
          })
        : true;
      if (success) this.addOrUpdateEntity(entity);
      return success;
    } catch {
      return false;
    }
  }

  private async addRelationToGraphAsync(
    relation: Relation,
    memoryItem: MemoryItem,
    graphStore?: AsyncGraphStorePort
  ): Promise<boolean> {
    try {
      const success = graphStore
        ? await graphStore.addRelationship({
            from_entity_id: relation.fromEntity,
            to_entity_id: relation.toEntity,
            relationship_type: relation.relationType,
            properties: {
              strength: relation.strength,
              memory_id: memoryItem.id,
              user_id: memoryItem.userId,
              importance: memoryItem.importance,
              evidence: relation.evidence
            }
          })
        : true;
      if (success) this.addOrUpdateRelation(relation);
      return success;
    } catch {
      return false;
    }
  }

  public calculateGraphRelevance(
    memoryMetadata: Record<string, unknown>,
    queryEntities: Entity[]
  ): number {
    try {
      const memoryEntities = (memoryMetadata.entities as string[]) ?? [];
      if (memoryEntities.length === 0 || queryEntities.length === 0) return 0;
      const queryIds = new Set(queryEntities.map((entity) => entity.entityId));
      let matching = 0;
      for (const id of memoryEntities) if (queryIds.has(id)) matching += 1;
      const entityScore = queryEntities.length > 0 ? matching / queryEntities.length : 0;
      const entityCount = (memoryMetadata.entity_count as number) ?? 0;
      const entityDensity = Math.min(entityCount / 10, 1);
      const relationCount = (memoryMetadata.relation_count as number) ?? 0;
      const relationDensity = Math.min(relationCount / 5, 1);
      return Math.min(entityScore * 0.6 + entityDensity * 0.2 + relationDensity * 0.2, 1);
    } catch {
      return 0;
    }
  }

  public addOrUpdateEntity(entity: Entity): void {
    const existing = this.entities.get(entity.entityId);
    if (existing) {
      existing.frequency += 1;
      existing.updatedAt = new Date();
    } else {
      this.entities.set(entity.entityId, entity);
    }
  }
  protected _add_or_update_entity(entity: Entity): void {
    this.addOrUpdateEntity(entity);
  }

  public addOrUpdateRelation(relation: Relation): void {
    const existing = this.relations.find(
      (item) =>
        item.fromEntity === relation.fromEntity &&
        item.toEntity === relation.toEntity &&
        item.relationType === relation.relationType
    );
    if (existing) {
      existing.frequency += 1;
      existing.strength = Math.min(1, existing.strength + 0.1);
    } else {
      this.relations.push(relation);
    }
  }
  protected _add_or_update_relation(relation: Relation): void {
    this.addOrUpdateRelation(relation);
  }

  public findMemoryById(memoryId: string): MemoryItem | undefined {
    return this.semanticMemories.find((memory) => memory.id === memoryId);
  }
  protected _find_memory_by_id(memoryId: string): MemoryItem | undefined {
    return this.findMemoryById(memoryId);
  }

  public update(
    memoryId: string,
    content?: string,
    importance?: number,
    metadata?: Record<string, unknown>
  ): boolean {
    const memory = this.findMemoryById(memoryId);
    if (!memory) return false;
    try {
      if (content !== undefined) {
        const embedding = this.backends.embedder?.encode(content);
        if (embedding) this.memoryEmbeddings.set(memoryId, embedding);
        const oldEntities = (memory.metadata.entities as string[]) ?? [];
        this.cleanupEntitiesAndRelations(oldEntities);
        memory.content = content;
        const entities = this.extractEntities(content);
        const relations = this.extractRelations(content, entities);
        for (const entity of entities) this.addOrUpdateEntity(entity);
        for (const relation of relations) this.addOrUpdateRelation(relation);
        memory.metadata.entities = entities.map((entity) => entity.entityId);
        memory.metadata.relations = relations.map(
          (relation) => `${relation.fromEntity}-${relation.relationType}-${relation.toEntity}`
        );
      }
      if (importance !== undefined) memory.importance = importance;
      if (metadata !== undefined) Object.assign(memory.metadata, metadata);
      return true;
    } catch {
      return false;
    }
  }

  public remove(memoryId: string): boolean {
    const memory = this.findMemoryById(memoryId);
    if (!memory) return false;
    try {
      this.backends.vectorStore?.deleteMemories([memoryId]);
      const entities = (memory.metadata.entities as string[]) ?? [];
      this.cleanupEntitiesAndRelations(entities);
      const index = this.semanticMemories.indexOf(memory);
      this.semanticMemories.splice(index, 1);
      this.memoryEmbeddings.delete(memoryId);
      return true;
    } catch {
      return false;
    }
  }

  public cleanupEntitiesAndRelations(entityIds: string[]): void {
    // 与上游一致：更智能的引用计数清理留待后续实现。
    void entityIds;
  }

  public hasMemory(memoryId: string): boolean {
    return this.findMemoryById(memoryId) !== undefined;
  }
  public has_memory(memoryId: string): boolean {
    return this.hasMemory(memoryId);
  }

  public forget(strategy = 'importance_based', threshold = 0.1, maxAgeDays = 30): number {
    const toRemove: string[] = [];
    const now = Date.now();
    for (const memory of this.semanticMemories) {
      let shouldForget = false;
      if (strategy === 'importance_based') {
        shouldForget = memory.importance < threshold;
      } else if (strategy === 'time_based') {
        shouldForget = memory.timestamp.getTime() < now - maxAgeDays * 86_400_000;
      } else if (strategy === 'capacity_based') {
        if (this.semanticMemories.length > this.config.maxCapacity) {
          const ordered = [...this.semanticMemories].sort((a, b) => a.importance - b.importance);
          const excess = this.semanticMemories.length - this.config.maxCapacity;
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
    try {
      if (this.backends.vectorStore?.clearCollection) this.backends.vectorStore.clearCollection();
      const graphStore: GraphStorePort | undefined = this.backends.graphStore;
      if (graphStore) graphStore.clearAll();
    } catch {
      // 即使数据库清空失败也要清空本地缓存（与上游一致）。
    } finally {
      this.semanticMemories = [];
      this.memoryEmbeddings.clear();
      this.entities.clear();
      this.relations = [];
    }
  }

  public getAll(): MemoryItem[] {
    return [...this.semanticMemories];
  }
  public get_all(): MemoryItem[] {
    return this.getAll();
  }

  public getStats(): Record<string, unknown> {
    let graphStats: Record<string, unknown> = {};
    try {
      graphStats = this.backends.graphStore?.getStats() ?? {};
    } catch {
      graphStats = {};
    }
    const active = this.semanticMemories;
    return {
      count: active.length,
      forgotten_count: 0,
      total_count: this.semanticMemories.length,
      entities_count: this.entities.size,
      relations_count: this.relations.length,
      graph_nodes: graphStats.total_nodes ?? 0,
      graph_edges: graphStats.total_relationships ?? 0,
      avg_importance:
        active.length > 0
          ? active.reduce((sum, memory) => sum + memory.importance, 0) / active.length
          : 0,
      memory_type: 'enhanced_semantic'
    };
  }
  public get_stats(): Record<string, unknown> {
    return this.getStats();
  }

  public getEntity(entityId: string): Entity | undefined {
    return this.entities.get(entityId);
  }
  public get_entity(entityId: string): Entity | undefined {
    return this.getEntity(entityId);
  }

  public searchEntities(query: string, limit = 10): Entity[] {
    const queryLower = query.toLowerCase();
    const scored: Array<[number, Entity]> = [];
    for (const entity of this.entities.values()) {
      let score = 0;
      if (entity.name.toLowerCase().includes(queryLower)) score += 2;
      if (entity.entityType.toLowerCase().includes(queryLower)) score += 1;
      if (entity.description.toLowerCase().includes(queryLower)) score += 0.5;
      score *= Math.log(1 + entity.frequency);
      if (score > 0) scored.push([score, entity]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(([, entity]) => entity);
  }
  public search_entities(query: string, limit = 10): Entity[] {
    return this.searchEntities(query, limit);
  }

  public getRelatedEntities(
    entityId: string,
    relationTypes?: string[],
    maxHops = 2
  ): Array<Record<string, unknown>> {
    const related: Array<Record<string, unknown>> = [];
    try {
      const graphStore = this.backends.graphStore;
      if (!graphStore) return [];
      const rows = graphStore.findRelatedEntities({
        entity_id: entityId,
        ...(relationTypes ? { relationship_types: relationTypes } : {}),
        max_depth: maxHops,
        limit: 50
      });
      for (const row of rows) {
        let entityObj = this.entities.get(String(row.id));
        if (!entityObj)
          entityObj = new Entity(
            String(row.id ?? entityId),
            String(row.name ?? ''),
            String(row.type ?? 'MISC')
          );
        const path = row.relationship_path as string[] | undefined;
        related.push({
          entity: entityObj,
          relation_type: path && path.length > 0 ? path[path.length - 1] : 'RELATED',
          strength: 1 / Math.max(Number(row.distance ?? 1), 1),
          distance: row.distance ?? maxHops
        });
      }
      related.sort(
        (a, b) =>
          (a.distance as number) - (b.distance as number) ||
          (b.strength as number) - (a.strength as number)
      );
    } catch {
      return related;
    }
    return related;
  }
  public get_related_entities(
    entityId: string,
    relationTypes?: string[],
    maxHops = 2
  ): Array<Record<string, unknown>> {
    return this.getRelatedEntities(entityId, relationTypes, maxHops);
  }

  public exportKnowledgeGraph(): Record<string, unknown> {
    try {
      const stats = this.backends.graphStore?.getStats() ?? {};
      const entities: Record<string, unknown> = {};
      for (const [id, entity] of this.entities) entities[id] = entity.toDict();
      return {
        entities,
        relations: this.relations.map((relation) => relation.toDict()),
        graph_stats: {
          total_nodes: stats.total_nodes ?? 0,
          entity_nodes: stats.entity_nodes ?? 0,
          memory_nodes: stats.memory_nodes ?? 0,
          total_relationships: stats.total_relationships ?? 0,
          cached_entities: this.entities.size,
          cached_relations: this.relations.length
        }
      };
    } catch (error) {
      return { entities: {}, relations: [], graph_stats: { error: String(error) } };
    }
  }
  public export_knowledge_graph(): Record<string, unknown> {
    return this.exportKnowledgeGraph();
  }
}
