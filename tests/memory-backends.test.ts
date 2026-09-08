/**
 * issue #84 真实后端接入测试：把 #84 新增的真实实现（SQLiteDocumentStore /
 * TFIDFEmbedding）注入 #73 建立的 memory types 端口，验证端到端路径——
 * 补足原 memory 测试仅用 fake backends 的空隙。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQLiteDocumentStore } from '../hello_agents/memory/storage/index.js';
import { createEmbeddingModel, toTextEmbedder } from '../hello_agents/memory/embedding.js';
import type { TFIDFEmbedding } from '../hello_agents/memory/embedding.js';
import {
  EpisodicMemory,
  MemoryConfig,
  MemoryItem,
  PerceptualMemory
} from '../hello_agents/memory/index.js';

function freshDocStore(): SQLiteDocumentStore {
  const dir = mkdtempSync(join(tmpdir(), 'ha-mem-backend-'));
  return SQLiteDocumentStore.getInstance(join(dir, 'memory.db'));
}

const TRAIN_CORPUS = [
  'team discussed vector search performance',
  'sqlite stores structured facts',
  'visual observation of the scene',
  'hello world',
  'document store persistence'
];

function tfidfEmbedder() {
  const model = createEmbeddingModel('tfidf') as TFIDFEmbedding;
  // 上游语义：TF-IDF 需先 fit 才能 encode（toTextEmbedder 保持同步契约）
  model.fit(TRAIN_CORPUS);
  return toTextEmbedder(model);
}

function item(id: string, content: string, init: Record<string, unknown> = {}): MemoryItem {
  return new MemoryItem({
    id,
    content,
    memoryType: (init.memoryType as string) ?? 'episodic',
    userId: (init.userId as string) ?? 'u1',
    timestamp: new Date(),
    importance: (init.importance as number) ?? 0.5,
    metadata: (init.metadata as Record<string, unknown>) ?? {}
  });
}

describe('EpisodicMemory + SQLiteDocumentStore + TFIDF', () => {
  test('add persists into the real document store and retrieve reads it back', () => {
    const docStore = freshDocStore();
    const em = new EpisodicMemory(new MemoryConfig({ max_capacity: 20 }), {
      docStore,
      embedder: tfidfEmbedder()
    });
    em.add(
      item('d1', 'team discussed vector search performance', {
        importance: 0.9,
        metadata: { session_id: 's1' }
      })
    );
    em.add(
      item('d2', 'sqlite stores structured facts', {
        importance: 0.7,
        metadata: { session_id: 's1' }
      })
    );

    const stats = docStore.getDatabaseStats();
    expect(Number(stats.memories_count)).toBe(2);

    const hits = em.retrieve('vector search', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain('vector search');
  });

  test('update and delete flow through to the underlying store', () => {
    const docStore = freshDocStore();
    const em = new EpisodicMemory(new MemoryConfig({ max_capacity: 20 }), {
      docStore,
      embedder: tfidfEmbedder()
    });
    const id = em.add(item('d3', 'old version of the note', { importance: 0.5 }));
    expect(docStore.getMemory(id)).toBeDefined();

    // update 为位置参数签名 (content?, importance?, metadata?)
    expect(em.update(id, undefined, 0.95)).toBe(true);
    expect(docStore.getMemory(id)?.importance).toBe(0.95);

    expect(em.remove(id)).toBe(true);
    expect(docStore.getMemory(id)).toBeUndefined();
    expect(docStore.getDatabaseStats().memories_count).toBe(0);
  });
});

describe('PerceptualMemory + SQLiteDocumentStore', () => {
  test('perceptual add/retrieve/delete are backed by the document store', () => {
    const docStore = freshDocStore();
    const pm = new PerceptualMemory(new MemoryConfig({ max_capacity: 20 }), {
      docStore,
      embedder: tfidfEmbedder()
    });
    pm.add(
      item('p1', 'visual observation of the scene', {
        memoryType: 'perceptual',
        importance: 0.8,
        metadata: { modality: 'image' }
      })
    );

    expect(Number(docStore.getDatabaseStats().memories_count)).toBeGreaterThan(0);

    const hits = pm.retrieve('observation', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain('observation');
  });
});

describe('document store surfaces satisfy the memory port contract', () => {
  test('SQLiteDocumentStore implements DocumentStorePort synchronously', () => {
    const docStore = freshDocStore();
    // 端口面编译期检查：DocumentStorePort 要求的方法都存在
    expect(typeof docStore.addMemory).toBe('function');
    expect(typeof docStore.getMemory).toBe('function');
    expect(typeof docStore.searchMemories).toBe('function');
    expect(typeof docStore.updateMemory).toBe('function');
    expect(typeof docStore.deleteMemory).toBe('function');
    expect(typeof docStore.getDatabaseStats).toBe('function');
    // 额外能力
    expect(typeof docStore.addDocument).toBe('function');
  });

  test('TFIDF embedder satisfies TextEmbedder synchronously', () => {
    const embedder = tfidfEmbedder();
    expect(embedder.dimension).toBeGreaterThan(0);
    const vec = embedder.encode('hello world');
    expect(Array.isArray(vec)).toBe(true);
    expect(vec).toHaveLength(embedder.dimension);
  });
});
