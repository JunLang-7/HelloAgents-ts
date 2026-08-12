import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { ToolError } from '../core/errors.js';
import { ToolErrorCode } from './errors.js';
import { ToolResponse } from './response.js';
import { Tool } from './tool.js';

const jsonRecordSchema = z.record(z.string(), z.unknown());
const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
const todoItemSchema = z
  .object({
    content: z.string(),
    status: todoStatusSchema,
    created_at: z.string(),
    updated_at: z.string()
  })
  .strict();
const todoPersistenceSchema = z
  .object({ schema_version: z.literal(1), summary: z.string(), todos: z.array(todoItemSchema) })
  .strict();

const devLogCategorySchema = z.enum([
  'decision',
  'progress',
  'issue',
  'solution',
  'refactor',
  'test',
  'performance'
]);
const devLogEntrySchema = z
  .object({
    id: z.string().min(1),
    timestamp: z.string(),
    category: devLogCategorySchema,
    content: z.string(),
    metadata: jsonRecordSchema
  })
  .strict();
const devLogPersistenceSchema = z
  .object({
    schema_version: z.literal(1),
    session_id: z.string(),
    agent_name: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    entries: z.array(devLogEntrySchema)
  })
  .strict();

export type TodoStatus = z.output<typeof todoStatusSchema>;
export type TodoItem = z.output<typeof todoItemSchema>;
export type DevLogCategory = z.output<typeof devLogCategorySchema>;
export type DevLogEntry = z.output<typeof devLogEntrySchema>;

export const DEV_LOG_CATEGORIES = Object.freeze([...devLogCategorySchema.options]);

interface TodoWriteInputItem {
  readonly content: string;
  readonly status: TodoStatus;
  readonly created_at?: string | undefined;
}

export interface TodoWriteToolOptions {
  /** Root that relative persistence directories are resolved from. Defaults to cwd. */
  readonly projectRoot?: string | undefined;
  /** Directory holding the durable todo file. Defaults to .helloagents. */
  readonly persistenceDir?: string | undefined;
}

export interface DevLogToolOptions {
  readonly sessionId: string;
  readonly agentName: string;
  /** Root that relative persistence directories are resolved from. Defaults to cwd. */
  readonly projectRoot?: string | undefined;
  /** Directory holding the durable dev-log file. Defaults to .helloagents. */
  readonly persistenceDir?: string | undefined;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    // A failed rename/write must not leave a stale temporary file behind when possible.
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    if (error instanceof SyntaxError)
      throw new ToolError(`持久化文件不是有效 JSON: ${path}`, error);
    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function persistencePath(
  projectRoot: string | undefined,
  persistenceDir: string | undefined,
  name: string
): string {
  const root = resolve(projectRoot ?? process.cwd());
  return resolve(root, persistenceDir ?? '.helloagents', name);
}

/**
 * Durable, model-facing task list compatible with Python V1 TodoWrite semantics.
 * A single operation queue protects both in-memory snapshots and atomic file writes.
 */
export class TodoWriteTool extends Tool<typeof TodoWriteTool.inputSchema> {
  static readonly inputSchema = z
    .object({
      action: z.enum(['create', 'update', 'clear']).optional(),
      summary: z.string().optional(),
      todos: z
        .array(
          z
            .object({
              content: z.string(),
              status: todoStatusSchema,
              created_at: z.string().optional()
            })
            .strict()
        )
        .optional()
    })
    .strict();

  public readonly persistencePath: string;
  private items: TodoItem[];
  private currentSummary: string;
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(path: string, summary = '', todos: TodoItem[] = []) {
    super({
      name: 'TodoWrite',
      description: '创建、更新或清空持久化任务清单；每次最多只能有一个进行中的任务。',
      inputSchema: TodoWriteTool.inputSchema
    });
    this.persistencePath = path;
    this.currentSummary = summary;
    this.items = todos;
  }

  public static async create(options: TodoWriteToolOptions = {}): Promise<TodoWriteTool> {
    const path = persistencePath(options.projectRoot, options.persistenceDir, 'todo-list.json');
    const saved = await readJsonIfPresent(path);
    if (saved === undefined) return new TodoWriteTool(path);
    const parsed = todoPersistenceSchema.safeParse(saved);
    if (!parsed.success) throw new ToolError(`TodoWrite 持久化格式无效: ${path}`);
    return new TodoWriteTool(path, parsed.data.summary, parsed.data.todos);
  }

  public get todos(): readonly TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  public get summary(): string {
    return this.currentSummary;
  }

