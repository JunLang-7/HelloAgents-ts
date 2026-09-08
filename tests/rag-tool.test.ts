import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RAGTool, type RagLlmLike } from '../hello_agents/tools/index.js';
import type { RagVectorStoreLike } from '../hello_agents/memory/rag/index.js';

type VectorRequest = {
  vectors: number[][];
  metadata: Array<Record<string, unknown>>;
  ids: string[];
};
type SearchRequest = {
  queryVector: number[];
  limit: number;
  score_threshold?: number;
  where?: Record<string, unknown>;
};

class DeterministicEmbedder {
  public readonly dimension = 3;
  public readonly calls: string[][] = [];

  public encode(texts: string | string[]): number[][] {
    const values = typeof texts === 'string' ? [texts] : texts;
    this.calls.push([...values]);
    return values.map((value) => [1, value.length, 0]);
  }
}

class FakeRagStore implements RagVectorStoreLike {
  public readonly adds: VectorRequest[] = [];
  public readonly searches: SearchRequest[] = [];
  public clearCalls = 0;
  public hits: Array<{
    id: string;
    score: number;
    metadata: Record<string, unknown>;
  }> = [];

  public addVectors(request: VectorRequest): boolean {
    this.adds.push(request);
    return true;
  }

  public searchSimilar(request: SearchRequest) {
    this.searches.push(request);
    return this.hits.slice(0, request.limit);
  }

  public getCollectionStats(): Record<string, unknown> {
    return { points_count: this.adds.reduce((total, request) => total + request.ids.length, 0) };
  }

  public clearCollection(): boolean {
    this.clearCalls += 1;
    this.adds.length = 0;
    this.hits = [];
    return true;
  }
}

class FakeLlm implements RagLlmLike {
  public calls: Array<ReadonlyArray<{ role: string; content: string }>> = [];

