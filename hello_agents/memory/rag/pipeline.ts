/**
 * RAG pipeline primitives.
 *
 * This first layer deliberately has no network or optional-package dependency:
 * it reads formats which are unambiguously text on the local filesystem,
 * converts HTML to plain Markdown-like text, and creates deterministic chunks.
 * Qdrant, LLM query expansion, graph enrichment, and optional rerankers belong
 * to the later asynchronous pipeline layer.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { getDimension, getTextEmbedder } from '../embedding.js';
import { QdrantConnectionManager } from '../storage/qdrant-store.js';
import type { VectorSearchHit } from '../ports.js';
import { HelloAgentsLLM } from '../../core/llm.js';

export interface RagChunkMetadata {
  source_path: string;
  file_ext: string;
  doc_id: string;
  lang: string;
  start: number;
  end: number;
  content_hash: string;
  namespace: string;
  source: string;
  external: true;
  heading_path: string | null;
  format: 'markdown';
}

export interface RagChunk {
  id: string;
  content: string;
  metadata: RagChunkMetadata;
}

export interface LoadAndChunkOptions {
  chunkSize?: number | undefined;
  chunkOverlap?: number | undefined;
  namespace?: string | null | undefined;
  sourceLabel?: string | undefined;
  /** Python-compatible option names are accepted for direct JS callers. */
  chunk_size?: number | undefined;
  chunk_overlap?: number | undefined;
  source_label?: string | undefined;
}

/** Formats read directly by this dependency-free loader. */
export const NATIVE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.html',
  '.htm',
  // Common source and configuration formats.
  '.py',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.swift',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.cxx',
  '.hpp',
  '.cs',
  '.css',
  '.scss',
  '.less',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.log',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.fish'
]);

/** Formats intentionally not decoded without an optional native adapter. */
export const UNSUPPORTED_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.webp',
  '.mp3',
  '.wav',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.zip',
  '.tar',
  '.gz',
  '.rar'
]);

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isCjk(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x2a6df) ||
    (code >= 0x2a700 && code <= 0x2b73f) ||
    (code >= 0x2b740 && code <= 0x2b81f) ||
    (code >= 0x2b820 && code <= 0x2ceaf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/** The same inexpensive token approximation used by the Python pipeline. */
export function approxTokenLength(text: string): number {
  const cjk = Array.from(text).filter(isCjk).length;
  const nonCjkTokens = text.trim() === '' ? 0 : text.trim().split(/\s+/u).length;
  return cjk + nonCjkTokens;
}

/** Python-compatible spelling for fixture and migration callers. */
export const _approx_token_len = approxTokenLength;

interface Paragraph {
  content: string;
  heading_path: string | null;
  start: number;
  end: number;
}

interface SourceLine {
  raw: string;
  offset: number;
}

function splitLinesWithOffsets(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = 0;
  // Keep the same one-character line-ending accounting as Python's source:
  // each split line advances `len(raw) + 1`, including CRLF input.
  for (const raw of text.split(/\r\n|\n|\r/u)) {
    lines.push({ raw, offset });
    offset += codePointLength(raw) + 1;
  }
  return lines;
}

/** Split text into paragraphs while carrying the active Markdown heading path. */
export function splitParagraphsWithHeadings(text: string): Paragraph[] {
  const lines = splitLinesWithOffsets(text);
  const headingStack: string[] = [];
  const paragraphs: Paragraph[] = [];
  const buffer: string[] = [];

  const flush = (end: number): void => {
    if (buffer.length === 0) return;
    const content = buffer.join('\n').trim();
    if (!content) return;
    paragraphs.push({
      content,
      heading_path: headingStack.length > 0 ? headingStack.join(' > ') : null,
      start: Math.max(0, end - codePointLength(content)),
      end
    });
  };

  for (const { raw, offset } of lines) {
    if (raw.trim().startsWith('#')) {
      flush(offset);
      const withoutLeadingHashes = raw.replace(/^#+/u, '');
      const level = Math.max(1, codePointLength(raw) - codePointLength(withoutLeadingHashes));
      const title = withoutLeadingHashes.trim();
      if (level <= headingStack.length) headingStack.splice(level - 1);
      headingStack.push(title);
      continue;
    }
    if (raw.trim() === '') {
      flush(offset);
      buffer.length = 0;
    } else {
      buffer.push(raw);
    }
  }
  flush(
    lines.length > 0
      ? lines[lines.length - 1]!.offset + codePointLength(lines[lines.length - 1]!.raw) + 1
      : 0
  );

  if (paragraphs.length === 0) {
    paragraphs.push({ content: text, heading_path: null, start: 0, end: codePointLength(text) });
  }
  return paragraphs;
}

/** Python-compatible spelling for fixture and migration callers. */
export const _split_paragraphs_with_headings = splitParagraphsWithHeadings;

function chunkHeadingPath(paragraphs: Paragraph[]): string | null {
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const heading = paragraphs[index]!.heading_path;
    if (heading) return heading;
  }
  return null;
}

/** Token-budget paragraph packing with optional tail-paragraph overlap. */
export function chunkParagraphs(
  paragraphs: readonly Paragraph[],
  chunkTokens: number,
  overlapTokens: number
): Array<{ content: string; start: number; end: number; heading_path: string | null }> {
  const chunks: Array<{
    content: string;
    start: number;
    end: number;
    heading_path: string | null;
  }> = [];
  const current: Paragraph[] = [];
  let currentTokens = 0;
  let index = 0;
  while (index < paragraphs.length) {
    const paragraph = paragraphs[index]!;
    const paragraphTokens = approxTokenLength(paragraph.content) || 1;
    if (currentTokens + paragraphTokens <= chunkTokens || current.length === 0) {
      current.push(paragraph);
      currentTokens += paragraphTokens;
      index += 1;
      continue;
    }

    chunks.push({
      content: current.map((item) => item.content).join('\n\n'),
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      heading_path: chunkHeadingPath(current)
    });

    if (overlapTokens > 0 && current.length > 0) {
      const kept: Paragraph[] = [];
      let keptTokens = 0;
      // Retained overlap must leave room for the paragraph that caused this
      // flush. Otherwise a very large caller-supplied overlap could make the
      // loop emit the same chunk forever.
      const maxRetainedTokens = Math.max(0, Math.min(overlapTokens, chunkTokens - paragraphTokens));
      for (let reverse = current.length - 1; reverse >= 0; reverse -= 1) {
        const candidate = current[reverse]!;
        const candidateTokens = approxTokenLength(candidate.content) || 1;
        if (keptTokens + candidateTokens > maxRetainedTokens) break;
        kept.push(candidate);
        keptTokens += candidateTokens;
      }
      kept.reverse();
      current.splice(0, current.length, ...kept);
      currentTokens = keptTokens;
    } else {
      current.length = 0;
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    chunks.push({
      content: current.map((item) => item.content).join('\n\n'),
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      heading_path: chunkHeadingPath(current)
    });
  }
  return chunks;
}

/** Python-compatible spelling for fixture and migration callers. */
export const _chunk_paragraphs = chunkParagraphs;

function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"'
  };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/giu, (whole, entity: string) => {
    const lowered = entity.toLowerCase();
    if (lowered.startsWith('#x')) {
      const value = Number.parseInt(lowered.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    if (lowered.startsWith('#')) {
      const value = Number.parseInt(lowered.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
    }
    return named[lowered] ?? whole;
  });
}

/** Small dependency-free HTML-to-text conversion used by the native loader. */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '');

  text = text.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu,
    (_, level: string, value: string) => {
      const clean = decodeHtmlEntities(value.replace(/<[^>]+>/gu, '').trim());
      return `${'#'.repeat(Number(level))} ${clean}\n\n`;
    }
  );
  text = text
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|section|article|li|tr|blockquote|pre)>/giu, '\n\n')
    .replace(/<(?:p|div|section|article|li|tr|blockquote|pre)\b[^>]*>/giu, '')
    .replace(/<[^>]+>/gu, '');
  text = decodeHtmlEntities(text).replace(/\u00a0/gu, ' ');

  return text
    .split(/\r\n|\r/gu)
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** Convert supported local text to the Markdown-like input expected downstream. */
export function readNativeText(path: string, fileExt = extname(path).toLowerCase()): string | null {
  if (!NATIVE_TEXT_EXTENSIONS.has(fileExt)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return fileExt === '.html' || fileExt === '.htm' ? htmlToMarkdown(raw) : raw;
  } catch {
    // Missing, unreadable, or directory paths are skipped by the loader.
    return null;
  }
}

