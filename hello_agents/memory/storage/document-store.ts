/**
 * 文档存储实现（上游 `memory/storage/document_store.py` 的教学版移植）。
 *
 * - `DocumentStore`：文档存储抽象（端口实现，供记忆类型经 backends.docStore 注入）。
 * - `SQLiteDocumentStore`：SQLite 文档存储，表结构与 SQL 与上游逐一对应
 *   （users / memories / concepts / memory_concepts / concept_relationships）。
 *
 * 后端选择（DIFF 登记见 docs/upstream-differences.md）：
 * - 上游使用 Python `sqlite3`；TS 优先 Bun 内置 `bun:sqlite`，Node ≥22.5 回退
 *   `node:sqlite`（DatabaseSync），两者均为无外部依赖的同步 SQLite。
 * - 上游 `__new__` 同路径单例；TS 提供 `getInstance(dbPath)` 静态工厂保留同语义。
 */

import { resolve as resolvePath } from 'node:path';

import type { DocumentSearchFilter, DocumentStorePort, StoredMemoryDoc } from '../ports.js';

/** 文档存储基类（上游 `DocumentStore`）。 */
export abstract class DocumentStore implements DocumentStorePort {
  public abstract addMemory(doc: {
    memory_id: string;
    user_id: string;
    content: string;
    memory_type: string;
    timestamp: number;
    importance: number;
    properties: Record<string, unknown>;
  }): string;

  public abstract getMemory(memoryId: string): StoredMemoryDoc | undefined | null;

  public abstract searchMemories(filter?: DocumentSearchFilter): StoredMemoryDoc[];

  public abstract updateMemory(changes: {
    memory_id: string;
    content?: string | undefined;
    importance?: number | undefined;
    properties?: Record<string, unknown> | undefined;
  }): boolean;

  public abstract deleteMemory(memoryId: string): boolean;

  public abstract getDatabaseStats(): Record<string, unknown>;

  public abstract addDocument(content: string, metadata?: Record<string, unknown>): string;

  public abstract getDocument(documentId: string): StoredMemoryDoc | undefined | null;

  /** 关闭数据库连接（上游 `close`）。 */
  public abstract close(): void;
}

// ---------------------------------------------------------------------------
// SQLite 后端适配（bun:sqlite / node:sqlite）
// ---------------------------------------------------------------------------

/** 统一的 SQLite 连接接口（bun:sqlite 与 node:sqlite 的最小公共面）。 */
export interface SqliteLike {
  query(sql: string): {
    all(...params: Array<unknown>): Array<Record<string, unknown>>;
    get(...params: Array<unknown>): Record<string, unknown> | undefined;
    run(...params: Array<unknown>): { changes: number };
  };
  close(): void;
}

/** 探测并加载可用的同步 SQLite 后端。 */
export function loadSqlite(): SqliteLike {
  return resolveSqliteFactory().open(':memory:');
}

// 由于 bun:sqlite 与 node:sqlite 的实例化方式不同，这里用工厂函数统一创建。

interface SqliteFactory {
  open(path: string): SqliteLike;
  name: string;
}

function createBunSqliteFactory(): SqliteFactory {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite') as {
    Database: new (path: string) => {
      query(sql: string): {
        all(...params: Array<unknown>): Array<Record<string, unknown>>;
        get(...params: Array<unknown>): Record<string, unknown> | undefined;
        run(...params: Array<unknown>): { changes: number; lastInsertRowid?: number | bigint };
      };
      close(): void;
    };
  };
  return {
    name: 'bun:sqlite',
    open(path: string): SqliteLike {
      const db = new Database(path);
      return {
        query(sql: string) {
          return db.query(sql);
        },
        close() {
          db.close();
        }
      };
    }
  };
}

