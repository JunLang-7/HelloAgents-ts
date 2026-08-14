import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { parseSessionData } from './session-data.js';
import type { SessionData } from './session-data.js';
import type { Message } from './message.js';

export interface SessionStoreOptions {
  /** Directory in which JSON session files are stored. */
  readonly sessionDir?: string;
  /** Clock injection for deterministic IDs and timestamps. */
  readonly now?: () => Date;
}
export interface SaveSessionOptions {
  /** Serializable agent configuration saved for restore compatibility checks. */
  readonly agentConfig: Record<string, unknown>;
  /** Conversation history to serialize. */
  readonly history: readonly Message[];
  /** Hash of the tool schemas active when the session was saved. */
  readonly toolSchemaHash: string;
  /** Cached file-read metadata associated with the tool registry. */
  readonly readCache: Record<string, Record<string, unknown>>;
  /** Caller-defined data that travels with the session. */
  readonly metadata: Record<string, unknown>;
  /** Optional filename stem; the store appends `.json`. */
  readonly sessionName?: string;
}
/** Lightweight session listing entry, without loading conversation history. */
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

/** Node standard-FS SessionStore; Bun supports the same promises API. */
export class SessionStore {
  public readonly sessionDir: string;
  private readonly now: () => Date;
  public constructor(options: SessionStoreOptions = {}) {
    this.sessionDir = options.sessionDir ?? 'memory/sessions';
    this.now = options.now ?? (() => new Date());
  }
  /** Writes a complete session atomically and returns its filesystem path. */
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
  /** Loads and validates one persisted session file. */
  public async load(filepath: string): Promise<SessionData> {
    return parseSessionData(JSON.parse(await readFile(filepath, 'utf8')));
  }
  /** Lists saved sessions newest-first; a missing session directory is empty. */
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
  /** Deletes a session by filename or filename stem; returns false when absent. */
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
  /** Compares saved agent settings with current settings and returns warnings. */
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
  /** Compares saved and current tool-schema hashes for restore compatibility. */
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
