/**
 * QdrantVectorStore / QdrantConnectionManager 真实服务集成测试
 * （对应源文件 hello_agents/memory/storage/qdrant-store.ts；
 * issue #84 验收："可重现的真实服务集成，记录后端版本与结果"）。
 *
 * 运行条件：
 * - 本机需要 docker（自动探测）；无 docker 或 `HELLOAGENTS_DB_INTEGRATION=0`
 *   时整组 skip，CI 默认不执行。
 * - 端口 6333：若已被同版本服务占用则复用，否则自动拉起容器并在结束后删除。
 *
 * 后端版本记录：测试输出（stdout）打印 Qdrant 服务版本；PR 描述同步记录。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';

import {
  QdrantConnectionManager,
  QdrantVectorStore
} from '../hello_agents/memory/storage/index.js';
import {
  cleanupTrackedContainers,
  dockerAvailable,
  ensureQdrant,
  portOpen
} from './helpers/db-test-utils.js';

let version = 'unknown';

beforeAll(
  async () => {
    if (!dockerAvailable()) return;
    const info = await ensureQdrant();
    version = info.version;
    process.stdout.write(`[db-integration] Qdrant version=${version}\n`);
  },
  // docker 拉镜像 + 起服务可能耗时较长（首次可达数分钟）
  600_000
);

afterAll(() => {
  QdrantConnectionManager.resetForTesting();
  cleanupTrackedContainers();
});

const COLLECTION = `ha_test_${randomUUID().slice(0, 8)}`;

describe.skipIf(!dockerAvailable())('QdrantVectorStore real service integration', () => {
  const dim = 16;

  test('health check reports true against a live server', async () => {
    const store = new QdrantVectorStore({
      collection_name: COLLECTION,
      vector_size: dim,
      distance: 'cosine',
      timeout: 10
    });
    expect(await store.healthCheck()).toBe(true);
  });

  test('addVectors persists vectors and searchSimilar returns ranked hits with metadata', async () => {
    const store = new QdrantVectorStore({
      collection_name: COLLECTION,
      vector_size: dim,
      distance: 'cosine',
      timeout: 10
    });
    const vec = (i: number) => Array.from({ length: dim }, (_, k) => (k === i % dim ? 1 : 0));
    const ok = await store.addVectors({
      vectors: [vec(0), vec(1), vec(2)],
      metadata: [
        { memory_id: 'm-1', memory_type: 'episodic', content: 'alpha' },
        { memory_id: 'm-2', memory_type: 'episodic', content: 'beta' },
        { memory_id: 'm-3', memory_type: 'semantic', content: 'gamma' }
      ],
      ids: ['m-1', 'm-2', 'm-3']
    });
    expect(ok).toBe(true);

    const hits = await store.searchSimilar({ queryVector: vec(0), limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    // 非 UUID 点 ID 会被替换为 UUID（上游语义），原 id 保存在 payload.memory_id
    expect(hits[0]?.metadata.memory_id).toBe('m-1');
    expect(hits[0]?.score).toBeGreaterThan(0.9);
    // 时间戳注入
    expect(typeof hits[0]?.metadata.timestamp).toBe('number');
    expect(typeof hits[0]?.metadata.added_at).toBe('number');
  });

  test('searchSimilar filters by payload where', async () => {
    const store = new QdrantVectorStore({
      collection_name: COLLECTION,
      vector_size: dim,
      distance: 'cosine',
      timeout: 10
    });
    const hits = await store.searchSimilar({
      queryVector: Array.from({ length: dim }, (_, k) => (k === 1 ? 1 : 0)),
      limit: 10,
      where: { memory_type: 'semantic' }
    });
    expect(hits.every((h) => h.metadata.memory_type === 'semantic')).toBe(true);
    expect(hits.some((h) => h.metadata.memory_id === 'm-3')).toBe(true);
  });

  test('addVectors skips dimension-mismatched points and returns false when none valid', async () => {
    const store = new QdrantVectorStore({
      collection_name: COLLECTION,
      vector_size: dim,
      distance: 'cosine',
      timeout: 10
    });
    const ok = await store.addVectors({
      vectors: [[1, 2, 3]], // 维度 3 != 16
      metadata: [{ memory_id: 'bad' }],
      ids: ['bad']
    });
    expect(ok).toBe(false);
  });

  test('searchSimilar with a wrong-dimension query returns []', async () => {
    const store = new QdrantVectorStore({
      collection_name: COLLECTION,
      vector_size: dim,
      distance: 'cosine',
      timeout: 10
    });
    expect(await store.searchSimilar({ queryVector: [1, 2, 3], limit: 5 })).toEqual([]);
  });

  test('deleteMemories removes points by payload memory_id', async () => {
    const store = new QdrantVectorStore({
      collection_name: COLLECTION,
      vector_size: dim,
      distance: 'cosine',
      timeout: 10
    });
    await store.deleteMemories(['m-1']);
    const hits = await store.searchSimilar({
      queryVector: Array.from({ length: dim }, (_, k) => (k === 0 ? 1 : 0)),
      limit: 10
    });
    expect(hits.some((h) => h.metadata.memory_id === 'm-1')).toBe(false);
  });

  test('getCollectionStats and getCollectionInfo report store metadata', async () => {
    const store = new QdrantVectorStore({
      collection_name: COLLECTION,
      vector_size: dim,
      distance: 'cosine',
      timeout: 10
    });
    const stats = await store.getCollectionStats();
    expect(stats.store_type).toBe('qdrant');
    expect(stats.name).toBe(COLLECTION);
    expect(Number(stats.points_count)).toBeGreaterThan(0);
    const info = await store.getCollectionInfo();
    expect(info.config).toMatchObject({ vector_size: dim, distance: 'Cosine' });
  });

  test('clearCollection empties the collection and it stays usable', async () => {
    const store = new QdrantVectorStore({
      collection_name: COLLECTION,
      vector_size: dim,
      distance: 'cosine',
      timeout: 10
    });
    expect(await store.clearCollection()).toBe(true);
    const hits = await store.searchSimilar({
      queryVector: Array.from({ length: dim }, (_, k) => (k === 0 ? 1 : 0)),
      limit: 10
    });
    expect(hits).toHaveLength(0);
    // 清空后可继续写入
    await store.addVectors({
      vectors: [Array.from({ length: dim }, () => 1)],
      metadata: [{ memory_id: 'post-clear' }],
      ids: ['post-clear']
    });
    expect(await store.healthCheck()).toBe(true);
  });

  test('QdrantConnectionManager reuses a single instance per key', () => {
    const a = QdrantConnectionManager.getInstance({
      collection_name: COLLECTION,
      vector_size: dim
    });
    const b = QdrantConnectionManager.getInstance({
      collection_name: COLLECTION,
      vector_size: dim
    });
    expect(a).toBe(b);
    const c = QdrantConnectionManager.getInstance({
      collection_name: 'other_collection',
      vector_size: dim
    });
    expect(c).not.toBe(a);
  });
});

describe('QdrantVectorStore offline behavior', () => {
  test('healthCheck returns false when the server is unreachable', async () => {
    const store = new QdrantVectorStore({
      url: 'http://localhost:6334',
      collection_name: 'nope',
      vector_size: 8,
      timeout: 1
    });
    expect(await store.healthCheck()).toBe(false);
  });

  test('port 6333 is reachable when docker is available', async () => {
    if (!dockerAvailable()) return;
    expect(await portOpen(6333)).toBe(true);
  });
});
