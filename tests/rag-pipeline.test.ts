import { describe, expect, test } from 'bun:test';

import {
  buildGraphFromChunks,
  chunkParagraphs,
  compressRankedItems,
  computeGraphSignalsFromPool,
  embedQuery,
  expandNeighborsFromPool,
  indexChunks,
  mergeSnippets,
  mergeSnippetsGrouped,
  preprocessMarkdownForEmbedding,
  rank,
  rerankWithCrossEncoder,
  searchVectors,
  searchVectorsExpanded,
  splitParagraphsWithHeadings,
  tldrSummarize,
  type RagChunk,
  type RagEmbedderLike,
  type RagGraphStoreLike,
  type RagSearchItem,
  type RagVectorStoreLike
} from '../hello_agents/memory/rag/index.js';

const chunk = (id: string, content: string, docId = 'doc-1', start = 0): RagChunk => ({
  id,
  content,
  metadata: {
    source_path: `/tmp/${docId}.md`,
    file_ext: '.md',
    doc_id: docId,
    lang: 'unknown',
    start,
    end: start + content.length,
    content_hash: `hash-${id}`,
    namespace: 'default',
    source: 'test',
    external: true,
    heading_path: 'Guide',
    format: 'markdown'
  }
});

class FakeEmbedder implements RagEmbedderLike {
  public readonly dimension = 3;
  public calls: string[][] = [];

  public encode(texts: string | string[]): number[][] {
    const inputs = typeof texts === 'string' ? [texts] : texts;
    this.calls.push([...inputs]);
    return inputs.map((text, index) => [text.length, index + 1, 1]);
  }
}

class FakeVectorStore implements RagVectorStoreLike {
  public request: {
    vectors: number[][];
    metadata: Array<Record<string, unknown>>;
    ids: string[];
  } | null = null;
  public searchRequests: Array<Record<string, unknown>> = [];
  public hits: VectorHit[] = [];

  public addVectors(request: {
    vectors: number[][];
    metadata: Array<Record<string, unknown>>;
    ids: string[];
  }): boolean {
    this.request = request;
    return true;
  }

  public searchSimilar(request: {
    queryVector: number[];
    limit: number;
    score_threshold?: number;
    where?: Record<string, unknown>;
  }): VectorHit[] {
    this.searchRequests.push(request as unknown as Record<string, unknown>);
    return this.hits.slice(0, request.limit);
  }
}

type VectorHit = {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
};

class FakeGraphStore implements RagGraphStoreLike {
  public entities: Array<Record<string, unknown>> = [];
  public relationships: Array<Record<string, unknown>> = [];

  public async addEntity(request: Record<string, unknown>): Promise<boolean> {
    this.entities.push(request);
    return true;
  }

  public async addRelationship(request: Record<string, unknown>): Promise<boolean> {
    this.relationships.push(request);
    return true;
  }
}