interface NormalizedLoadAndChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
  namespace: string;
  sourceLabel: string;
}

function normalizeOptions(
  second?: number | LoadAndChunkOptions,
  third = 100,
  fourth?: string | null,
  fifth = 'rag'
): NormalizedLoadAndChunkOptions {
  if (typeof second === 'object' && second !== null) {
    return {
      chunkSize: second.chunkSize ?? second.chunk_size ?? 800,
      chunkOverlap: second.chunkOverlap ?? second.chunk_overlap ?? 100,
      namespace: second.namespace || 'default',
      sourceLabel: second.sourceLabel ?? second.source_label ?? 'rag'
    };
  }
  return {
    chunkSize: second ?? 800,
    chunkOverlap: third,
    namespace: fourth || 'default',
    sourceLabel: fifth
  };
}

/**
 * Load supported local text files, split by heading-aware token budget, and
 * globally deduplicate normalized chunk contents.
 *
 * The positional signature mirrors Python; the options overload is convenient
 * for TypeScript callers. Missing, unreadable, unknown, and binary document
 * paths are skipped. No MarkItDown/PDF/Office/OCR/audio claim is made here.
 */
export function loadAndChunkTexts(
  paths: readonly string[],
  options?: LoadAndChunkOptions
): RagChunk[];
export function loadAndChunkTexts(
  paths: readonly string[],
  chunkSize?: number,
  chunkOverlap?: number,
  namespace?: string | null,
  sourceLabel?: string
): RagChunk[];
export function loadAndChunkTexts(
  paths: readonly string[],
  second: number | LoadAndChunkOptions = 800,
  third = 100,
  fourth?: string | null,
  fifth = 'rag'
): RagChunk[] {
  const { chunkSize, chunkOverlap, namespace, sourceLabel } = normalizeOptions(
    second,
    third,
    fourth,
    fifth
  );
  const chunks: RagChunk[] = [];
  const seenHashes = new Set<string>();
  const tokenBudget = Math.max(1, chunkSize);
  const overlapBudget = Math.max(0, chunkOverlap);

  for (const path of paths) {
    const fileExt = extname(path).toLowerCase();
    const markdownText = readNativeText(path, fileExt);
    if (markdownText === null || markdownText.trim() === '') continue;

    const docId = md5(`${path}|${codePointLength(markdownText)}`);
    const paragraphs = splitParagraphsWithHeadings(markdownText);
    const tokenChunks = chunkParagraphs(paragraphs, tokenBudget, overlapBudget);

    for (const chunk of tokenChunks) {
      const normalized = chunk.content.trim();
      if (!normalized) continue;
      const contentHash = md5(normalized);
      if (seenHashes.has(contentHash)) continue;
      seenHashes.add(contentHash);

      const start = chunk.start;
      const end = chunk.end ?? start + codePointLength(chunk.content);
      const id = md5(`${docId}|${start}|${end}|${contentHash}`);
      chunks.push({
        id,
        content: chunk.content,
        metadata: {
          source_path: path,
          file_ext: fileExt,
          doc_id: docId,
          lang: 'unknown',
          start,
          end,
          content_hash: contentHash,
          namespace,
          source: sourceLabel,
          external: true,
          heading_path: chunk.heading_path,
          format: 'markdown'
        }
      });
    }
  }
  return chunks;
}

