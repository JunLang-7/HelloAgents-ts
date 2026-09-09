/**
 * RAG tool for the teaching line.
 *
 * The tool is intentionally lazy: constructing it performs no embedding,
 * Qdrant, Neo4j, or LLM work. Those dependencies are resolved only when an
 * action needs them, and tests/deployments can inject deterministic seams.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDimension, getTextEmbedder } from '../../memory/embedding.js';
import {
  indexChunks,
  loadAndChunkTexts,
  mergeSnippetsGrouped,
  preprocessMarkdownForEmbedding,
  searchVectors,
  searchVectorsExpanded,
  type RagChunk,
  type RagEmbedderLike,
  type RagSearchItem,
  type RagVectorStoreLike
} from '../../memory/rag/pipeline.js';
import { QdrantConnectionManager } from '../../memory/storage/qdrant-store.js';
import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { FunctionTool, Tool } from '../tool.js';
import { z } from 'zod';

export interface RagLlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface RagLlmLike {
  invoke(messages: readonly RagLlmMessage[]): string | Promise<string>;
}

export interface RAGToolOptions {
  knowledgeBasePath?: string;
  qdrantUrl?: string | undefined;
  qdrantApiKey?: string | undefined;
  collectionName?: string;
  ragNamespace?: string;
  expandable?: boolean;
  store?: RagVectorStoreLike | undefined;
  embedder?: RagEmbedderLike | undefined;
  llm?: RagLlmLike | undefined;
  llmFactory?: (() => RagLlmLike | Promise<RagLlmLike>) | undefined;
}

const inputSchema = z
  .object({
    action: z.string().min(1),
    file_path: z.string().optional(),
    text: z.string().optional(),
    question: z.string().optional(),
    query: z.string().optional(),
    document_id: z.string().optional(),
    namespace: z.string().optional(),
    chunk_size: z.number().int().positive().optional(),
    chunk_overlap: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    min_score: z.number().finite().optional(),
    enable_advanced_search: z.boolean().optional(),
    include_citations: z.boolean().optional(),
    max_chars: z.number().int().positive().optional(),
    confirm: z.boolean().optional()
  })
  .passthrough();

type RagInput = z.output<typeof inputSchema>;

/**
 * 除 `action` 外的工具输入（上游 action 工具与 `run({action, ...})` 的公开输入；
 * zod v4 output 带索引签名，`Omit` 不可靠，故显式声明）。
 */
export interface RagSearchInput {
  file_path?: string | undefined;
  text?: string | undefined;
  question?: string | undefined;
  query?: string | undefined;
  document_id?: string | undefined;
  namespace?: string | undefined;
  chunk_size?: number | undefined;
  chunk_overlap?: number | undefined;
  limit?: number | undefined;
  min_score?: number | undefined;
  enable_advanced_search?: boolean | undefined;
  include_citations?: boolean | undefined;
  max_chars?: number | undefined;
  confirm?: boolean | undefined;
  [key: string]: unknown;
}

const PARAMETERS = [
  {
    name: 'action',
    type: 'string',
    description:
      '操作类型：add_document(添加文档), add_text(添加文本), ask(智能问答), search(搜索), stats(统计), clear(清空)',
    required: true
  },
  { name: 'file_path', type: 'string', description: '本地文本文件路径', required: false },
  { name: 'text', type: 'string', description: '要添加的文本内容', required: false },
  { name: 'question', type: 'string', description: '智能问答问题', required: false },
  { name: 'query', type: 'string', description: '搜索查询词', required: false },
  { name: 'document_id', type: 'string', description: '可选文档 ID', required: false },
  {
    name: 'namespace',
    type: 'string',
    description: '知识库命名空间（默认 default）',
    required: false,
    default: 'default'
  },
  {
    name: 'chunk_size',
    type: 'integer',
    description: '分块 token 预算',
    required: false,
    default: 800
  },
  {
    name: 'chunk_overlap',
    type: 'integer',
    description: '分块重叠 token 数',
    required: false,
    default: 100
  },
  { name: 'limit', type: 'integer', description: '结果数量限制', required: false, default: 5 },
  { name: 'min_score', type: 'number', description: '最低相似度', required: false, default: 0.1 },
  {
    name: 'enable_advanced_search',
    type: 'boolean',
    description: '是否启用显式查询扩展 seam',
    required: false,
    default: true
  },
  {
    name: 'include_citations',
    type: 'boolean',
    description: '是否包含引用来源',
    required: false,
    default: true
  },
  {
    name: 'max_chars',
    type: 'integer',
    description: '上下文最大字符数',
    required: false,
    default: 1200
  },
  {
    name: 'confirm',
    type: 'boolean',
    description: '清空知识库确认标记',
    required: false,
    default: false
  }
] as const;

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function namespaceValue(value: unknown, fallback: string): string {
  const namespace = textValue(value).trim();
  return namespace || fallback;
}

