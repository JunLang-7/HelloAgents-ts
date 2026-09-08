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

export {
  createDocument,
  create_document,
  Document,
  DocumentChunk,
  DocumentProcessor,
  loadTextFile,
  load_text_file
} from './document.js';
export type { DocumentMetadata } from './document.js';

export {
  _approx_token_len,
  _chunk_paragraphs,
  _split_paragraphs_with_headings,
  approxTokenLength,
  chunkParagraphs,
  htmlToMarkdown,
  loadAndChunkTexts,
  load_and_chunk_texts,
  NATIVE_TEXT_EXTENSIONS,
  readNativeText,
  splitParagraphsWithHeadings,
  UNSUPPORTED_DOCUMENT_EXTENSIONS
} from './pipeline.js';
export type { LoadAndChunkOptions, RagChunk, RagChunkMetadata } from './pipeline.js';

export {
  _create_default_vector_store,
  _preprocess_markdown_for_embedding,
  buildGraphFromChunks,
  build_graph_from_chunks,
  compressRankedItems,
  compress_ranked_items,
  computeGraphSignalsFromPool,
  compute_graph_signals_from_pool,
  createRagPipeline,
  create_rag_pipeline,
  createDefaultVectorStore,
  embedQuery,
  embed_query,
  expand_neighbors_from_pool,
  expandNeighborsFromPool,
  indexChunks,
  index_chunks,
  mergeSnippets,
  merge_snippets,
  mergeSnippetsGrouped,
  merge_snippets_grouped,
  preprocessMarkdownForEmbedding,
  rank,
  rerankWithCrossEncoder,
  rerank_with_cross_encoder,
  search_vectors,
  search_vectors_expanded,
  searchVectors,
  searchVectorsExpanded,
  tldrSummarize,
  tldr_summarize
} from './pipeline.js';
export type {
  ExpandedSearchOptions,
  CreateRagPipelineOptions,
  IndexChunksOptions,
  RagEmbedderLike,
  RagGraphStoreLike,
  RagReranker,
  RagPipeline,
  RagSummarizerLike,
  RagSearchItem,
  RagVectorStoreLike,
  SearchVectorsExpandedOptions,
  SearchVectorsOptions
} from './pipeline.js';