/** Python-compatible spelling. */
export function load_and_chunk_texts(
  paths: readonly string[],
  chunk_size = 800,
  chunk_overlap = 100,
  namespace?: string | null,
  source_label = 'rag'
): RagChunk[] {
  return loadAndChunkTexts(paths, chunk_size, chunk_overlap, namespace, source_label);
}

// ---------------------------------------------------------------------------
// Async vector/graph integration and pure retrieval helpers
// ---------------------------------------------------------------------------

export interface RagVectorStoreLike {
  addVectors(request: {
    vectors: number[][];
    metadata: Array<Record<string, unknown>>;
    ids: string[];
  }): boolean | void | Promise<boolean | void>;
  searchSimilar(request: {
    queryVector: number[];
    limit: number;
    score_threshold?: number | undefined;
    where?: Record<string, unknown> | undefined;
  }): VectorSearchHit[] | Promise<VectorSearchHit[]>;
  getCollectionStats?(): Record<string, unknown> | Promise<Record<string, unknown>>;
  clearCollection?(): boolean | void | Promise<boolean | void>;
}

export interface RagGraphStoreLike {
  addEntity(request: {
    entity_id: string;
    name: string;
    entity_type: string;
    properties?: Record<string, unknown> | undefined;
  }): boolean | Promise<boolean>;
  addRelationship(request: {
    from_entity_id: string;
    to_entity_id: string;
    relationship_type: string;
    properties?: Record<string, unknown> | undefined;
  }): boolean | Promise<boolean>;
}

export interface RagEmbedderLike {
  encode(texts: string | string[]): number[] | number[][] | Promise<number[] | number[][]>;
  readonly dimension: number;
  fit?(texts: string[]): void | Promise<void>;
  readonly isFitted?: boolean;
}

interface SearchItemFields {
  id?: string | undefined;
  memory_id?: string | undefined;
  score?: number | undefined;
  rerank_score?: number | undefined;
  vector_score?: number | undefined;
  graph_score?: number | undefined;
  content?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export type RagSearchItem = SearchItemFields;

export interface SearchVectorsOptions {
  store?: RagVectorStoreLike | undefined;
  embedder?: RagEmbedderLike | undefined;
  query?: string | undefined;
  topK?: number | undefined;
  ragNamespace?: string | undefined;
  onlyRagData?: boolean | undefined;
  scoreThreshold?: number | undefined;
  /** Python-compatible option spellings. */
  top_k?: number | undefined;
  rag_namespace?: string | undefined;
  only_rag_data?: boolean | undefined;
  score_threshold?: number | undefined;
}

export interface IndexChunksOptions {
  store?: RagVectorStoreLike | undefined;
  chunks?: readonly RagChunk[] | undefined;
  embedder?: RagEmbedderLike | undefined;
  batchSize?: number | undefined;
  ragNamespace?: string | undefined;
  cacheDb?: string | undefined;
  batch_size?: number | undefined;
  rag_namespace?: string | undefined;
  cache_db?: string | undefined;
}

export interface SearchVectorsExpandedOptions extends SearchVectorsOptions {
  enableMqe?: boolean | undefined;
  mqeExpansions?: number | undefined;
  enableHyde?: boolean | undefined;
  candidatePoolMultiplier?: number | undefined;
  queryExpander?:
    ((query: string, count: number) => readonly string[] | Promise<readonly string[]>) | undefined;
  hydeGenerator?: ((query: string) => string | null | Promise<string | null>) | undefined;
  enable_mqe?: boolean | undefined;
  mqe_expansions?: number | undefined;
  enable_hyde?: boolean | undefined;
  candidate_pool_multiplier?: number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function itemMetadata(item: SearchItemFields): Record<string, unknown> {
  return asRecord(item.metadata);
}

function itemId(item: SearchItemFields): string | undefined {
  const metadata = itemMetadata(item);
  const value = metadata.memory_id ?? item.memory_id ?? item.id;
  return value === undefined || value === null ? undefined : String(value);
}

function itemContent(item: SearchItemFields): string {
  const value = item.content ?? itemMetadata(item).content;
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
}

function numberValue(value: unknown, fallback = 0): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function metadataNumber(item: SearchItemFields, key: string, fallback = 0): number {
  return numberValue(itemMetadata(item)[key], fallback);
}

function codePointSlice(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join('');
}

/** Add document and chunk entities plus HAS_CHUNK edges to the current Neo4j API. */
export async function buildGraphFromChunks(
  neo4j: RagGraphStoreLike,
  chunks: readonly RagChunk[]
): Promise<void> {
  const createdDocuments = new Set<string>();
  for (const chunk of chunks) {
    const metadata = chunk.metadata ?? {};
    const sourcePath = typeof metadata.source_path === 'string' ? metadata.source_path : undefined;
    const docId = typeof metadata.doc_id === 'string' ? metadata.doc_id : undefined;
    if (docId && !createdDocuments.has(docId)) {
      createdDocuments.add(docId);
      try {
        await neo4j.addEntity({
          entity_id: docId,
          name: basename(sourcePath ?? docId),
          entity_type: 'Document',
          properties: { source_path: sourcePath, lang: metadata.lang }
        });
      } catch {
        // Graph enrichment is best-effort; vector indexing remains authoritative.
      }
    }

    try {
      await neo4j.addEntity({
        entity_id: chunk.id,
        name: chunk.id,
        entity_type: 'Memory',
        properties: {
          source_path: sourcePath,
          doc_id: docId,
          start: metadata.start,
          end: metadata.end
        }
      });
    } catch {
      // Preserve the Python pipeline's per-operation best-effort behavior.
    }

    if (docId) {
      try {
        await neo4j.addRelationship({
          from_entity_id: docId,
          to_entity_id: chunk.id,
          relationship_type: 'HAS_CHUNK',
          properties: {}
        });
      } catch {
        // See above: an unavailable graph must not make loading unusable.
      }
    }
  }
}

/** Python-compatible spelling. */
export const build_graph_from_chunks = buildGraphFromChunks;

/** Remove Markdown decoration while retaining the text sent to an embedder. */
export function preprocessMarkdownForEmbedding(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gmu, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/\*([^*]+)\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/```[^\n]*\n([\s\S]*?)```/gu, '$1')
    .replace(/\n\s*\n/gu, '\n\n')
    .replace(/[ \t]+/gu, ' ')
    .trim();
}

/** Python-compatible spelling. */
export const _preprocess_markdown_for_embedding = preprocessMarkdownForEmbedding;

function isIndexOptions(value: unknown): value is IndexChunksOptions {
  return (
    value !== null &&
    typeof value === 'object' &&
    ('chunks' in value || 'store' in value || 'embedder' in value || 'batchSize' in value)
  );
}

function isSearchOptions(value: unknown): value is SearchVectorsOptions {
  return (
    value !== null &&
    typeof value === 'object' &&
    ('query' in value || 'store' in value || 'embedder' in value || 'topK' in value)
  );
}

function vectorFromUnknown(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((item) => numberValue(item));
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>, (item) => numberValue(item));
  }
  return [];
}