function itemMetadata(item: RagSearchItem): Record<string, unknown> {
  return item.metadata ?? {};
}

function itemContent(item: RagSearchItem): string {
  const value = item.content ?? itemMetadata(item).content;
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
}

function itemId(item: RagSearchItem): string | undefined {
  const value = itemMetadata(item).memory_id ?? item.memory_id ?? item.id;
  return value === undefined || value === null ? undefined : String(value);
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

function cleanSource(value: unknown): string {
  return typeof value === 'string' && value ? value : 'unknown';
}

function compactCitationItems(items: readonly RagSearchItem[]): Array<Record<string, unknown>> {
  return items.map((item, index) => {
    const metadata = itemMetadata(item);
    return {
      index: index + 1,
      id: itemId(item),
      score: item.score ?? 0,
      content: itemContent(item),
      source_path: metadata.source_path,
      doc_id: metadata.doc_id,
      start: metadata.start,
      end: metadata.end,
      heading_path: metadata.heading_path
    };
  });
}

/** Full RAG action tool. */
export class RAGTool extends Tool<typeof inputSchema> {
  public static readonly inputSchema = inputSchema;
  public readonly knowledgeBasePath: string;
  public readonly qdrantUrl: string | undefined;
  public readonly qdrantApiKey: string | undefined;
  public readonly collectionName: string;
  public readonly ragNamespace: string;

  private readonly injectedStore: RagVectorStoreLike | undefined;
  private readonly injectedEmbedder: RagEmbedderLike | undefined;
  private readonly injectedLlm: RagLlmLike | undefined;
  private readonly llmFactory: (() => RagLlmLike | Promise<RagLlmLike>) | undefined;
  private storePromise: Promise<RagVectorStoreLike> | null = null;
  private embedderPromise: Promise<RagEmbedderLike> | null = null;
  private llmPromise: Promise<RagLlmLike> | null = null;

  public constructor(options: RAGToolOptions = {}) {
    super({
      name: 'rag',
      description: 'RAG 工具 - 支持本地文本检索、引用和知识库问答',
      expandable: options.expandable ?? false,
      inputSchema,
      parameters: PARAMETERS
    });
    this.knowledgeBasePath = options.knowledgeBasePath ?? './knowledge_base';
    this.qdrantUrl = options.qdrantUrl;
    this.qdrantApiKey = options.qdrantApiKey;
    this.collectionName = options.collectionName ?? 'rag_knowledge_base';
    this.ragNamespace = namespaceValue(options.ragNamespace, 'default');
    this.injectedStore = options.store;
    this.injectedEmbedder = options.embedder;
    this.injectedLlm = options.llm;
    this.llmFactory = options.llmFactory;
  }

  /** Expand into action-specific tools while retaining this instance's seams. */
  public override getExpandedTools(): readonly Tool[] | undefined {
    if (!this.expandable) return undefined;
    const actionInput = inputSchema.omit({ action: true });
    const actions = [
      ['rag_add_document', '添加文档到知识库', 'add_document'],
      ['rag_add_text', '添加文本到知识库', 'add_text'],
      ['rag_ask', '基于知识库回答问题', 'ask'],
      ['rag_search', '搜索知识库', 'search'],
      ['rag_stats', '获取知识库统计', 'stats'],
      ['rag_clear', '清空知识库（需要确认）', 'clear']
    ] as const;
    return actions.map(
      ([name, description, action]) =>
        new FunctionTool({
          name,
          description,
          inputSchema: actionInput,
          handler: async (input) => (await this.execute({ ...input, action })).text
        })
    );
  }

  protected async run(input: RagInput): Promise<ToolResponse> {
    try {
      switch (input.action) {
        case 'add_document':
          return await this.addDocument(input);
        case 'add_text':
          return await this.addText(input);
        case 'ask':
          return await this.ask(input);
        case 'search':
          return await this.search(input);
        case 'stats':
          return await this.stats(input);
        case 'clear':
          return await this.clear(input);
        default:
          return ToolResponse.error(
            ToolErrorCode.INVALID_PARAM,
            `❌ 不支持的操作: ${input.action}`
          );
      }
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.EXECUTION_ERROR,
        `❌ RAG 操作失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getEmbedder(): Promise<RagEmbedderLike> {
    if (this.injectedEmbedder) return this.injectedEmbedder;
    if (this.embedderPromise === null) {
      this.embedderPromise = getTextEmbedder() as Promise<RagEmbedderLike>;
    }
    return this.embedderPromise;
  }

  private async getStore(embedder?: RagEmbedderLike): Promise<RagVectorStoreLike> {
    if (this.injectedStore) return this.injectedStore;
    if (this.storePromise === null) {
      this.storePromise = (async () => {
        const dimension =
          embedder && embedder.dimension > 0 ? embedder.dimension : await getDimension(384);
        // Use the tool's configured collection even for defaults.  Creating the
        // adapter is side-effect free; network/collection work starts on the
        // first action that actually calls the adapter.
        return QdrantConnectionManager.getInstance({
          url: this.qdrantUrl,
          api_key: this.qdrantApiKey,
          collection_name: this.collectionName,
          vector_size: dimension,
          distance: 'cosine'
        });
      })();
    }
    return this.storePromise;
  }

  private async getLlm(): Promise<RagLlmLike> {
    if (this.injectedLlm) return this.injectedLlm;
    if (this.llmPromise === null) {
      this.llmPromise = (async () => {
        if (this.llmFactory) return this.llmFactory();
        const module = (await import('../../core/llm.js')) as {
          HelloAgentsLLM: new () => RagLlmLike;
        };
        return new module.HelloAgentsLLM();
      })();
    }
    return this.llmPromise;
  }

  private targetNamespace(input: RagSearchInput): string {
    return namespaceValue(input.namespace, this.ragNamespace);
  }

  private async prepareEmbedder(
    embedder: RagEmbedderLike,
    chunks: readonly RagChunk[]
  ): Promise<void> {
    if (typeof embedder.fit !== 'function' || embedder.isFitted !== false) return;
    await embedder.fit(chunks.map((item) => preprocessMarkdownForEmbedding(item.content)));
  }

  private async indexLoadedChunks(chunks: readonly RagChunk[], namespace: string): Promise<void> {
    const embedder = await this.getEmbedder();
    await this.prepareEmbedder(embedder, chunks);
    const store = await this.getStore(embedder);
    await indexChunks({ store, embedder, chunks, ragNamespace: namespace });
  }

  private async addDocument(input: RagSearchInput): Promise<ToolResponse> {
    const filePath = textValue(input.file_path);
    if (!filePath)
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ add_document 需要 file_path');
    const namespace = this.targetNamespace(input);
    const chunks = loadAndChunkTexts([filePath], {
      chunkSize: input.chunk_size ?? 800,
      chunkOverlap: input.chunk_overlap ?? 100,
      namespace,
      sourceLabel: 'rag'
    });
    if (chunks.length === 0) {
      return ToolResponse.error(
        ToolErrorCode.NOT_FOUND,
        `⚠️ 未能从文件解析内容（文件不存在、不可读或格式未声明支持）: ${filePath}`
      );
    }
    await this.indexLoadedChunks(chunks, namespace);
    return ToolResponse.success(
      `✅ 文档已添加到知识库\n📊 分块数量: ${chunks.length}\n📝 命名空间: ${namespace}`,
      { chunks_added: chunks.length, file_path: filePath, namespace }
    );
  }

  private async addText(input: RagSearchInput): Promise<ToolResponse> {
    const text = textValue(input.text);
    if (!text.trim())
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ add_text 需要非空 text');
    const documentId = textValue(input.document_id).trim() || `text_${md5(text).slice(0, 16)}`;
    if (!/^[A-Za-z0-9_.-]+$/u.test(documentId)) {
      return ToolResponse.error(
        ToolErrorCode.INVALID_PARAM,
        '❌ document_id 只能包含字母、数字、下划线、点和短横线'
      );
    }
    const namespace = this.targetNamespace(input);
    mkdirSync(this.knowledgeBasePath, { recursive: true });
    const temporaryPath = join(this.knowledgeBasePath, `${documentId}.md`);
    writeFileSync(temporaryPath, text, 'utf8');
    try {
      const chunks = loadAndChunkTexts([temporaryPath], {
        chunkSize: input.chunk_size ?? 800,
        chunkOverlap: input.chunk_overlap ?? 100,
        namespace,
        sourceLabel: 'rag'
      });
      if (chunks.length === 0) {
        return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '⚠️ 未能从 text 生成有效分块');
      }
      await this.indexLoadedChunks(chunks, namespace);
      return ToolResponse.success(
        `✅ 文本已添加到知识库\n📊 分块数量: ${chunks.length}\n📝 命名空间: ${namespace}`,
        { chunks_added: chunks.length, document_id: documentId, namespace }
      );
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file is best-effort cleanup; indexing already finished.
      }
    }
  }

  private async retrieve(input: RagSearchInput): Promise<RagSearchItem[]> {
    const query = textValue(input.query || input.question).trim();
    if (!query) return [];
    const namespace = this.targetNamespace(input);
    const store = await this.getStore();
    const embedder = await this.getEmbedder();
    const options = {
      store,
      embedder,
      query,
      topK: input.limit ?? 5,
      ragNamespace: namespace,
      scoreThreshold: input.min_score,
      onlyRagData: true
    };
    return input.enable_advanced_search === false
      ? await searchVectors(options)
      : await searchVectorsExpanded({ ...options, enableMqe: false, enableHyde: false });
  }

  /**
   * 搜索知识库（上游 `run({action: 'search', ...})` 的公开入口；
   * #74 ContextBuilder 经此注入组合工具结果）。
   */
  public async search(input: RagSearchInput): Promise<ToolResponse> {
    const query = textValue(input.query || input.question).trim();
    if (!query) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ search 需要 query');
    const results = await this.retrieve(input);
    if (results.length === 0) {
      return ToolResponse.success(`🔍 未找到与「${query}」相关的内容`, { results: [] });
    }
    const includeCitations = input.include_citations ?? true;
    const text = mergeSnippetsGrouped(results, input.max_chars ?? 1200, includeCitations);
    return ToolResponse.success(text, {
      results: compactCitationItems(results),
      query,
      namespace: this.targetNamespace(input),
      citations: includeCitations ? compactCitationItems(results) : []
    });
  }

  private async ask(input: RagSearchInput): Promise<ToolResponse> {
    const question = textValue(input.question || input.query).trim();
    if (!question) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ ask 需要 question');
    const results = await this.retrieve({ ...input, query: question });
    if (results.length === 0) {
      return ToolResponse.success(`🤔 知识库中没有找到与「${question}」相关的信息`, {
        answer: '',
        results: [],
        citations: []
      });
    }
    const includeCitations = input.include_citations ?? true;
    const context = mergeSnippetsGrouped(results, input.max_chars ?? 1200, includeCitations);
    const llm = await this.getLlm();
    const answer = (
      await llm.invoke([
        {
          role: 'system',
          content:
            '你是一个知识助手。严格基于给定上下文回答问题；上下文不足时诚实说明，不要编造信息。'
        },
        {
          role: 'user',
          content: `请基于以下上下文回答问题。\n\n【问题】${question}\n\n【上下文】\n${context}`
        }
      ])
    ).trim();
    if (!answer) return ToolResponse.error(ToolErrorCode.API_ERROR, '❌ LLM 未能生成有效答案');
    const citationText = includeCitations
      ? `\n\n📚 参考来源\n${compactCitationItems(results)
          .map((item) => `[${String(item.index)}] ${cleanSource(item.source_path)}`)
          .join('\n')}`
      : '';
    return ToolResponse.success(answer + citationText, {
      answer,
      results: compactCitationItems(results),
      citations: includeCitations ? compactCitationItems(results) : [],
      namespace: this.targetNamespace(input)
    });
  }

  private async stats(input: RagSearchInput): Promise<ToolResponse> {
    const store = await this.getStore();
    if (!store.getCollectionStats) {
      return ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, '❌ 当前向量存储不支持统计信息');
    }
    const statistics = await store.getCollectionStats();
    return ToolResponse.success(
      `📊 RAG 知识库统计\n📝 命名空间: ${this.targetNamespace(input)}\n📋 集合名称: ${this.collectionName}\n${JSON.stringify(statistics)}`,
      {
        namespace: this.targetNamespace(input),
        collection_name: this.collectionName,
        stats: statistics
      }
    );
  }

  private async clear(input: RagSearchInput): Promise<ToolResponse> {
    if (input.confirm !== true) {
      return ToolResponse.error(
        ToolErrorCode.INVALID_PARAM,
        '⚠️ 清空知识库是危险操作，请传入 confirm=true 确认。'
      );
    }
    const store = await this.getStore();
    if (!store.clearCollection) {
      return ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, '❌ 当前向量存储不支持清空操作');
    }
    const result = await store.clearCollection();
    if (result === false)
      return ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, '❌ 清空知识库失败');
    return ToolResponse.success(
      `✅ 知识库已清空（集合：${this.collectionName}；命名空间过滤不适用于集合级清空）`,
      {
        collection_name: this.collectionName,
        namespace: this.targetNamespace(input),
        cleared: true
      }
    );
  }
}
