import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQLiteDocumentStore } from '../hello_agents/memory/storage/index.js';
import type { DocumentStore } from '../hello_agents/memory/storage/index.js';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'helloagents-docstore-'));
  dbPath = join(dir, 'memory.db');
});

afterEach(() => {
  SQLiteDocumentStore.resetForTesting();
});

describe('SQLiteDocumentStore (real temporary database)', () => {
  test('addMemory persists a memory and getMemory reads it back', () => {
    const store = SQLiteDocumentStore.getInstance(dbPath);
    store.addMemory({
      memory_id: 'm1',
      user_id: 'user-a',
      content: 'hello world',
      memory_type: 'episodic',
      timestamp: 1_700_000_000,
      importance: 0.9,
      properties: { session_id: 's1', tags: ['a', 'b'] }
    });
    const doc = store.getMemory('m1');
    expect(doc).not.toBeNull();
    expect(doc?.memory_id).toBe('m1');
    expect(doc?.user_id).toBe('user-a');
    expect(doc?.content).toBe('hello world');
    expect(doc?.memory_type).toBe('episodic');
    expect(doc?.timestamp).toBe(1_700_000_000);
    expect(doc?.importance).toBe(0.9);
    expect(doc?.properties).toEqual({ session_id: 's1', tags: ['a', 'b'] });
  });

  test('getMemory returns undefined for a missing id', () => {
    const store = SQLiteDocumentStore.getInstance(dbPath);
    expect(store.getMemory('missing')).toBeUndefined();
  });

  test('addMemory replaces an existing row (INSERT OR REPLACE semantics)', () => {
    const store = SQLiteDocumentStore.getInstance(dbPath);
    store.addMemory({
      memory_id: 'm-replace',
      user_id: 'user-a',
      content: 'first',
      memory_type: 'episodic',
      timestamp: 100,
      importance: 0.1,
      properties: {}
    });
    store.addMemory({
      memory_id: 'm-replace',
      user_id: 'user-a',
      content: 'second',
      memory_type: 'episodic',
      timestamp: 200,
      importance: 0.2,
      properties: { v: 2 }
    });
    const doc = store.getMemory('m-replace');
    expect(doc?.content).toBe('second');
    expect(doc?.timestamp).toBe(200);
    expect(doc?.properties).toEqual({ v: 2 });
  });

  test('searchMemories filters by user, type, time window and importance, ordered by importance desc then timestamp desc', () => {
    // 独立数据库，避免与同一 beforeAll 路径下的其他用例数据混合
    const searchPath = join(dir, 'search.db');
    const store = SQLiteDocumentStore.getInstance(searchPath);
    const rows = [
      { id: 'a', user: 'u1', type: 'episodic', ts: 100, imp: 0.3 },
      { id: 'b', user: 'u1', type: 'episodic', ts: 200, imp: 0.9 },
      { id: 'c', user: 'u1', type: 'semantic', ts: 300, imp: 0.5 },
      { id: 'd', user: 'u2', type: 'episodic', ts: 400, imp: 0.7 }
    ];
    for (const r of rows) {
      store.addMemory({
        memory_id: r.id,
        user_id: r.user,
        content: r.id,
        memory_type: r.type,
        timestamp: r.ts,
        importance: r.imp,
        properties: {}
      });
    }

    expect(store.searchMemories({ user_id: 'u1' }).map((d) => d.memory_id)).toEqual([
      'b',
      'c',
      'a'
    ]);
    expect(
      store.searchMemories({ memory_type: 'episodic', user_id: 'u1' }).map((d) => d.memory_id)
    ).toEqual(['b', 'a']);
    expect(
      store.searchMemories({ start_time: 150, end_time: 350 }).map((d) => d.memory_id)
    ).toEqual(['b', 'c']);
    expect(store.searchMemories({ importance_threshold: 0.6 }).map((d) => d.memory_id)).toEqual([
      'b',
      'd'
    ]);
    expect(store.searchMemories({ limit: 2 }).map((d) => d.memory_id)).toEqual(['b', 'd']);
    expect(store.searchMemories()).toHaveLength(4);
  });

  test('updateMemory updates content/importance/properties and returns false for no-op', () => {
    const store = SQLiteDocumentStore.getInstance(dbPath);
    store.addMemory({
      memory_id: 'u1',
      user_id: 'user-a',
      content: 'old',
      memory_type: 'episodic',
      timestamp: 100,
      importance: 0.5,
      properties: { k: 'v' }
    });
    expect(store.updateMemory({ memory_id: 'u1', content: 'new', importance: 0.8 })).toBe(true);
    const doc = store.getMemory('u1');
    expect(doc?.content).toBe('new');
    expect(doc?.importance).toBe(0.8);
    expect(doc?.properties).toEqual({ k: 'v' });
    expect(store.updateMemory({ memory_id: 'u1', properties: { k: 'v2' } })).toBe(true);
    expect(store.getMemory('u1')?.properties).toEqual({ k: 'v2' });
    // 空更新返回 false
    expect(store.updateMemory({ memory_id: 'u1' })).toBe(false);
    // 不存在的 id 返回 false
    expect(store.updateMemory({ memory_id: 'nope', content: 'x' })).toBe(false);
  });

  test('deleteMemory removes the row and returns false for a missing id', () => {
    const store = SQLiteDocumentStore.getInstance(dbPath);
    store.addMemory({
      memory_id: 'd1',
      user_id: 'user-a',
      content: 'x',
      memory_type: 'episodic',
      timestamp: 1,
      importance: 0.5,
      properties: {}
    });
    expect(store.deleteMemory('d1')).toBe(true);
    expect(store.getMemory('d1')).toBeUndefined();
    expect(store.deleteMemory('d1')).toBe(false);
  });

  test('getDatabaseStats reports table counts, memory type distribution and top users', () => {
    const store = SQLiteDocumentStore.getInstance(dbPath);
    const stats = store.getDatabaseStats();
    expect(stats.store_type).toBe('sqlite');
    expect(stats.db_path).toBe(dbPath);
    expect(typeof stats.memories_count).toBe('number');
    expect(typeof stats.users_count).toBe('number');
    expect(typeof stats.concepts_count).toBe('number');
    expect(typeof stats.memory_types).toBe('object');
    expect(typeof stats.top_users).toBe('object');
  });

  test('addDocument creates a document-type memory with uuid id and system user', () => {
    const store = SQLiteDocumentStore.getInstance(dbPath);
    const docId = store.addDocument('some document content', { source: 'book' });
    expect(typeof docId).toBe('string');
    expect(docId.length).toBeGreaterThan(0);
    const doc = store.getDocument(docId);
    expect(doc?.memory_type).toBe('document');
    expect(doc?.content).toBe('some document content');
    expect(doc?.user_id).toBe('system');
    expect(doc?.properties).toMatchObject({ source: 'book' });
    expect(doc?.importance).toBe(0.5);
  });

  test('getInstance is a per-path singleton', () => {
    const a = SQLiteDocumentStore.getInstance(dbPath);
    const b = SQLiteDocumentStore.getInstance(dbPath);
    expect(a).toBe(b);
    const other = join(dir, 'other.db');
    const c = SQLiteDocumentStore.getInstance(other);
    expect(c).not.toBe(a);
  });
});

