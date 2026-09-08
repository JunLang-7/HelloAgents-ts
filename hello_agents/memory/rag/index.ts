/**
 * RAG 模块的嵌入兼容导出（上游 `memory/rag/__init__.py` 的 #84 范围部分）。
 *
 * 上游将 `memory/embedding.py` 的符号在此兼容导出，并提供历史类名别名：
 * `SentenceTransformerEmbedding = LocalTransformerEmbedding`
 * `HuggingFaceEmbedding = LocalTransformerEmbedding`
 *
 * documents / pipeline 部分归 #85。
 */
export {
  createEmbeddingModel,
  createEmbeddingModelWithFallback,
  EmbeddingModel,
  LocalTransformerEmbedding,
  TFIDFEmbedding
} from '../embedding.js';

// 兼容旧类名（历史代码中可能从此处导入）
/** 兼容别名：上游 `SentenceTransformerEmbedding = LocalTransformerEmbedding`。 */
export { LocalTransformerEmbedding as SentenceTransformerEmbedding } from '../embedding.js';
/** 兼容别名：上游 `HuggingFaceEmbedding = LocalTransformerEmbedding`。 */
export { LocalTransformerEmbedding as HuggingFaceEmbedding } from '../embedding.js';