function createNodeSqliteFactory(): SqliteFactory {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRequire } = require('node:module') as {
    createRequire: (filename: string) => (specifier: string) => unknown;
  };
  const require_ = createRequire(import.meta.url);
  const nodeSqlite = require_('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): {
        all(...params: Array<unknown>): Array<Record<string, unknown>>;
        get(...params: Array<unknown>): Record<string, unknown> | undefined;
        run(...params: Array<unknown>): { changes: number };
      };
      close(): void;
    };
  };
  return {
    name: 'node:sqlite',
    open(path: string): SqliteLike {
      const db = new nodeSqlite.DatabaseSync(path);
      return {
        query(sql: string) {
          const stmt = db.prepare(sql);
          return {
            all(...params) {
              return stmt.all(...params) as Array<Record<string, unknown>>;
            },
            get(...params) {
              return stmt.get(...params) as Record<string, unknown> | undefined;
            },
            run(...params) {
              const info = stmt.run(...params) as { changes: number };
              return info;
            }
          };
        },
        close() {
          db.close();
        }
      };
    }
  };
}

/** 探测当前运行时可用的 SQLite 工厂（bun:sqlite 优先，node:sqlite 回退）。 */
function resolveSqliteFactory(): SqliteFactory {
  if (typeof Bun !== 'undefined') {
    try {
      return createBunSqliteFactory();
    } catch {
      // 落到 node:sqlite
    }
  }
  try {
    return createNodeSqliteFactory();
  } catch (cause) {
    throw new Error(
      '未找到可用的 SQLite 后端：请使用 Bun（内置 bun:sqlite）或 Node ≥22.5（node:sqlite）。',
      { cause }
    );
  }
}

// ---------------------------------------------------------------------------
// SQLiteDocumentStore
// ---------------------------------------------------------------------------

const ROW_FIELDS =
  'id, user_id, content, memory_type, timestamp, importance, properties, created_at';

function rowToDoc(row: Record<string, unknown>): StoredMemoryDoc {
  const propertiesRaw = row.properties;
  let properties: Record<string, unknown> = {};
  if (typeof propertiesRaw === 'string' && propertiesRaw !== '') {
    try {
      properties = JSON.parse(propertiesRaw) as Record<string, unknown>;
    } catch {
      properties = {};
    }
  } else if (typeof propertiesRaw === 'object' && propertiesRaw !== null) {
    properties = propertiesRaw as Record<string, unknown>;
  }
  return {
    memory_id: String(row.id),
    user_id: String(row.user_id),
    content: String(row.content),
    memory_type: String(row.memory_type),
    timestamp: Number(row.timestamp),
    importance: Number(row.importance),
    properties
  };
}

/** SQLite 文档存储实现（上游 `SQLiteDocumentStore`）。 */
export class SQLiteDocumentStore extends DocumentStore {
  private static readonly instances = new Map<string, SQLiteDocumentStore>();
  private static readonly initializedDbs = new Set<string>();

  public readonly db_path: string;
  private readonly conn: SqliteLike;
  private _closed = false;

  private constructor(dbPath: string, conn: SqliteLike) {
    super();
    this.db_path = dbPath;
    this.conn = conn;
  }

  /** 单例工厂：同一路径只创建一个实例（对齐上游 `__new__` 语义）。 */
  public static getInstance(dbPath = './memory.db'): SQLiteDocumentStore {
    const absPath = resolveAbsPath(dbPath);
    const existing = SQLiteDocumentStore.instances.get(absPath);
    if (existing) return existing;

    const conn = resolveSqliteFactory().open(dbPath);
    const instance = new SQLiteDocumentStore(dbPath, conn);
    SQLiteDocumentStore.instances.set(absPath, instance);

    if (!SQLiteDocumentStore.initializedDbs.has(absPath)) {
      instance._initDatabase();
      SQLiteDocumentStore.initializedDbs.add(absPath);
    }
    return instance;
  }

  /** 当前已打开实例数（测试辅助）。 */
  public static get openCount(): number {
    return SQLiteDocumentStore.instances.size;
  }