function vectorBatchFromUnknown(value: unknown): number[][] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (value.every((item) => typeof item === 'number')) return [vectorFromUnknown(value)];
    return value.map((item) => vectorFromUnknown(item));
  }
  if (ArrayBuffer.isView(value)) return [vectorFromUnknown(value)];
  return [];
}

function fitIfNeeded(embedder: RagEmbedderLike, texts: string[]): void | Promise<void> {
  if (typeof embedder.fit === 'function' && embedder.isFitted === false) {
    return embedder.fit(texts);
  }
}

function resizeVector(vector: number[], dimension: number): number[] {
  if (dimension <= 0 || vector.length === dimension) return vector;
  if (vector.length > dimension) return vector.slice(0, dimension);
  return [...vector, ...new Array(dimension - vector.length).fill(0)];
}

async function resolveDefaultStore(dimension?: number): Promise<RagVectorStoreLike> {
  const vectorDimension = dimension && dimension > 0 ? dimension : await getDimension(384);
  return QdrantConnectionManager.getInstance({
    url: process.env.QDRANT_URL,
    api_key: process.env.QDRANT_API_KEY,
    collection_name: 'hello_agents_rag_vectors',
    vector_size: vectorDimension,
    distance: 'cosine'
  });
}

/** Create the default Qdrant adapter without performing network I/O. */
export const createDefaultVectorStore = resolveDefaultStore;
export const _create_default_vector_store = resolveDefaultStore;

export interface RagSummarizerLike {
  invoke(
    messages: readonly { role: 'system' | 'user'; content: string }[]
  ): string | Promise<string>;
}

/**
 * Summarize text through an injected LLM, or the configured HelloAgents LLM.
 * Construction and network access are deferred until this function is called.
 */
export async function tldrSummarize(
  text: string,
  bullets = 3,
  summarizer?: RagSummarizerLike
): Promise<string | null> {
  if (!text.trim()) return null;
  try {
    const llm = summarizer ?? new HelloAgentsLLM();
    const count = Math.max(1, Math.min(5, Math.trunc(numberValue(bullets, 3))));
    return await llm.invoke([
      {
        role: 'system',
        content: '请将以下内容概括为简洁的要点列表（最多3-5条），用中文，避免重复，突出关键信息。'
      },
      { role: 'user', content: `请用 ${count} 条要点总结：\n\n${text}` }
    ]);
  } catch {
    return null;
  }
}

/** Python-compatible spelling. */
export const tldr_summarize = tldrSummarize;

export interface CreateRagPipelineOptions {
  qdrantUrl?: string | undefined;
  qdrantApiKey?: string | undefined;
  collectionName?: string | undefined;
  ragNamespace?: string | undefined;
  embedder?: RagEmbedderLike | undefined;
}

export interface RagPipeline {
  store: RagVectorStoreLike;
  namespace: string;
  addDocuments(
    filePaths: readonly string[],
    chunkSize?: number,
    chunkOverlap?: number
  ): Promise<number>;
  search(query: string, topK?: number, scoreThreshold?: number): Promise<VectorSearchHit[]>;
  searchAdvanced(
    query: string,
    topK?: number,
    enableMqe?: boolean,
    enableHyde?: boolean,
    scoreThreshold?: number
  ): Promise<VectorSearchHit[]>;
  getStats(): Promise<Record<string, unknown>>;
}

/** Create a lazy-use RAG pipeline with the same helpers as Python's factory. */
export async function createRagPipeline(
  options: CreateRagPipelineOptions = {}
): Promise<RagPipeline> {
  const embedder = options.embedder ?? (await getTextEmbedder());
  const store = await QdrantConnectionManager.getInstance({
    url: options.qdrantUrl,
    api_key: options.qdrantApiKey,
    collection_name: options.collectionName ?? 'hello_agents_rag_vectors',
    vector_size: numberValue(embedder.dimension, await getDimension(384)),
    distance: 'cosine'
  });
  const namespace = options.ragNamespace || 'default';
  return {
    store,
    namespace,
    async addDocuments(filePaths, chunkSize = 800, chunkOverlap = 100) {
      const chunks = loadAndChunkTexts(filePaths, chunkSize, chunkOverlap, namespace, 'rag');
      await indexChunks({ store, chunks, embedder, ragNamespace: namespace });
      return chunks.length;
    },
    search: (query, topK = 8, scoreThreshold) =>
      searchVectors({ store, embedder, query, topK, ragNamespace: namespace, scoreThreshold }),
    searchAdvanced: (query, topK = 8, enableMqe = false, enableHyde = false, scoreThreshold) =>
      searchVectorsExpanded({
        store,
        embedder,
        query,
        topK,
        ragNamespace: namespace,
        enableMqe,
        enableHyde,
        scoreThreshold
      }),
    async getStats() {
      return (await store.getCollectionStats?.()) ?? {};
    }
  };
}