describe('SQLiteDocumentStore persistence across reopen', () => {
  test('data survives close and reopen of a real file database', () => {
    const path = join(dir, 'persist.db');
    SQLiteDocumentStore.resetForTesting();

    const first = SQLiteDocumentStore.getInstance(path);
    first.addMemory({
      memory_id: 'persist-1',
      user_id: 'user-a',
      content: 'persisted content',
      memory_type: 'semantic',
      timestamp: 1_700_000_100,
      importance: 0.75,
      properties: { note: 'kept' }
    });
    first.close();

    SQLiteDocumentStore.resetForTesting();
    const second = SQLiteDocumentStore.getInstance(path);
    const doc = second.getMemory('persist-1');
    expect(doc?.content).toBe('persisted content');
    expect(doc?.memory_type).toBe('semantic');
    expect(doc?.properties).toEqual({ note: 'kept' });
    second.close();
  });

  test('getInstance after close returns a fresh usable instance (no stale closed singleton)', () => {
    const path = join(dir, 'stale-close.db');
    SQLiteDocumentStore.resetForTesting();

    const first = SQLiteDocumentStore.getInstance(path);
    first.addMemory({
      memory_id: 'stale-1',
      user_id: 'user-a',
      content: 'before close',
      memory_type: 'episodic',
      timestamp: 1_700_000_200,
      importance: 0.5,
      properties: {}
    });
    first.close();

    // close 后同路径 getInstance 必须返回新实例，而不是已关闭的连接
    const second = SQLiteDocumentStore.getInstance(path);
    expect(second).not.toBe(first);
    expect(() =>
      second.addMemory({
        memory_id: 'stale-2',
        user_id: 'user-a',
        content: 'after reopen',
        memory_type: 'episodic',
        timestamp: 1_700_000_300,
        importance: 0.6,
        properties: {}
      })
    ).not.toThrow();
    expect(second.getMemory('stale-1')?.content).toBe('before close');
    second.close();
  });
});

describe('DocumentStore abstraction', () => {
  test('SQLiteDocumentStore satisfies the DocumentStorePort surface', () => {
    const store: DocumentStore = SQLiteDocumentStore.getInstance(dbPath);
    expect(typeof store.addMemory).toBe('function');
    expect(typeof store.getMemory).toBe('function');
    expect(typeof store.searchMemories).toBe('function');
    expect(typeof store.updateMemory).toBe('function');
    expect(typeof store.deleteMemory).toBe('function');
    expect(typeof store.getDatabaseStats).toBe('function');
    expect(typeof store.addDocument).toBe('function');
    expect(typeof store.getDocument).toBe('function');
    expect(typeof store.close).toBe('function');
  });
});