  /** 测试辅助：关闭全部实例并清空注册表（不删除磁盘文件）。 */
  public static resetForTesting(): void {
    for (const instance of SQLiteDocumentStore.instances.values()) {
      instance.close();
    }
    SQLiteDocumentStore.instances.clear();
    SQLiteDocumentStore.initializedDbs.clear();
  }

  private _initDatabase(): void {
    const conn = this.conn;
    conn
      .query(
        `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        properties TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `
      )
      .run();

    conn
      .query(
        `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        importance REAL NOT NULL,
        properties TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `
      )
      .run();

    conn
      .query(
        `
      CREATE TABLE IF NOT EXISTS concepts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        properties TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `
      )
      .run();

    conn
      .query(
        `
      CREATE TABLE IF NOT EXISTS memory_concepts (
        memory_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        relevance_score REAL DEFAULT 1.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (memory_id, concept_id),
        FOREIGN KEY (memory_id) REFERENCES memories (id) ON DELETE CASCADE,
        FOREIGN KEY (concept_id) REFERENCES concepts (id) ON DELETE CASCADE
      )
    `
      )
      .run();

    conn
      .query(
        `
      CREATE TABLE IF NOT EXISTS concept_relationships (
        from_concept_id TEXT NOT NULL,
        to_concept_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        strength REAL DEFAULT 1.0,
        properties TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (from_concept_id, to_concept_id, relationship_type),
        FOREIGN KEY (from_concept_id) REFERENCES concepts (id) ON DELETE CASCADE,
        FOREIGN KEY (to_concept_id) REFERENCES concepts (id) ON DELETE CASCADE
      )
    `
      )
      .run();

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories (user_id)',
      'CREATE INDEX IF NOT EXISTS idx_memories_type ON memories (memory_type)',
      'CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories (timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance)',
      'CREATE INDEX IF NOT EXISTS idx_memory_concepts_memory ON memory_concepts (memory_id)',
      'CREATE INDEX IF NOT EXISTS idx_memory_concepts_concept ON memory_concepts (concept_id)'
    ];
    for (const indexSql of indexes) {
      conn.query(indexSql).run();
    }
  }

  public addMemory(doc: {
    memory_id: string;
    user_id: string;
    content: string;
    memory_type: string;
    timestamp: number;
    importance: number;
    properties: Record<string, unknown>;
  }): string {
    const conn = this.conn;
    // 确保用户存在
    conn
      .query('INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)')
      .run(doc.user_id, doc.user_id);
    // 插入记忆（INSERT OR REPLACE）
    conn
      .query(
        `INSERT OR REPLACE INTO memories
        (id, user_id, content, memory_type, timestamp, importance, properties, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .run(
        doc.memory_id,
        doc.user_id,
        doc.content,
        doc.memory_type,
        doc.timestamp,
        doc.importance,
        Object.keys(doc.properties ?? {}).length > 0 ? JSON.stringify(doc.properties ?? {}) : null
      );
    return doc.memory_id;
  }

  public getMemory(memoryId: string): StoredMemoryDoc | undefined | null {
    const row = this.conn.query(`SELECT ${ROW_FIELDS} FROM memories WHERE id = ?`).get(memoryId);
    return row ? rowToDoc(row) : undefined;
  }

  public searchMemories(filter: DocumentSearchFilter = {}): StoredMemoryDoc[] {
    const where: string[] = [];
    const params: Array<unknown> = [];
    const limit = filter.limit ?? 10;

    if (filter.user_id !== undefined && filter.user_id !== '') {
      where.push('user_id = ?');
      params.push(filter.user_id);
    }
    if (filter.memory_type !== undefined && filter.memory_type !== '') {
      where.push('memory_type = ?');
      params.push(filter.memory_type);
    }
    if (filter.start_time !== undefined && filter.start_time !== 0) {
      where.push('timestamp >= ?');
      params.push(filter.start_time);
    }
    if (filter.end_time !== undefined && filter.end_time !== 0) {
      where.push('timestamp <= ?');
      params.push(filter.end_time);
    }
    if (filter.importance_threshold !== undefined && filter.importance_threshold !== 0) {
      where.push('importance >= ?');
      params.push(filter.importance_threshold);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.conn
      .query(
        `SELECT ${ROW_FIELDS} FROM memories ${whereClause}
        ORDER BY importance DESC, timestamp DESC
        LIMIT ?`
      )
      .all(...params, limit);
    return rows.map(rowToDoc);
  }

  public updateMemory(changes: {
    memory_id: string;
    content?: string | undefined;
    importance?: number | undefined;
    properties?: Record<string, unknown> | undefined;
  }): boolean {
    const updateFields: string[] = [];
    const params: Array<unknown> = [];

    if (changes.content !== undefined) {
      updateFields.push('content = ?');
      params.push(changes.content);
    }
    if (changes.importance !== undefined) {
      updateFields.push('importance = ?');
      params.push(changes.importance);
    }
    if (changes.properties !== undefined) {
      updateFields.push('properties = ?');
      params.push(JSON.stringify(changes.properties));
    }
    if (updateFields.length === 0) return false;

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(changes.memory_id);

    const result = this.conn
      .query(`UPDATE memories SET ${updateFields.join(', ')} WHERE id = ?`)
      .run(...params);
    return result.changes > 0;
  }

  public deleteMemory(memoryId: string): boolean {
    const result = this.conn.query('DELETE FROM memories WHERE id = ?').run(memoryId);
    return result.changes > 0;
  }

  public getDatabaseStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {};
    const tables = ['users', 'memories', 'concepts', 'memory_concepts', 'concept_relationships'];
    for (const table of tables) {
      const row = this.conn.query(`SELECT COUNT(*) as count FROM ${table}`).get();
      stats[`${table}_count`] = row ? Number(row.count) : 0;
    }

    // 记忆类型分布
    const memoryTypes: Record<string, number> = {};
    for (const row of this.conn
      .query('SELECT memory_type, COUNT(*) as count FROM memories GROUP BY memory_type')
      .all()) {
      memoryTypes[String(row.memory_type)] = Number(row.count);
    }
    stats.memory_types = memoryTypes;

    // 用户分布（TOP 10）
    const topUsers: Record<string, number> = {};
    for (const row of this.conn
      .query(
        'SELECT user_id, COUNT(*) as count FROM memories GROUP BY user_id ORDER BY count DESC LIMIT 10'
      )
      .all()) {
      topUsers[String(row.user_id)] = Number(row.count);
    }
    stats.top_users = topUsers;

    stats.store_type = 'sqlite';
    stats.db_path = this.db_path;
    return stats;
  }

  public addDocument(content: string, metadata: Record<string, unknown> = {}): string {
    const docId = crypto.randomUUID();
    const userId = typeof metadata.user_id === 'string' ? metadata.user_id : 'system';
    return this.addMemory({
      memory_id: docId,
      user_id: userId,
      content,
      memory_type: 'document',
      timestamp: Math.floor(Date.now() / 1000),
      importance: 0.5,
      properties: metadata ?? {}
    });
  }

  public getDocument(documentId: string): StoredMemoryDoc | undefined | null {
    return this.getMemory(documentId);
  }

  public close(): void {
    if (this._closed) return;
    this._closed = true;
    this.conn.close();
    // 关闭后从单例注册表注销：同路径再次 getInstance() 会重新打开连接，
    // 避免返回已关闭实例导致 `Cannot use a closed database`。
    const absPath = resolveAbsPath(this.db_path);
    SQLiteDocumentStore.instances.delete(absPath);
    SQLiteDocumentStore.initializedDbs.delete(absPath);
  }
}

/** 解析绝对路径（对齐上游 `os.path.abspath`）。 */
function resolveAbsPath(dbPath: string): string {
  return resolvePath(dbPath);
}