  public invoke(messages: ReadonlyArray<{ role: string; content: string }>): string {
    this.calls.push(messages);
    return '基于上下文的答案';
  }
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTool(
  options: {
    store?: FakeRagStore;
    embedder?: DeterministicEmbedder;
    llm?: RagLlmLike;
    llmFactory?: () => RagLlmLike;
    expandable?: boolean;
  } = {}
): {
  tool: RAGTool;
  store: FakeRagStore;
  embedder: DeterministicEmbedder;
  knowledgeBasePath: string;
} {
  const store = options.store ?? new FakeRagStore();
  const embedder = options.embedder ?? new DeterministicEmbedder();
  const knowledgeBasePath = mkdtempSync(join(tmpdir(), 'hello-agents-rag-tool-'));
  temporaryDirectories.push(knowledgeBasePath);
  return {
    store,
    embedder,
    knowledgeBasePath,
    tool: new RAGTool({
      knowledgeBasePath,
      store,
      embedder,
      ...(options.llm === undefined ? {} : { llm: options.llm }),
      ...(options.llmFactory === undefined ? {} : { llmFactory: options.llmFactory }),
      ...(options.expandable === undefined ? {} : { expandable: options.expandable })
    })
  };
}

describe('RAGTool action dispatch', () => {
  test('constructs without invoking the LLM and dispatches add_text/search/stats', async () => {
    const store = new FakeRagStore();
    let factoryCalls = 0;
    const { tool, embedder } = makeTool({
      store,
      llmFactory: () => {
        factoryCalls += 1;
        return new FakeLlm();
      }
    });

    expect(factoryCalls).toBe(0);
    const added = await tool.execute({
      action: 'add_text',
      text: '# Deployment\n\nThe service uses a deterministic test backend.',
      document_id: 'deployment'
    });
    expect(added.status).toBe('success');
    expect(added.data).toMatchObject({
      chunks_added: 1,
      document_id: 'deployment',
      namespace: 'default'
    });
    expect(store.adds).toHaveLength(1);
    expect(embedder.calls).toEqual([['The service uses a deterministic test backend.']]);

    store.hits = [
      {
        id: 'chunk-1',
        score: 0.91,
        metadata: {
          memory_id: 'chunk-1',
          doc_id: 'deployment',
          source_path: 'deployment.md',
          start: 0,
          end: 55,
          content: 'The service uses a deterministic test backend.'
        }
      }
    ];
    const search = await tool.execute({ action: 'search', query: 'test backend' });
    expect(search.status).toBe('success');
    expect(search.text).toContain('deterministic test backend');
    expect(search.text).toContain('References:');
    expect(search.data).toMatchObject({ query: 'test backend', namespace: 'default' });
    expect(search.data.citations).toHaveLength(1);

    const stats = await tool.execute({ action: 'stats' });
    expect(stats.status).toBe('success');
    expect(stats.data).toMatchObject({
      collection_name: 'rag_knowledge_base',
      stats: { points_count: 1 }
    });
    expect(factoryCalls).toBe(0);
  });

  test('asks the injected LLM lazily and appends stable citations', async () => {
    const llm = new FakeLlm();
    const { tool, store } = makeTool({ llm });
    store.hits = [
      {
        id: 'chunk-ask',
        score: 0.8,
        metadata: {
          memory_id: 'chunk-ask',
          doc_id: 'doc-ask',
          source_path: '/knowledge/answer.md',
          start: 4,
          end: 20,
          content: 'The answer is in the indexed context.'
        }
      }
    ];

    expect(llm.calls).toHaveLength(0);
    const answer = await tool.execute({ action: 'ask', question: 'Where is the answer?' });
    expect(answer.status).toBe('success');
    expect(answer.text).toContain('基于上下文的答案');
    expect(answer.text).toContain('📚 参考来源');
    expect(answer.text).toContain('/knowledge/answer.md');
    expect(answer.data).toMatchObject({ answer: '基于上下文的答案', namespace: 'default' });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.[1]?.content).toContain('Where is the answer?');
  });

  test('loads a supported local document through the same injected indexing seam', async () => {
    const { tool, knowledgeBasePath, store } = makeTool();
    const filePath = join(knowledgeBasePath, 'guide.md');
    writeFileSync(filePath, '# Guide\n\nUse the local native loader.', 'utf8');

    const added = await tool.execute({
      action: 'add_document',
      file_path: filePath,
      namespace: 'docs'
    });
    expect(added.status).toBe('success');
    expect(added.data).toMatchObject({
      chunks_added: 1,
      file_path: filePath,
      namespace: 'docs'
    });
    expect(store.adds[0]?.metadata[0]).toMatchObject({
      rag_namespace: 'docs',
      source_path: filePath,
      format: 'markdown'
    });
  });

  test('returns structured validation and backend errors', async () => {
    const { tool } = makeTool();
    const missingFile = await tool.execute({
      action: 'add_document',
      file_path: '/does/not/exist.md'
    });
    expect(missingFile.status).toBe('error');
    expect(missingFile.errorInfo?.code).toBe('NOT_FOUND');

    const missingText = await tool.execute({ action: 'add_text', text: '   ' });
    expect(missingText.status).toBe('error');
    expect(missingText.errorInfo?.code).toBe('INVALID_PARAM');

    const unsupported = await tool.execute({ action: 'unknown' });
    expect(unsupported.status).toBe('error');
    expect(unsupported.errorInfo?.code).toBe('INVALID_PARAM');

    const invalidInput = await tool.execute({ action: 'search', query: '', limit: 0 });
    expect(invalidInput.status).toBe('error');
    expect(invalidInput.errorInfo?.code).toBe('INVALID_PARAM');
  });

  test('requires confirmation before clear and then clears the collection', async () => {
    const { tool, store } = makeTool();
    const rejected = await tool.execute({ action: 'clear' });
    expect(rejected.status).toBe('error');
    expect(rejected.errorInfo?.code).toBe('INVALID_PARAM');
    expect(store.clearCalls).toBe(0);

    const cleared = await tool.execute({ action: 'clear', confirm: true, namespace: 'kb' });
    expect(cleared.status).toBe('success');
    expect(cleared.text).toContain('知识库已清空');
    expect(cleared.data).toMatchObject({
      collection_name: 'rag_knowledge_base',
      namespace: 'kb',
      cleared: true
    });
    expect(store.clearCalls).toBe(1);
  });

  test('exposes action-specific tools when expandable is enabled', async () => {
    const llm = new FakeLlm();
    const { tool } = makeTool({ expandable: true, llm });
    const expanded = tool.getExpandedTools();
    expect(expanded?.map((item) => item.name)).toEqual([
      'rag_add_document',
      'rag_add_text',
      'rag_ask',
      'rag_search',
      'rag_stats',
      'rag_clear'
    ]);

    const statsTool = expanded?.find((item) => item.name === 'rag_stats');
    expect(statsTool).toBeDefined();
    expect((await statsTool!.execute({})).status).toBe('success');
  });
});