/** Python-compatible spelling. */
export const create_rag_pipeline = createRagPipeline;

/** Embed and upsert chunks into an injected or default vector store. */
export async function indexChunks(options: IndexChunksOptions): Promise<void>;
export async function indexChunks(
  store?: RagVectorStoreLike,
  chunks?: readonly RagChunk[],
  cacheDb?: string,
  batchSize?: number,
  ragNamespace?: string,
  embedder?: RagEmbedderLike
): Promise<void>;
export async function indexChunks(
  first?: RagVectorStoreLike | IndexChunksOptions,
  second?: readonly RagChunk[],
  third?: string,
  fourth = 64,
  fifth = 'default',
  sixth?: RagEmbedderLike
): Promise<void> {
  const options = isIndexOptions(first)
    ? first
    : {
        store: first,
        chunks: second,
        cacheDb: third,
        batchSize: fourth,
        ragNamespace: fifth,
        embedder: sixth
      };
  const chunks = options.chunks ?? [];
  if (chunks.length === 0) return;

  const embedder = options.embedder ?? (await getTextEmbedder());
  const processedTexts = chunks.map((chunk) => preprocessMarkdownForEmbedding(chunk.content));
  await fitIfNeeded(embedder, processedTexts);
  let dimension = numberValue(embedder.dimension, 0);
  const batchSize = Math.max(
    1,
    Math.trunc(numberValue(options.batchSize ?? options.batch_size, 64))
  );
  const vectors: number[][] = [];
  for (let index = 0; index < processedTexts.length; index += batchSize) {
    const part = processedTexts.slice(index, index + batchSize);
    const encoded = await embedder.encode(part);
    const partVectors = vectorBatchFromUnknown(encoded);
    if (partVectors.length !== part.length) {
      throw new Error(
        `嵌入器返回数量异常：期望 ${part.length} 个向量，实际 ${partVectors.length} 个`
      );
    }
    if (dimension <= 0) dimension = partVectors[0]?.length ?? 0;
    vectors.push(...partVectors.map((vector) => resizeVector(vector, dimension)));
  }

  const store = options.store ?? (await resolveDefaultStore(dimension));
  const namespace = options.ragNamespace ?? options.rag_namespace ?? 'default';
  const metadata = chunks.map((chunk) => ({
    memory_id: chunk.id,
    user_id: 'rag_user',
    memory_type: 'rag_chunk',
    content: chunk.content,
    data_source: 'rag_pipeline',
    rag_namespace: namespace,
    is_rag_data: true,
    ...chunk.metadata
  }));
  const ok = await store.addVectors({
    vectors,
    metadata,
    ids: chunks.map((chunk) => chunk.id)
  });
  if (ok === false) throw new Error('Failed to index vectors to vector store');
}

/** Python-compatible spelling. */
export const index_chunks = indexChunks;

/** Normalize any embedding backend output to a finite vector of the target dimension. */
export async function embedQuery(
  query: string,
  options: { embedder?: RagEmbedderLike | undefined; dimension?: number | undefined } = {}
): Promise<number[]> {
  const embedder = options.embedder ?? (await getTextEmbedder());
  const dimension =
    options.dimension && options.dimension > 0
      ? options.dimension
      : numberValue(embedder.dimension, 0) || (await getDimension(384));
  try {
    const encoded = await embedder.encode(query);
    const vectors = vectorBatchFromUnknown(encoded);
    const vector = vectors[0] ?? [];
    return resizeVector(vector, dimension);
  } catch {
    return new Array(dimension).fill(0);
  }
}

/** Python-compatible spelling. */
export const embed_query = embedQuery;

function searchOptionsFromArgs(
  first?: RagVectorStoreLike | SearchVectorsOptions,
  query = '',
  topK = 8,
  ragNamespace?: string,
  onlyRagData = true,
  scoreThreshold?: number,
  embedder?: RagEmbedderLike
): SearchVectorsOptions {
  if (isSearchOptions(first)) return first;
  return {
    store: first,
    query,
    topK,
    ragNamespace,
    onlyRagData,
    scoreThreshold,
    embedder
  };
}

/** Search RAG vectors using an async embedder and async vector store. */
export async function searchVectors(options: SearchVectorsOptions): Promise<VectorSearchHit[]>;
export async function searchVectors(
  store?: RagVectorStoreLike,
  query?: string,
  topK?: number,
  ragNamespace?: string,
  onlyRagData?: boolean,
  scoreThreshold?: number,
  embedder?: RagEmbedderLike
): Promise<VectorSearchHit[]>;
export async function searchVectors(
  first?: RagVectorStoreLike | SearchVectorsOptions,
  second = '',
  third = 8,
  fourth?: string,
  fifth = true,
  sixth?: number,
  seventh?: RagEmbedderLike
): Promise<VectorSearchHit[]> {
  const options = searchOptionsFromArgs(first, second, third, fourth, fifth, sixth, seventh);
  const query = options.query ?? '';
  if (!query) return [];
  const topK = Math.max(1, Math.trunc(numberValue(options.topK ?? options.top_k, 8)));
  const onlyRagData = options.onlyRagData ?? options.only_rag_data ?? true;
  const ragNamespace = options.ragNamespace ?? options.rag_namespace;
  const scoreThreshold = options.scoreThreshold ?? options.score_threshold;
  try {
    const queryVector = await embedQuery(query, { embedder: options.embedder });
    const store = options.store ?? (await resolveDefaultStore(queryVector.length));
    const where: Record<string, unknown> = { memory_type: 'rag_chunk' };
    if (onlyRagData) {
      where.is_rag_data = true;
      where.data_source = 'rag_pipeline';
    }
    if (ragNamespace) where.rag_namespace = ragNamespace;
    return await store.searchSimilar({
      queryVector,
      limit: topK,
      score_threshold: scoreThreshold,
      where
    });
  } catch {
    return [];
  }
}

