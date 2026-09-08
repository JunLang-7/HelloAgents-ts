/**
 * 存储层模块（上游 `memory/storage/__init__.py` 的教学版移植）。
 *
 * - `QdrantVectorStore` / `QdrantConnectionManager`：向量存储。
 * - `Neo4jGraphStore`：图存储。
 * - `DocumentStore` / `SQLiteDocumentStore`：文档存储。
 *
 * 注意：重依赖（@qdrant/js-client-rest、neo4j-driver）按需加载，
 * import 本模块不触发任何后端客户端加载。
 */
export { DocumentStore, SQLiteDocumentStore } from './document-store.js';
export type { SqliteLike } from './document-store.js';
export { QdrantConnectionManager, QdrantVectorStore } from './qdrant-store.js';
export type {
  QdrantClientLike,
  QdrantCollectionConfig,
  QdrantDistanceMap
} from './qdrant-store.js';
export { Neo4jGraphStore } from './neo4j-store.js';
export type { Neo4jDriverModule } from './neo4j-store.js';
