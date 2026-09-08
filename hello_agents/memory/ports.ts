/**
 * Backend ports for the teaching-line memory system.
 *
 * Upstream (`memory/embedding.py`, `memory/storage/*`) eagerly wires a text
 * embedder, a SQLite document store, Qdrant vector collections and a Neo4j
 * graph store. Those implementations belong to issue #84 and are intentionally
 * not re-implemented here. The four memory types depend only on the structural
 * interfaces in this file, so #84 can supply real backends via constructor
 * injection without touching memory logic. When a backend is omitted the
 * memory keeps its in-memory cache authoritative and follows the same
 * offline/degraded fallback paths that the Python code uses when a vector or
 * graph call raises.
 */

/** Minimal text embedder contract (upstream `EmbeddingModel`). */
export interface TextEmbedder {
  /** Encode a single piece of text into a dense vector. */
  encode(text: string): number[];
  /** Declared embedding dimension. */
  readonly dimension: number;
}

/** A memory document as persisted by the authoritative document store. */
export interface StoredMemoryDoc {
  memory_id: string;
  user_id: string;
  content: string;
  memory_type: string;
  /** Unix epoch seconds, matching the SQLite schema upstream. */
  timestamp: number;
  importance: number;
  properties: Record<string, unknown>;
}

/** Filter arguments shared by the document-store search path. */
export interface DocumentSearchFilter {
  user_id?: string | undefined;
  memory_type?: string | undefined;
  /** Unix epoch seconds, inclusive. */
  start_time?: number | undefined;
  /** Unix epoch seconds, inclusive. */
  end_time?: number | undefined;
  importance_threshold?: number | undefined;
  limit?: number | undefined;
}

/** Upstream `DocumentStore`/`SQLiteDocumentStore` surface used by memories. */
export interface DocumentStorePort {
  addMemory(doc: {
    memory_id: string;
    user_id: string;
    content: string;
    memory_type: string;
    timestamp: number;
    importance: number;
    properties: Record<string, unknown>;
  }): void;
  getMemory(memoryId: string): StoredMemoryDoc | undefined | null;
  searchMemories(filter?: DocumentSearchFilter): StoredMemoryDoc[];
  updateMemory(changes: {
    memory_id: string;
    content?: string | undefined;
    importance?: number | undefined;
    properties?: Record<string, unknown> | undefined;
  }): boolean;
  deleteMemory(memoryId: string): boolean;
  getDatabaseStats(): Record<string, unknown>;
}

export interface VectorSearchHit {
  id?: string;
  score: number;
  metadata: Record<string, unknown>;
}

/** Upstream `QdrantVectorStore` surface used by memories. */
export interface VectorStorePort {
  addVectors(request: {
    vectors: number[][];
    metadata: Array<Record<string, unknown>>;
    ids: string[];
  }): boolean | void;
  searchSimilar(request: {
    queryVector: number[];
    limit: number;
    where?: Record<string, unknown> | undefined;
  }): VectorSearchHit[];
  deleteMemories(memoryIds: string[]): boolean | void;
  getCollectionStats(): Record<string, unknown>;
  clearCollection?(): boolean;
  healthCheck?(): boolean;
}

/** Upstream `Neo4jGraphStore` surface used by `SemanticMemory`. */
export interface GraphStorePort {
  addEntity(request: {
    entity_id: string;
    name: string;
    entity_type: string;
    properties?: Record<string, unknown> | undefined;
  }): boolean;
  addRelationship(request: {
    from_entity_id: string;
    to_entity_id: string;
    relationship_type: string;
    properties?: Record<string, unknown> | undefined;
  }): boolean;
  findRelatedEntities(request: {
    entity_id: string;
    relationship_types?: string[] | undefined;
    max_depth?: number | undefined;
    limit?: number | undefined;
  }): Array<Record<string, unknown>>;
  searchEntitiesByName(request: {
    name_pattern: string;
    entity_types?: string[] | undefined;
    limit?: number | undefined;
  }): Array<Record<string, unknown>>;
  getEntityRelationships(entityId: string): Array<Record<string, unknown>>;
  getStats(): Record<string, unknown>;
  clearAll(): boolean;
  healthCheck?(): boolean;
}

/** Injectable backend bundle; every member is optional. */
export interface MemoryBackends {
  embedder?: TextEmbedder | undefined;
  docStore?: DocumentStorePort | undefined;
  vectorStore?: VectorStorePort | undefined;
  /** Per-modality vector stores used by `PerceptualMemory`. */
  vectorStores?: Record<string, VectorStorePort> | undefined;
  graphStore?: GraphStorePort | undefined;
}
