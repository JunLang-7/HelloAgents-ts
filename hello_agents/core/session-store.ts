import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseSessionData } from './session-data.js';
import type { SessionData } from './session-data.js';
import type { Message } from './message.js';

export interface SessionStoreOptions {
  /** 保存 JSON 会话文件的目录。 */
  readonly sessionDir?: string;
  /** 时钟注入，用于确定性的会话 ID 和时间戳。 */
  readonly now?: () => Date;
}
export interface SaveSessionOptions {
  /** 保存后用于恢复兼容性检查的可序列化 Agent 配置。 */
  readonly agentConfig: Record<string, unknown>;
  /** 要序列化的对话历史。 */
  readonly history: readonly Message[];
  /** 保存会话时生效的工具模式哈希。 */
  readonly toolSchemaHash: string;
  /** 与工具注册表关联的文件读取元数据缓存。 */
  readonly readCache: Record<string, Record<string, unknown>>;
  /** 随会话保存的调用方自定义数据。 */
  readonly metadata: Record<string, unknown>;
  /** 可选文件名；存储器会自动追加 `.json`。 */
  readonly sessionName?: string;
}
/** 轻量会话列表条目，不加载对话历史。 */
export interface SessionSummary {
  readonly filename: string;
  readonly filepath: string;
  readonly session_id: string;
  readonly created_at: string;
  readonly saved_at: string;
  readonly metadata: Record<string, unknown>;
}

function sessionId(now: Date): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '')
    .replace('T', '-');
  return `s-${timestamp}-${randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

/**
 * 会话存储器。
 *
 * 功能：
 * - 保存会话到 JSON 文件
 * - 从文件恢复会话
 * - 环境一致性检查
 * - 原子写入保证数据完整性
 *
 * 基于 Node 标准文件系统；Bun 兼容同一套 promises API。
 */
export class SessionStore {
  public readonly sessionDir: string;
  private readonly now: () => Date;
  public constructor(options: SessionStoreOptions = {}) {
    this.sessionDir = options.sessionDir ?? 'memory/sessions';
    this.now = options.now ?? (() => new Date());
  }
  /**
   * 原子写入完整会话。
   *
   * @param options 会话配置、历史、工具模式哈希、读取缓存和元数据。
   * @returns 保存的文件路径。
   */
  public async save(options: SaveSessionOptions): Promise<string> {
    await mkdir(this.sessionDir, { recursive: true });
    const now = this.now();
    const id = sessionId(now);
    const filename = `${options.sessionName ?? `session-${id}`}.json`;
    const filepath = join(this.sessionDir, filename);
    const value = parseSessionData({
      session_id: id,
      created_at:
        typeof options.metadata.created_at === 'string'
          ? options.metadata.created_at
          : now.toISOString(),
      saved_at: now.toISOString(),
      agent_config: options.agentConfig,
      history: options.history.map((message) => message.toJSON()),
      tool_schema_hash: options.toolSchemaHash,
      read_cache: options.readCache,
      metadata: options.metadata
    }).toJSON();
    const temporary = `${filepath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, filepath);
    return filepath;
  }
  /**
   * 加载并校验一个持久化会话文件。
   *
   * @param filepath 会话文件路径。
   * @returns 校验后的会话数据。
   */
  public async load(filepath: string): Promise<SessionData> {
    return parseSessionData(JSON.parse(await readFile(filepath, 'utf8')));
  }
  /** 按最新保存时间列出会话；会话目录不存在时返回空列表。 */
  public async listSessions(): Promise<SessionSummary[]> {
    try {
      const names = (await readdir(this.sessionDir)).filter((name) => name.endsWith('.json'));
      const sessions = await Promise.all(
        names.map(async (filename) => {
          const filepath = join(this.sessionDir, filename);
          const data = await this.load(filepath);
          const json = data.toJSON();
          return {
            filename,
            filepath,
            session_id: json.session_id,
            created_at: json.created_at,
            saved_at: json.saved_at,
            metadata: json.metadata
          };
        })
      );
      return sessions.sort((left, right) => right.saved_at.localeCompare(left.saved_at));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }
  /**
   * 根据文件名或文件名主体删除会话。
   *
   * @param sessionName 会话文件名或文件名主体。
   * @returns 是否成功删除；文件不存在时返回 false。
   */
  public async delete(sessionName: string): Promise<boolean> {
    const filename = basename(sessionName).endsWith('.json')
      ? basename(sessionName)
      : `${basename(sessionName)}.json`;
    try {
      await rm(join(this.sessionDir, filename));
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  }
  /** 比较保存的 Agent 设置与当前设置，并返回警告。 */
  public checkConfigConsistency(
    saved: Record<string, unknown>,
    current: Record<string, unknown>
  ): { consistent: boolean; warnings: string[] } {
    const warnings: string[] = [];
    if (saved.llm_provider !== current.llm_provider)
      warnings.push(
        `LLM 提供商变化: ${String(saved.llm_provider)} → ${String(current.llm_provider)}`
      );
    if (saved.llm_model !== current.llm_model)
      warnings.push(`模型变化: ${String(saved.llm_model)} → ${String(current.llm_model)}`);
    if (saved.max_steps !== current.max_steps)
      warnings.push(`最大步数变化: ${String(saved.max_steps)} → ${String(current.max_steps)}`);
    return { consistent: warnings.length === 0, warnings };
  }
  /** 比较保存和当前工具模式哈希，判断恢复兼容性。 */
  public checkToolSchemaConsistency(
    savedHash: string,
    currentHash: string
  ): { changed: boolean; saved_hash: string; current_hash: string; recommendation: string } {
    const changed = savedHash !== currentHash;
    return {
      changed,
      saved_hash: savedHash,
      current_hash: currentHash,
      recommendation: changed ? '建议重新读取文件' : '可以安全恢复'
    };
  }
}
