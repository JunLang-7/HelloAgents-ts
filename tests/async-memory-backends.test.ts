/** Explicit async memory ports: real network-store shape without weakening sync APIs. */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { toAsyncTextEmbedder } from '../hello_agents/memory/embedding.js';
import {
  EpisodicMemory,
  Entity,
  MemoryConfig,
  MemoryItem,
  PerceptualMemory,
  SemanticMemory
} from '../hello_agents/memory/index.js';
import type {
  AsyncGraphStorePort,
  AsyncVectorStorePort,
  VectorSearchHit
} from '../hello_agents/memory/index.js';
import { TFIDFEmbedding } from '../hello_agents/memory/embedding.js';
import { SQLiteDocumentStore } from '../hello_agents/memory/storage/index.js';
import { Neo4jGraphStore, QdrantVectorStore } from '../hello_agents/memory/storage/index.js';
import { dockerAvailable, ensureNeo4j, ensureQdrant } from './helpers/db-test-utils.js';

class FakeAsyncVector implements AsyncVectorStorePort {
  readonly vectors = new Map<string, VectorSearchHit>();
  addCalls = 0;
  searchCalls = 0;
  async addVectors(request: {
    vectors: number[][];
    metadata: Array<Record<string, unknown>>;
    ids: string[];
  }): Promise<boolean> {
    this.addCalls += 1;
    request.ids.forEach((id, index) => {
      this.vectors.set(id, {
        id,
        score: 1,
        metadata: { ...(request.metadata[index] ?? {}) }
      });
    });
    return true;
  }
  async searchSimilar(request: {
    queryVector: number[];
    limit: number;
    where?: Record<string, unknown>;
  }): Promise<VectorSearchHit[]> {
    void request.queryVector;
    this.searchCalls += 1;
    return [...this.vectors.values()]
      .filter((hit) =>
        Object.entries(request.where ?? {}).every(([key, value]) => hit.metadata[key] === value)
      )
      .slice(0, request.limit);
  }
  async deleteMemories(ids: string[]): Promise<boolean> {
    ids.forEach((id) => this.vectors.delete(id));
    return true;
  }
  async getCollectionStats(): Promise<Record<string, unknown>> {
    return { store_type: 'fake-async', count: this.vectors.size };
  }
  async clearCollection(): Promise<boolean> {
    this.vectors.clear();
    return true;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

class FakeAsyncGraph implements AsyncGraphStorePort {
  readonly entities = new Map<string, Record<string, unknown>>();
  readonly relationships: Array<Record<string, unknown>> = [];
  addEntityCalls = 0;
  addRelationshipCalls = 0;
  async addEntity(request: {
    entity_id: string;
    name: string;
    entity_type: string;
    properties?: Record<string, unknown>;
  }): Promise<boolean> {
    this.addEntityCalls += 1;
    this.entities.set(request.entity_id, {
      id: request.entity_id,
      name: request.name,
      type: request.entity_type,
      ...(request.properties ?? {})
    });
    return true;
  }
  async addRelationship(request: {
    from_entity_id: string;
    to_entity_id: string;
    relationship_type: string;
    properties?: Record<string, unknown>;
  }): Promise<boolean> {
    this.addRelationshipCalls += 1;
    this.relationships.push({
      from_entity_id: request.from_entity_id,
      to_entity_id: request.to_entity_id,
      relationship_type: request.relationship_type,
      ...(request.properties ?? {})
    });
    return true;
  }
  async findRelatedEntities(request: {
    entity_id: string;
    relationship_types?: string[];
    max_depth?: number;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const own = this.entities.get(request.entity_id);
    const direct: Array<Record<string, unknown>> = own?.memory_id
      ? [{ id: request.entity_id, memory_id: String(own.memory_id), distance: 0 }]
      : [];
    return direct.concat(
      this.relationships
        .filter((row) => row.from_entity_id === request.entity_id)
        .slice(0, request.limit ?? 50)
        .map((row) => ({
          id: String(row.to_entity_id),
          memory_id: row.memory_id,
          distance: 1
        }))
    );
  }
  async searchEntitiesByName(request: {
    name_pattern: string;
    entity_types?: string[];
    limit?: number;
  }): Promise<Array<Record<string, unknown>>> {
    return [...this.entities.values()]
      .filter((entity) => String(entity.name).includes(request.name_pattern))
      .slice(0, request.limit ?? 20);
  }
  async getEntityRelationships(entityId: string): Promise<Array<Record<string, unknown>>> {
    return this.relationships
      .filter((row) => row.from_entity_id === entityId)
      .map((row) => ({
        relationship: { memory_id: row.memory_id },
        other_entity: { id: row.to_entity_id },
        direction: 'outgoing'
      }));
  }
  async getStats(): Promise<Record<string, unknown>> {
    return { total_nodes: this.entities.size, total_relationships: this.relationships.length };
  }
  async clearAll(): Promise<boolean> {
    this.entities.clear();
    this.relationships.length = 0;
    return true;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function item(id: string, content: string, memoryType: string, metadata = {}): MemoryItem {
  return new MemoryItem({
    id,
    content,
    memory_type: memoryType,
    user_id: 'u1',
    timestamp: new Date(),
    importance: 0.8,
    metadata
  });
}

describe('async memory backend ports', () => {
  test('network store classes satisfy only the explicit Promise ports', () => {
    const vectorPort: AsyncVectorStorePort = new QdrantVectorStore({ vector_size: 3 });
    const graphPort: AsyncGraphStorePort = new Neo4jGraphStore();
    expect(typeof vectorPort.searchSimilar).toBe('function');
    expect(typeof graphPort.findRelatedEntities).toBe('function');
  });

  test('episodic addAsync/retrieveAsync await the vector backend', async () => {
    const vector = new FakeAsyncVector();
    const tfidf = new TFIDFEmbedding();
    tfidf.fit(['async vector memory']);
    const db = SQLiteDocumentStore.getInstance(
      join(mkdtempSync(join(tmpdir(), 'ha-async-memory-')), 'memory.db')
    );
    const memory = new EpisodicMemory({
      config: new MemoryConfig(),
      asyncBackends: {
        embedder: toAsyncTextEmbedder(tfidf),
        vectorStore: vector,
        docStore: db
      }
    });
    await memory.addAsync(item('e-1', 'async vector memory', 'episodic', { session_id: 's1' }));
    expect(vector.addCalls).toBe(1);
    const hits = await memory.retrieveAsync('async', 5, { userId: 'u1' });
    expect(vector.searchCalls).toBe(1);
    expect(hits.map((hit) => hit.id)).toEqual(['e-1']);
  });

  test('async document-store injection participates in restart recovery', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ha-async-recovery-')), 'memory.db');
    const firstStore = SQLiteDocumentStore.getInstance(dbPath);
    const first = new EpisodicMemory({ asyncBackends: { docStore: firstStore } });
    await first.addAsync(item('e-restart', 'persisted async document', 'episodic'));
    expect(firstStore.getMemory('e-restart')).toBeDefined();

    SQLiteDocumentStore.resetForTesting();
    const reopenedStore = SQLiteDocumentStore.getInstance(dbPath);
    const recovered = new EpisodicMemory({ asyncBackends: { docStore: reopenedStore } });
    expect(recovered.getAll().map((entry) => entry.id)).toEqual(['e-restart']);
  });

  test('perceptual async text path uses async embedder and vector store', async () => {
    const vector = new FakeAsyncVector();
    const memory = new PerceptualMemory({
      asyncBackends: {
        embedder: { dimension: 3, encode: async () => [1, 0, 0] },
        vectorStore: vector
      }
    });
    await memory.addAsync(item('p-1', 'async text perception', 'perceptual'));
    const hits = await memory.retrieveAsync('async text', 5);
    expect(vector.addCalls).toBe(1);
    expect(vector.searchCalls).toBe(1);
    expect(hits[0]?.id).toBe('p-1');
  });

  test('semantic async path awaits graph calls and combines graph hits', async () => {
    const vector = new FakeAsyncVector();
    const graph = new FakeAsyncGraph();
    class TestSemanticMemory extends SemanticMemory {
      override extractEntities() {
        return [new Entity('entity-1', 'Alpha', 'CONCEPT')];
      }
    }
    const memory = new TestSemanticMemory({
      asyncBackends: {
        vectorStore: vector,
        graphStore: graph,
        embedder: { dimension: 3, encode: async () => [1, 0, 0] }
      }
    });
    await memory.addAsync(item('s-1', 'alpha knowledge', 'semantic'));
    expect(graph.addEntityCalls).toBe(1);
    const hits = await memory.retrieveAsync('Alpha', 5);
    expect(hits.map((hit) => hit.id)).toContain('s-1');
  });
});

describe.skipIf(!dockerAvailable())('async memory + real Qdrant', () => {
  const collection = `ha_async_memory_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const info = await ensureQdrant();
    process.stdout.write(`[db-integration] async memory Qdrant version=${info.version}\n`);
  }, 600_000);

  test('EpisodicMemory addAsync/retrieveAsync uses Qdrant Promise methods', async () => {
    const store = new QdrantVectorStore({
      collection_name: collection,
      vector_size: 4,
      timeout: 10
    });
    const db = SQLiteDocumentStore.getInstance(
      join(mkdtempSync(join(tmpdir(), 'ha-async-qdrant-')), 'memory.db')
    );
    const memory = new EpisodicMemory({
      asyncBackends: {
        embedder: { dimension: 4, encode: async () => [1, 0, 0, 0] },
        vectorStore: store,
        docStore: db
      }
    });
    await memory.addAsync(item('q-1', 'real qdrant async memory', 'episodic'));
    const hits = await memory.retrieveAsync('qdrant', 5);
    expect(hits.map((hit) => hit.id)).toContain('q-1');
  }, 120_000);
});

describe.skipIf(!dockerAvailable())('async semantic memory + real Neo4j', () => {
  const entityPrefix = `async_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    const info = await ensureNeo4j();
    process.stdout.write(`[db-integration] async memory Neo4j image=${info.image}\n`);
  }, 600_000);

  test('SemanticMemory addAsync/retrieveAsync uses Neo4j Promise methods', async () => {
    const graph = new Neo4jGraphStore();
    class GraphSemanticMemory extends SemanticMemory {
      override extractEntities() {
        return [
          new Entity(`${entityPrefix}_a`, `${entityPrefix}_Alpha`, 'CONCEPT'),
          new Entity(`${entityPrefix}_b`, `${entityPrefix}_Beta`, 'CONCEPT')
        ];
      }
    }
    const memory = new GraphSemanticMemory({ asyncBackends: { graphStore: graph } });
    await memory.addAsync(item('neo-async-1', 'knowledge connected through Neo4j', 'semantic'));
    const hits = await memory.retrieveAsync(`${entityPrefix}_Alpha`, 5);
    expect(hits.map((hit) => hit.id)).toContain('neo-async-1');

    await graph.deleteEntity(`${entityPrefix}_a`);
    await graph.deleteEntity(`${entityPrefix}_b`);
    graph.close();
  }, 120_000);
});
