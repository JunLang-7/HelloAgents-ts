/**
 * End-to-end RAG/Qdrant coverage.
 *
 * This suite is opt-in through the shared Docker capability check. It reuses
 * the Qdrant service prepared by the database integration tests (or starts one
 * through ensureQdrant when this file is run on its own), but deliberately does
 * not own container cleanup. Each test uses an isolated collection.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  indexChunks,
  searchVectors,
  type RagChunk,
  type RagEmbedderLike
} from '../hello_agents/memory/rag/index.js';
import { QdrantVectorStore } from '../hello_agents/memory/storage/index.js';
import { RAGTool } from '../hello_agents/tools/index.js';
import { dockerAvailable, ensureQdrant } from './helpers/db-test-utils.js';

const QDRANT_URL = 'http://localhost:6333';

let qdrantVersion = 'unknown';

beforeAll(async () => {
  if (!dockerAvailable()) return;
  const info = await ensureQdrant();
  qdrantVersion = info.version;
  process.stdout.write(`[db-integration] RAG Qdrant version=${qdrantVersion}\n`);
}, 600_000);

class DeterministicEmbedder implements RagEmbedderLike {
  public readonly dimension = 4;

  public encode(texts: string | string[]): number[][] {
    const values = typeof texts === 'string' ? [texts] : texts;
    return values.map((text) => (/blueberry/iu.test(text) ? [1, 0, 0, 0] : [0, 1, 0, 0]));
  }
}

function makeChunk(id: string, content: string): RagChunk {
  return {
    id,
    content,
    metadata: {
      source_path: `/tmp/${id}.md`,
      file_ext: '.md',
      doc_id: `doc-${id}`,
      lang: 'unknown',
      start: 0,
      end: Array.from(content).length,
      content_hash: id,
      namespace: 'e2e',
      source: 'rag-e2e-test',
      external: true,
      heading_path: 'RAG E2E',
      format: 'markdown'
    }
  };
}

describe.skipIf(!dockerAvailable())('RAG pipeline real Qdrant integration', () => {
  test('indexes chunks into Qdrant and retrieves them through searchVectors', async () => {
    const collection = `ha_rag_pipeline_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const store = new QdrantVectorStore({
      url: QDRANT_URL,
      collection_name: collection,
      vector_size: 4,
      distance: 'cosine',
      timeout: 30
    });
    const embedder = new DeterministicEmbedder();

    await indexChunks({
      store,
      embedder,
      chunks: [makeChunk('chunk-blueberry', 'Blueberry retrieval survives the Qdrant round trip.')],
      ragNamespace: 'e2e'
    });
    const hits = await searchVectors({
      store,
      embedder,
      query: 'blueberry',
      topK: 3,
      ragNamespace: 'e2e',
      scoreThreshold: 0.9
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.metadata).toMatchObject({
      memory_id: 'chunk-blueberry',
      is_rag_data: true,
      data_source: 'rag_pipeline',
      rag_namespace: 'e2e'
    });
    const stats = await store.getCollectionStats();
    process.stdout.write(
      `[db-integration] RAG pipeline collection=${collection} points=${String(stats.points_count)}\n`
    );
    expect(Number(stats.points_count)).toBeGreaterThan(0);

    // Keep the isolated collection from accumulating across repeated local
    // runs; this does not manage the shared Qdrant container.
    expect(await store.clearCollection()).toBe(true);
  }, 120_000);

  test('RAGTool add_text/search uses a real Qdrant collection with an injected embedder', async () => {
    const collection = `ha_rag_tool_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const knowledgeBasePath = mkdtempSync(join(tmpdir(), 'hello-agents-rag-e2e-'));
    const tool = new RAGTool({
      knowledgeBasePath,
      qdrantUrl: QDRANT_URL,
      collectionName: collection,
      ragNamespace: 'e2e-tool',
      embedder: new DeterministicEmbedder()
    });

    try {
      const added = await tool.execute({
        action: 'add_text',
        text: '# Qdrant RAG\n\nBlueberry facts are searchable through the real backend.',
        document_id: `e2e_${collection}`
      });
      expect(added.status).toBe('success');
      expect(added.data).toMatchObject({ namespace: 'e2e-tool', chunks_added: 1 });

      const search = await tool.execute({
        action: 'search',
        query: 'blueberry',
        namespace: 'e2e-tool',
        include_citations: true
      });
      expect(search.status).toBe('success');
      expect(search.text).toContain('Blueberry facts');
      expect(search.text).toContain('References:');
      expect(search.data.results).toHaveLength(1);

      const stats = await tool.execute({ action: 'stats', namespace: 'e2e-tool' });
      expect(stats.status).toBe('success');
      const collectionStats = stats.data.stats as Record<string, unknown>;
      process.stdout.write(
        `[db-integration] RAG tool collection=${collection} points=${String(collectionStats.points_count)}\n`
      );
      expect(Number(collectionStats.points_count)).toBeGreaterThan(0);
    } finally {
      // Collection cleanup is intentionally best-effort and scoped to this
      // random collection; container lifecycle remains with shared tests.
      await tool.execute({ action: 'clear', confirm: true, namespace: 'e2e-tool' });
      rmSync(knowledgeBasePath, { recursive: true, force: true });
    }
  }, 120_000);
});