/** Python-compatible spelling. */
export const search_vectors = searchVectors;

/** Compute same-document density and local offset proximity signals. */
export function computeGraphSignalsFromPool(
  vectorHits: readonly RagSearchItem[],
  sameDocWeight = 1.0,
  proximityWeight = 1.0,
  proximityWindowChars = 1600
): Record<string, number> {
  const byDocument = new Map<string, RagSearchItem[]>();
  for (const hit of vectorHits) {
    const metadata = itemMetadata(hit);
    const documentId = String(metadata.doc_id ?? metadata.memory_id ?? hit.id ?? '');
    const bucket = byDocument.get(documentId) ?? [];
    bucket.push(hit);
    byDocument.set(documentId, bucket);
  }

  const counts = new Map<string, number>();
  for (const [documentId, hits] of byDocument) counts.set(documentId, hits.length);
  const maxCount = Math.max(...counts.values(), 1);
  const window = Math.max(1, numberValue(proximityWindowChars, 1600));
  const signals: Record<string, number> = {};

  for (const [documentId, hits] of byDocument) {
    hits.sort((left, right) => metadataNumber(left, 'start') - metadataNumber(right, 'start'));
    const density = (counts.get(documentId) ?? 1) / maxCount;
    for (let index = 0; index < hits.length; index += 1) {
      const hit = hits[index]!;
      const position = metadataNumber(hit, 'start');
      let proximity = 0;
      for (let neighbor = index - 1; neighbor >= 0; neighbor -= 1) {
        const distance = Math.abs(position - metadataNumber(hits[neighbor]!, 'start'));
        if (distance > window) break;
        proximity += Math.max(0, 1 - distance / window);
      }
      for (let neighbor = index + 1; neighbor < hits.length; neighbor += 1) {
        const distance = Math.abs(position - metadataNumber(hits[neighbor]!, 'start'));
        if (distance > window) break;
        proximity += Math.max(0, 1 - distance / window);
      }
      const id = itemId(hit);
      if (!id) continue;
      const score = sameDocWeight * density + proximityWeight * proximity;
      signals[id] = (signals[id] ?? 0) + score;
    }
  }

  const maximum = Math.max(...Object.values(signals), 0);
  if (maximum > 0) {
    for (const id of Object.keys(signals)) signals[id] = signals[id]! / maximum;
  }
  return signals;
}

/** Python-compatible spelling. */
export const compute_graph_signals_from_pool = computeGraphSignalsFromPool;

/** Combine vector and graph scores into ranked retrieval items. */
export function rank(
  vectorHits: readonly RagSearchItem[],
  graphSignals: Readonly<Record<string, number>> = {},
  wVector = 0.7,
  wGraph = 0.3
): RagSearchItem[] {
  const items = vectorHits.map((hit) => {
    const id = itemId(hit) ?? '';
    const vectorScore = numberValue(hit.score, 0);
    const graphScore = numberValue(graphSignals[id], 0);
    return {
      memory_id: id,
      score: wVector * vectorScore + wGraph * graphScore,
      vector_score: vectorScore,
      graph_score: graphScore,
      content: itemContent(hit),
      metadata: itemMetadata(hit)
    } satisfies RagSearchItem;
  });
  items.sort((left, right) => numberValue(right.score) - numberValue(left.score));
  return items;
}

/** Merge ranked contents up to a code-point budget. */
export function mergeSnippets(rankedItems: readonly RagSearchItem[], maxChars = 1200): string {
  const output: string[] = [];
  let total = 0;
  const budget = Math.max(0, Math.trunc(numberValue(maxChars, 1200)));
  for (const item of rankedItems) {
    const text = itemContent(item).trim();
    if (!text) continue;
    const length = codePointLength(text);
    if (total + length > budget) {
      const remaining = budget - total;
      if (remaining <= 0) break;
      output.push(codePointSlice(text, 0, remaining));
      break;
    }
    output.push(text);
    total += length;
  }
  return output.join('\n\n');
}

/** Python-compatible spelling. */
export const merge_snippets = mergeSnippets;

/** Expand selected chunks with neighboring chunks from a retrieval pool. */
export function expandNeighborsFromPool(
  selected: readonly RagSearchItem[],
  pool: readonly RagSearchItem[],
  neighbors = 1,
  maxAdditions = 5
): RagSearchItem[] {
  if (selected.length === 0 || pool.length === 0 || neighbors <= 0 || maxAdditions <= 0) {
    return [...selected];
  }
  const byDocument = new Map<string, RagSearchItem[]>();
  for (const item of pool) {
    const documentId = itemMetadata(item).doc_id;
    if (documentId === undefined || documentId === null) continue;
    const bucket = byDocument.get(String(documentId)) ?? [];
    bucket.push(item);
    byDocument.set(String(documentId), bucket);
  }
  for (const items of byDocument.values()) {
    items.sort((left, right) => metadataNumber(left, 'start') - metadataNumber(right, 'start'));
  }

  const selectedIds = new Set(selected.map((item) => itemId(item)));
  const additions: RagSearchItem[] = [];
  for (const item of selected) {
    const documentId = itemMetadata(item).doc_id;
    if (documentId === undefined || documentId === null) continue;
    const items = byDocument.get(String(documentId));
    if (!items) continue;
    const selectedIndex = items.findIndex((candidate) => itemId(candidate) === itemId(item));
    if (selectedIndex < 0) continue;
    for (let offset = 1; offset <= neighbors; offset += 1) {
      for (const candidateIndex of [selectedIndex - offset, selectedIndex + offset]) {
        if (candidateIndex < 0 || candidateIndex >= items.length) continue;
        const candidate = items[candidateIndex]!;
        const id = itemId(candidate);
        if (id && !selectedIds.has(id)) {
          additions.push(candidate);
          selectedIds.add(id);
          if (additions.length >= maxAdditions) break;
        }
      }
      if (additions.length >= maxAdditions) break;
    }
    if (additions.length >= maxAdditions) break;
  }

  const result = [...selected, ...additions];
  result.sort(
    (left, right) =>
      numberValue(right.rerank_score ?? right.score) - numberValue(left.rerank_score ?? left.score)
  );
  return result;
}