  protected override async run(
    input: z.output<typeof TodoWriteTool.inputSchema>
  ): Promise<ToolResponse> {
    return this.enqueue(() => this.runUnlocked(input));
  }

  private async runUnlocked(
    input: z.output<typeof TodoWriteTool.inputSchema>
  ): Promise<ToolResponse> {
    const action = input.action ?? 'create';
    if (action === 'clear') {
      return this.commit('', [], '任务清单已清空。');
    }
    if (input.todos === undefined) {
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, `${action} 操作需要 todos 数组。`);
    }
    const validation = this.normalizeTodos(input.todos);
    if (typeof validation === 'string')
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, validation);
    return this.commit(input.summary ?? this.currentSummary, validation, this.recap(validation));
  }

  private normalizeTodos(items: readonly TodoWriteInputItem[]): TodoItem[] | string {
    if (items.filter((item) => item.status === 'in_progress').length > 1) {
      return '任务清单最多只能包含一个 in_progress 任务。';
    }
    const updatedAt = new Date().toISOString();
    for (const item of items) {
      if (item.content.trim().length === 0) return '任务内容不能为空。';
    }
    return items.map((item) => ({
      content: item.content.trim(),
      status: item.status,
      created_at: item.created_at ?? updatedAt,
      updated_at: updatedAt
    }));
  }

  private async commit(summary: string, todos: TodoItem[], text: string): Promise<ToolResponse> {
    const oldSummary = this.currentSummary;
    const oldItems = this.items;
    this.currentSummary = summary;
    this.items = todos;
    try {
      await writeJsonAtomically(this.persistencePath, {
        schema_version: 1,
        summary: this.currentSummary,
        todos: this.items
      });
    } catch (error) {
      this.currentSummary = oldSummary;
      this.items = oldItems;
      return ToolResponse.error(
        ToolErrorCode.EXECUTION_ERROR,
        `无法持久化任务清单: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const stats = this.todoStats(todos);
    return ToolResponse.success(text, { summary, todos: this.todos, stats }, stats);
  }

  private todoStats(todos: readonly TodoItem[] = this.items): Record<string, number> {
    const completed = todos.filter((item) => item.status === 'completed').length;
    const inProgress = todos.filter((item) => item.status === 'in_progress').length;
    return {
      total: todos.length,
      completed,
      in_progress: inProgress,
      pending: todos.length - completed - inProgress
    };
  }

  private recap(todos: readonly TodoItem[]): string {
    const stats = this.todoStats(todos);
    if (stats.total === 0) return '📋 [0/0] 无活动任务';
    if (stats.completed === stats.total)
      return `✅ [${stats.completed}/${stats.total}] 所有任务已完成！`;
    const inProgress = todos.find((item) => item.status === 'in_progress');
    const pending = todos.filter((item) => item.status === 'pending').map((item) => item.content);
    const parts = [`📋 [${stats.completed}/${stats.total}]`];
    if (inProgress) parts.push(`进行中: ${inProgress.content}`);
    if (pending.length > 0) parts.push(`待处理: ${pending.slice(0, 3).join('; ')}`);
    if (pending.length > 3) parts.push(`还有 ${pending.length - 3} 个`);
    return parts.join('。');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/**
 * A compact, durable development journal. It intentionally remains separate
 * from TraceLogger: TraceLogger records runtime events, while DevLog stores
 * human/model decisions and handoff context.
 */
export class DevLogTool extends Tool<typeof DevLogTool.inputSchema> {
  static readonly inputSchema = z
    .object({
      action: z.enum(['append', 'read', 'summary', 'clear']),
      category: devLogCategorySchema.optional(),
      content: z.string().optional(),
      metadata: jsonRecordSchema.optional(),
      filter: z
        .object({
          category: devLogCategorySchema.optional(),
          tags: z.array(z.string()).optional(),
          limit: z.number().int().nonnegative().optional()
        })
        .strict()
        .optional()
    })
    .strict();

  public readonly persistencePath: string;
  public readonly sessionId: string;
  public readonly agentName: string;
  private createdAt: string;
  private entries: DevLogEntry[];
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(
    path: string,
    sessionId: string,
    agentName: string,
    createdAt: string,
    entries: DevLogEntry[]
  ) {
    super({
      name: 'DevLog',
      description: '记录、查询和总结当前会话的开发决策、进度、问题与解决方案。',
      inputSchema: DevLogTool.inputSchema
    });
    this.persistencePath = path;
    this.sessionId = sessionId;
    this.agentName = agentName;
    this.createdAt = createdAt;
    this.entries = entries;
  }

  public static async create(options: DevLogToolOptions): Promise<DevLogTool> {
    const path = persistencePath(
      options.projectRoot,
      options.persistenceDir,
      `devlog-${encodeURIComponent(options.sessionId)}.json`
    );
    const saved = await readJsonIfPresent(path);
    if (saved === undefined) {
      return new DevLogTool(
        path,
        options.sessionId,
        options.agentName,
        new Date().toISOString(),
        []
      );
    }
    const parsed = devLogPersistenceSchema.safeParse(saved);
    if (!parsed.success) throw new ToolError(`DevLog 持久化格式无效: ${path}`);
    if (parsed.data.session_id !== options.sessionId) {
      throw new ToolError(`DevLog 会话标识与持久化文件不匹配: ${path}`);
    }
    return new DevLogTool(
      path,
      parsed.data.session_id,
      parsed.data.agent_name,
      parsed.data.created_at,
      parsed.data.entries
    );
  }

  public get logEntries(): readonly DevLogEntry[] {
    return this.entries.map((entry) => ({ ...entry, metadata: { ...entry.metadata } }));
  }

  protected override async run(
    input: z.output<typeof DevLogTool.inputSchema>
  ): Promise<ToolResponse> {
    return this.enqueue(() => this.runUnlocked(input));
  }

  private async runUnlocked(input: z.output<typeof DevLogTool.inputSchema>): Promise<ToolResponse> {
    switch (input.action) {
      case 'append':
        if (input.category === undefined) {
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, 'append 操作需要 category。');
        }
        if (input.content === undefined || input.content.length === 0) {
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, 'append 操作需要非空 content。');
        }
        return this.append(input.category, input.content, input.metadata ?? {});
      case 'read':
        return this.read(input.filter);
      case 'summary':
        return this.summary();
      case 'clear':
        return this.clear();
    }
  }

  private async append(
    category: DevLogCategory,
    content: string,
    metadata: Record<string, unknown>
  ): Promise<ToolResponse> {
    const entry: DevLogEntry = {
      id: `log-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      category,
      content,
      metadata
    };
    const oldEntries = this.entries;
    this.entries = [...oldEntries, entry];
    const persisted = await this.persistOrRollback(oldEntries);
    if (persisted) return persisted;
    return ToolResponse.success(
      `已记录 ${category} 开发日志。`,
      { entry },
      { total: this.entries.length }
    );
  }

  private read(filter: z.output<typeof DevLogTool.inputSchema>['filter']): ToolResponse {
    let entries = this.entries;
    if (filter?.category) entries = entries.filter((entry) => entry.category === filter.category);
    if (filter?.tags && filter.tags.length > 0) {
      entries = entries.filter((entry) => {
        const tags = entry.metadata.tags;
        return (
          Array.isArray(tags) &&
          tags.some((tag) => typeof tag === 'string' && filter.tags?.includes(tag))
        );
      });
    }
    const limit = filter?.limit ?? 0;
    if (limit > 0) entries = entries.slice(-limit);
    return ToolResponse.success(
      `找到 ${entries.length} 条开发日志。`,
      { entries },
      { matched: entries.length }
    );
  }

  private summary(): ToolResponse {
    if (this.entries.length === 0)
      return ToolResponse.success('当前开发日志为空。', { entries: [] }, { total: 0 });
    const counts = new Map<DevLogCategory, number>();
    for (const entry of this.entries)
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    const countText = [...counts.entries()]
      .map(([category, count]) => `${category}(${count})`)
      .join(', ');
    const recent = this.entries
      .slice(-3)
      .map((entry) => `[${entry.category}] ${entry.content.slice(0, 30)}`)
      .join('\n');
    return ToolResponse.success(
      `开发日志摘要：${countText}\n最近记录：\n${recent}`,
      { counts: Object.fromEntries(counts) },
      { total: this.entries.length }
    );
  }

  private async clear(): Promise<ToolResponse> {
    const oldEntries = this.entries;
    this.entries = [];
    const persisted = await this.persistOrRollback(oldEntries);
    if (persisted) return persisted;
    return ToolResponse.success('开发日志已清空。', {}, { total: 0 });
  }

  private async persistOrRollback(oldEntries: DevLogEntry[]): Promise<ToolResponse | undefined> {
    try {
      await writeJsonAtomically(this.persistencePath, {
        schema_version: 1,
        session_id: this.sessionId,
        agent_name: this.agentName,
        created_at: this.createdAt,
        updated_at: new Date().toISOString(),
        entries: this.entries
      });
      return undefined;
    } catch (error) {
      this.entries = oldEntries;
      return ToolResponse.error(
        ToolErrorCode.EXECUTION_ERROR,
        `无法持久化开发日志: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