describe('RAG async vector and graph core', () => {
  test('chunkParagraphs always advances when overlap cannot fit the next paragraph', () => {
    const paragraphs = splitParagraphsWithHeadings('one two three\n\nfour five six');
    const chunks = chunkParagraphs(paragraphs, 3, 99);
    expect(chunks.map((entry) => entry.content)).toEqual(['one two three', 'four five six']);
  });

  test('preprocesses Markdown without loading an optional model', () => {
    expect(
      preprocessMarkdownForEmbedding('# Heading\n\n**bold** [link](https://example.com)')
    ).toBe('Heading\n\nbold link');
  });

  test('indexChunks awaits injected embedder/store and writes RAG metadata', async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeVectorStore();
    await indexChunks({
      store,
      embedder,
      chunks: [chunk('c1', '# One'), chunk('c2', 'Two', 'doc-2', 4)],
      batchSize: 1,
      ragNamespace: 'kb'
    });

    expect(embedder.calls).toEqual([['One'], ['Two']]);
    expect(store.request?.ids).toEqual(['c1', 'c2']);
    expect(store.request?.vectors).toHaveLength(2);
    expect(store.request?.metadata[0]).toMatchObject({
      memory_id: 'c1',
      memory_type: 'rag_chunk',
      data_source: 'rag_pipeline',
      rag_namespace: 'kb',
      is_rag_data: true,
      content: '# One'
    });
  });

  test('embedQuery pads/truncates dimensions and falls back to zeros', async () => {
    const embedder = new FakeEmbedder();
    expect(await embedQuery('query', { embedder, dimension: 5 })).toEqual([5, 1, 1, 0, 0]);
    const failing: RagEmbedderLike = {
      dimension: 4,
      encode: () => Promise.reject(new Error('offline'))
    };
    expect(await embedQuery('query', { embedder: failing })).toEqual([0, 0, 0, 0]);
  });

  test('searchVectors builds RAG filters and returns injected store hits', async () => {
    const embedder = new FakeEmbedder();
    const store = new FakeVectorStore();
    store.hits = [{ id: 'c1', score: 0.9, metadata: { memory_id: 'c1' } }];
    const result = await searchVectors({
      store,
      embedder,
      query: 'what?',
      topK: 3,
      ragNamespace: 'kb',
      scoreThreshold: 0.2
    });
    expect(result).toEqual(store.hits);
    expect(store.searchRequests[0]?.where).toEqual({
      memory_type: 'rag_chunk',
      is_rag_data: true,
      data_source: 'rag_pipeline',
      rag_namespace: 'kb'
    });
    expect(store.searchRequests[0]?.score_threshold).toBe(0.2);
  });

  test('buildGraphFromChunks awaits object-shaped Neo4j requests and deduplicates documents', async () => {
    const graph = new FakeGraphStore();
    await buildGraphFromChunks(graph, [chunk('c1', 'one'), chunk('c2', 'two', 'doc-1', 4)]);
    expect(graph.entities).toHaveLength(3);
    expect(graph.entities.filter((entity) => entity.entity_type === 'Document')).toHaveLength(1);
    expect(graph.entities.filter((entity) => entity.entity_type === 'Memory')).toHaveLength(2);
    expect(graph.relationships).toEqual([
      expect.objectContaining({
        from_entity_id: 'doc-1',
        to_entity_id: 'c1',
        relationship_type: 'HAS_CHUNK'
      }),
      expect.objectContaining({
        from_entity_id: 'doc-1',
        to_entity_id: 'c2',
        relationship_type: 'HAS_CHUNK'
      })
    ]);
  });

  test('graph signals, rank, snippets, neighbors, grouping, and compression are deterministic', () => {
    const hits: RagSearchItem[] = [
      {
        id: 'c1',
        score: 0.8,
        metadata: { memory_id: 'c1', doc_id: 'd1', start: 0, content: 'alpha' }
      },
      {
        id: 'c2',
        score: 0.4,
        metadata: { memory_id: 'c2', doc_id: 'd1', start: 100, content: 'beta' }
      },
      {
        id: 'c3',
        score: 0.1,
        metadata: { memory_id: 'c3', doc_id: 'd2', start: 0, content: 'gamma' }
      }
    ];
    const signals = computeGraphSignalsFromPool(hits, 1, 1, 200);
    expect(signals.c1).toBeGreaterThan(signals.c3!);
    const ranked = rank(hits, signals);
    expect(ranked[0]?.memory_id).toBe('c1');
    expect(mergeSnippets(ranked, 9)).toBe('alpha\n\nbeta');

    const neighbors = expandNeighborsFromPool(
      [ranked[0]!],
      [
        ...ranked,
        { id: 'c4', score: 0.1, metadata: { memory_id: 'c4', doc_id: 'd1', start: 200 } }
      ],
      1,
      1
    );
    expect(neighbors.map((item) => item.memory_id)).toContain('c2');

    const grouped = mergeSnippetsGrouped(ranked, 200, true);
    expect(grouped).toContain('[1]');
    expect(grouped).toContain('References:');
    expect(grouped).toContain('[1] d1');

    const compressed = compressRankedItems(
      [
        { id: 'a', score: 0.6, content: 'a', metadata: { doc_id: 'd', start: 0, end: 10 } },
        { id: 'b', score: 0.9, content: 'b', metadata: { doc_id: 'd', start: 20, end: 30 } }
      ],
      true,
      2,
      20
    );
    expect(compressed).toHaveLength(1);
    expect(compressed[0]?.content).toBe('a\n\nb');
    expect(compressed[0]?.score).toBe(0.9);
  });

  test('expanded search uses injected MQE/HyDE seams and deterministic fallback', async () => {
    const store = new FakeVectorStore();
    const embedder = new FakeEmbedder();
    store.hits = [{ id: 'c1', score: 0.5, metadata: { memory_id: 'c1' } }];
    const result = await searchVectorsExpanded({
      store,
      embedder,
      query: 'base',
      topK: 2,
      enableMqe: true,
      enableHyde: true,
      queryExpander: async () => ['expanded'],
      hydeGenerator: async () => 'hypothetical'
    });
    expect(result).toHaveLength(1);
    expect(embedder.calls.map((call) => call[0])).toEqual(['base', 'expanded', 'hypothetical']);

    const fallback = await searchVectorsExpanded({
      store,
      embedder,
      query: 'base',
      enableMqe: true,
      enableHyde: true
    });
    expect(fallback).toHaveLength(1);
  });

  test('reranker is optional and injected failures preserve vector order', async () => {
    const items: RagSearchItem[] = [
      { id: 'a', score: 0.4 },
      { id: 'b', score: 0.8 }
    ];
    expect((await rerankWithCrossEncoder('q', items)).map((item) => item.id)).toEqual(['a', 'b']);
    const reranked = await rerankWithCrossEncoder('q', items, async () => [0.1, 0.9]);
    expect(reranked.map((item) => item.id)).toEqual(['b', 'a']);
    const failed = await rerankWithCrossEncoder('q', items, async () => {
      throw new Error('optional scorer unavailable');
    });
    expect(failed).toHaveLength(2);
  });

  test('tldr summarization is lazy, injectable, and rejects empty input', async () => {
    const calls: unknown[] = [];
    const summary = await tldrSummarize('important content', 99, {
      invoke: async (messages) => {
        calls.push(messages);
        return '- concise point';
      }
    });
    expect(summary).toBe('- concise point');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('5 条要点') })
      ])
    );
    expect(await tldrSummarize('  ', 3)).toBeNull();
  });
});