/** Python-compatible spelling. */
export const expand_neighbors_from_pool = expandNeighborsFromPool;

interface Citation {
  index: number;
  source_path: unknown;
  doc_id: unknown;
  start: unknown;
  end: unknown;
  heading_path: unknown;
}

/** Group snippets by document and append stable inline/reference citations. */
export function mergeSnippetsGrouped(
  rankedItems: readonly RagSearchItem[],
  maxChars = 1200,
  includeCitations = true
): string {
  const byDocument = new Map<string, RagSearchItem[]>();
  const documentScores = new Map<string, number>();
  for (const item of rankedItems) {
    const metadata = itemMetadata(item);
    const documentId = String(metadata.doc_id ?? metadata.source_path ?? 'unknown');
    const bucket = byDocument.get(documentId) ?? [];
    bucket.push(item);
    byDocument.set(documentId, bucket);
    documentScores.set(documentId, (documentScores.get(documentId) ?? 0) + numberValue(item.score));
  }

  const orderedDocuments = [...byDocument.keys()].sort(
    (left, right) => (documentScores.get(right) ?? 0) - (documentScores.get(left) ?? 0)
  );
  for (const documentId of orderedDocuments) {
    byDocument
      .get(documentId)!
      .sort((left, right) => metadataNumber(left, 'start') - metadataNumber(right, 'start'));
  }

  const output: string[] = [];
  const citations: Citation[] = [];
  let total = 0;
  let citationIndex = 1;
  const budget = Math.max(0, Math.trunc(numberValue(maxChars, 1200)));
  for (const documentId of orderedDocuments) {
    for (const item of byDocument.get(documentId)!) {
      const text = itemContent(item).trim();
      if (!text) continue;
      const suffix = includeCitations ? ` [${citationIndex}]` : '';
      const needed = codePointLength(text) + codePointLength(suffix);
      const metadata = itemMetadata(item);
      const addCitation = (): void => {
        if (!includeCitations) return;
        citations.push({
          index: citationIndex,
          source_path: metadata.source_path,
          doc_id: metadata.doc_id,
          start: metadata.start,
          end: metadata.end,
          heading_path: metadata.heading_path
        });
        citationIndex += 1;
      };
      if (total + needed > budget) {
        const remaining = budget - total;
        if (remaining <= 0) break;
        const clipped = codePointSlice(text, 0, Math.max(0, remaining - codePointLength(suffix)));
        if (clipped) {
          output.push(clipped + suffix);
          total += codePointLength(clipped) + codePointLength(suffix);
          addCitation();
        }
        break;
      }
      output.push(text + suffix);
      total += needed;
      addCitation();
    }
    if (total >= budget) break;
  }

  const merged = output.join('\n\n');
  if (!includeCitations || citations.length === 0) return merged;
  const lines = [merged, '', 'References:'];
  for (const citation of citations) {
    const location =
      citation.start !== undefined &&
      citation.start !== null &&
      citation.end !== undefined &&
      citation.end !== null
        ? ` (${String(citation.start)}-${String(citation.end)})`
        : '';
    const heading = citation.heading_path ? ` – ${String(citation.heading_path)}` : '';
    const source = citation.source_path ?? citation.doc_id ?? 'source';
    lines.push(`[${citation.index}] ${String(source)}${location}${heading}`);
  }
  return lines.join('\n');
}

/** Python-compatible spelling. */
export const merge_snippets_grouped = mergeSnippetsGrouped;

/** Merge nearby chunks from the same document while retaining the best score. */
export function compressRankedItems(
  rankedItems: RagSearchItem[],
  enableCompression = true,
  maxPerDoc = 2,
  joinGap = 200
): RagSearchItem[] {
  if (!enableCompression) return rankedItems;
  const counts = new Map<string, number>();
  const lastByDocument = new Map<string, RagSearchItem>();
  const output: RagSearchItem[] = [];
  for (const item of rankedItems) {
    const metadata = itemMetadata(item);
    const documentId = String(metadata.doc_id ?? metadata.source_path ?? 'unknown');
    const start = Math.trunc(metadataNumber(item, 'start'));
    const end = Math.trunc(metadataNumber(item, 'end', start + codePointLength(itemContent(item))));
    const last = lastByDocument.get(documentId);
    if (!last) {
      lastByDocument.set(documentId, item);
      counts.set(documentId, 1);
      output.push(item);
      continue;
    }
    const lastMetadata = itemMetadata(last);
    const lastStart = Math.trunc(metadataNumber(last, 'start'));
    const lastEnd = Math.trunc(
      metadataNumber(last, 'end', lastStart + codePointLength(itemContent(last)))
    );
    if (start - lastEnd <= joinGap && start >= lastStart) {
      const existing = itemContent(last).trim();
      const additional = itemContent(item).trim();
      if (additional) last.content = existing ? `${existing}\n\n${additional}` : additional;
      lastMetadata.end = Math.max(lastEnd, end);
      last.score = Math.max(numberValue(last.score), numberValue(item.score));
      lastByDocument.set(documentId, last);
      continue;
    }
    const count = counts.get(documentId) ?? 0;
    if (count >= maxPerDoc) continue;
    output.push(item);
    lastByDocument.set(documentId, item);
    counts.set(documentId, count + 1);
  }
  return output;
}

/** Python-compatible spelling. */
export const compress_ranked_items = compressRankedItems;

export type RagReranker = (
  query: string,
  items: readonly RagSearchItem[]
) => readonly number[] | Promise<readonly number[]>;

/**
 * Rerank with an explicitly injected scorer. Without one (or when it fails),
 * preserve vector order; no optional cross-encoder is silently loaded.
 */
export async function rerankWithCrossEncoder(
  query: string,
  items: RagSearchItem[],
  reranker?: RagReranker,
  topK = 10
): Promise<RagSearchItem[]> {
  const limit = Math.max(0, Math.trunc(numberValue(topK, 10)));
  if (!reranker || items.length === 0) return items.slice(0, limit);
  try {
    const scores = await reranker(query, items);
    for (let index = 0; index < Math.min(items.length, scores.length); index += 1) {
      items[index]!.rerank_score = numberValue(scores[index], numberValue(items[index]!.score));
    }
    items.sort(
      (left, right) =>
        numberValue(right.rerank_score ?? right.score) -
        numberValue(left.rerank_score ?? left.score)
    );
  } catch {
    // Optional scorer failures degrade to the deterministic vector order.
  }
  return items.slice(0, limit);
}

/** Python-compatible spelling. */
export const rerank_with_cross_encoder = rerankWithCrossEncoder;

export interface ExpandedSearchOptions extends SearchVectorsOptions {
  enableMqe?: boolean | undefined;
  mqeExpansions?: number | undefined;
  enableHyde?: boolean | undefined;
  candidatePoolMultiplier?: number | undefined;
  queryExpander?:
    ((query: string, count: number) => readonly string[] | Promise<readonly string[]>) | undefined;
  hydeGenerator?: ((query: string) => string | null | Promise<string | null>) | undefined;
  enable_mqe?: boolean | undefined;
  mqe_expansions?: number | undefined;
  enable_hyde?: boolean | undefined;
  candidate_pool_multiplier?: number | undefined;
}

function isExpandedSearchOptions(value: unknown): value is ExpandedSearchOptions {
  return (
    isSearchOptions(value) ||
    (value !== null &&
      typeof value === 'object' &&
      ('enableMqe' in value || 'enableHyde' in value || 'queryExpander' in value))
  );
}

/**
 * Expanded search with explicit MQE/HyDE seams. Flags alone do not invoke an
 * LLM; absent seams therefore deterministically use the original query only.
 */
export async function searchVectorsExpanded(
  options: ExpandedSearchOptions
): Promise<VectorSearchHit[]>;
export async function searchVectorsExpanded(
  store?: RagVectorStoreLike,
  query?: string,
  topK?: number,
  ragNamespace?: string,
  onlyRagData?: boolean,
  scoreThreshold?: number,
  enableMqe?: boolean,
  mqeExpansions?: number,
  enableHyde?: boolean,
  candidatePoolMultiplier?: number,
  embedder?: RagEmbedderLike,
  queryExpander?:
    ((query: string, count: number) => readonly string[] | Promise<readonly string[]>) | undefined,
  hydeGenerator?: ((query: string) => string | null | Promise<string | null>) | undefined
): Promise<VectorSearchHit[]>;
export async function searchVectorsExpanded(
  first?: RagVectorStoreLike | ExpandedSearchOptions,
  second = '',
  third = 8,
  fourth?: string,
  fifth = true,
  sixth?: number,
  seventh = false,
  eighth = 2,
  ninth = false,
  tenth = 4,
  eleventh?: RagEmbedderLike,
  twelfth?: (query: string, count: number) => readonly string[] | Promise<readonly string[]>,
  thirteenth?: (query: string) => string | null | Promise<string | null>
): Promise<VectorSearchHit[]> {
  let options: ExpandedSearchOptions;
  if (isExpandedSearchOptions(first)) {
    options = first;
  } else {
    options = {
      store: first,
      query: second,
      topK: third,
      ragNamespace: fourth,
      onlyRagData: fifth,
      scoreThreshold: sixth,
      enableMqe: seventh,
      mqeExpansions: eighth,
      enableHyde: ninth,
      candidatePoolMultiplier: tenth,
      embedder: eleventh,
      queryExpander: twelfth,
      hydeGenerator: thirteenth
    };
  }
  const query = options.query ?? '';
  if (!query) return [];
  const topK = Math.max(1, Math.trunc(numberValue(options.topK ?? options.top_k, 8)));
  const enableMqe = options.enableMqe ?? options.enable_mqe ?? false;
  const enableHyde = options.enableHyde ?? options.enable_hyde ?? false;
  const expansionCount = Math.max(
    0,
    Math.trunc(numberValue(options.mqeExpansions ?? options.mqe_expansions, 2))
  );
  const multiplier = Math.max(
    1,
    numberValue(options.candidatePoolMultiplier ?? options.candidate_pool_multiplier, 4)
  );

  const expansions: string[] = [query];
  if (enableMqe && expansionCount > 0 && options.queryExpander) {
    try {
      expansions.push(...(await options.queryExpander(query, expansionCount)));
    } catch {
      // Keep the original query on seam failure.
    }
  }
  if (enableHyde && options.hydeGenerator) {
    try {
      const generated = await options.hydeGenerator(query);
      if (generated) expansions.push(generated);
    } catch {
      // Keep the original query on seam failure.
    }
  }
  const uniqueExpansions = [...new Set(expansions.filter((value) => value.trim() !== ''))];
  const pool = Math.max(Math.trunc(topK * multiplier), 20);
  const perExpansion = Math.max(1, Math.trunc(pool / uniqueExpansions.length));
  const aggregated = new Map<string, VectorSearchHit>();
  for (const expanded of uniqueExpansions) {
    const hits = await searchVectors({
      ...options,
      query: expanded,
      topK: perExpansion
    });
    for (const hit of hits) {
      const id = itemId(hit) ?? `${aggregated.size}:${hit.id ?? ''}`;
      const previous = aggregated.get(id);
      if (!previous || numberValue(hit.score) > numberValue(previous.score)) {
        aggregated.set(id, hit);
      }
    }
  }
  return [...aggregated.values()]
    .sort((left, right) => numberValue(right.score) - numberValue(left.score))
    .slice(0, topK);
}

/** Python-compatible spelling. */
export const search_vectors_expanded = searchVectorsExpanded;
