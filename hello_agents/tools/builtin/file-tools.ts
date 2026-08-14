import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';
import type { ToolRegistry } from '../registry.js';

export interface FileToolOptions {
  /** Absolute or relative root beyond which all file operations are denied. */
  readonly workspaceRoot: string;
  /** Optional registry used to retain read versions for write/edit conflict checks. */
  readonly registry?: ToolRegistry;
  /** Maximum number of bytes returned by Read before it yields a partial response. */
  readonly maxReadBytes?: number;
}

interface FileVersion {
  readonly file_mtime_ms: number | undefined;
  readonly file_hash: string | undefined;
}

const DEFAULT_MAX_READ_BYTES = 50_000;

function contentHash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function responseForFileError(action: string, error: unknown): ToolResponse {
  const code = (error as { code?: string }).code;
  const errorCode =
    code === 'SYMLINK_PATH'
      ? ToolErrorCode.ACCESS_DENIED
      : code === 'ENOENT'
        ? ToolErrorCode.NOT_FOUND
        : code === 'EACCES' || code === 'EPERM'
          ? ToolErrorCode.PERMISSION_DENIED
          : ToolErrorCode.INTERNAL_ERROR;
  return ToolResponse.error(
    errorCode,
    `${action}文件失败：${error instanceof Error ? error.message : String(error)}`
  );
}

function cachedVersion(registry: ToolRegistry | undefined, path: string): FileVersion {
  const cached = registry?.getReadMetadata(path);
  return {
    file_mtime_ms: typeof cached?.file_mtime_ms === 'number' ? cached.file_mtime_ms : undefined,
    file_hash: typeof cached?.file_hash === 'string' ? cached.file_hash : undefined
  };
}
abstract class WorkspaceTool<TSchema extends z.ZodType> extends Tool<TSchema> {
  protected readonly root: string;
  protected readonly registry: ToolRegistry | undefined;
  protected readonly maxReadBytes: number;
  protected constructor(
    options: FileToolOptions & {
      readonly name: string;
      readonly description: string;
      readonly inputSchema: TSchema;
    }
  ) {
    super(options);
    this.root = resolve(options.workspaceRoot);
    this.registry = options.registry;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }
  protected path(path: string): string | undefined {
    const resolved = resolve(this.root, path.replaceAll('\\', '/'));
    return resolved === this.root || resolved.startsWith(`${this.root}${sep}`)
      ? resolved
      : undefined;
  }
  /** Refuse symlinks so a lexical path cannot escape the workspace root. */
  protected async assertSafePath(file: string): Promise<void> {
    let current = this.root;
    for (const segment of relative(this.root, file).split(sep)) {
      if (segment === '') continue;
      current = resolve(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          const error = new Error(`路径包含符号链接: ${relative(this.root, current)}`) as Error & {
            code?: string;
          };
          error.code = 'SYMLINK_PATH';
          throw error;
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return;
        throw error;
      }
    }
  }
  protected async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
  }
  protected async conflict(path: string, expected: FileVersion): Promise<ToolResponse | undefined> {
    if (expected.file_mtime_ms === undefined && expected.file_hash === undefined) return undefined;
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return ToolResponse.error(ToolErrorCode.CONFLICT, '文件自上次读取后已不存在');
      }
      throw error;
    }
    const currentMtime = Math.trunc(info.mtimeMs);
    const currentHash =
      expected.file_hash === undefined ? undefined : contentHash(await readFile(path));
    if (
      (expected.file_mtime_ms === undefined || currentMtime === expected.file_mtime_ms) &&
      (expected.file_hash === undefined || currentHash === expected.file_hash)
    ) {
      return undefined;
    }
    return ToolResponse.error(ToolErrorCode.CONFLICT, '文件自上次读取后被修改', undefined, {
      current_mtime_ms: currentMtime,
      cached_mtime_ms: expected.file_mtime_ms,
      current_file_hash: currentHash,
      cached_file_hash: expected.file_hash
    });
  }

  protected async cacheVersion(
    path: string,
    content: Uint8Array
  ): Promise<{ file_mtime_ms: number; file_size_bytes: number; file_hash: string }> {
    const info = await stat(path);
    const metadata = {
      file_mtime_ms: Math.trunc(info.mtimeMs),
      file_size_bytes: info.size,
      file_hash: contentHash(content)
    };
    this.registry?.cacheReadMetadata(relative(this.root, path).replaceAll('\\', '/'), metadata);
    return metadata;
  }
}
/** Reads files or directory listings while retaining metadata for conflict detection. */
export class ReadTool extends WorkspaceTool<typeof ReadTool.inputSchema> {
  static readonly inputSchema = z
    .object({
      path: z.string().min(1),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().nonnegative().default(2000)
    })
    .strict();
  public constructor(options: FileToolOptions) {
    super({
      ...options,
      name: 'Read',
      description: '读取文件内容或列出目录内容，支持行号范围和元数据缓存',
      inputSchema: ReadTool.inputSchema
    });
  }
  protected async run(input: z.output<typeof ReadTool.inputSchema>): Promise<ToolResponse> {
    const file = this.path(input.path);
    if (!file)
      return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, `路径 '${input.path}' 超出工作目录`);
    try {
      await this.assertSafePath(file);
      const info = await stat(file);
      if (info.isDirectory()) {
        const entries = (await readdir(file, { withFileTypes: true }))
          .sort(
            (a, b) =>
              Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
          )
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            path: relative(this.root, resolve(file, entry.name)).replaceAll('\\', '/')
          }));
        return ToolResponse.success(`目录 '${input.path}' 包含 ${entries.length} 项`, {
          path: input.path,
          entries,
          is_directory: true
        });
      }
      const raw = await readFile(file);
      if (raw.includes(0)) {
        return ToolResponse.error(ToolErrorCode.BINARY_FILE, `文件 '${input.path}' 是二进制文件`);
      }
      const truncated = raw.byteLength > this.maxReadBytes;
      const content = raw.subarray(0, this.maxReadBytes).toString('utf8');
      const lines = content === '' ? [] : (content.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? []);
      const chosen =
        input.limit === 0
          ? lines.slice(input.offset)
          : lines.slice(input.offset, input.offset + input.limit);
      const metadata = await this.cacheVersion(file, raw);
      const response = truncated ? ToolResponse.partial : ToolResponse.success;
      return response(
        `读取 ${chosen.length} 行（${truncated ? '前' : '共'} ${lines.length} 行，${metadata.file_size_bytes} 字节）\n\n${chosen.join('')}`,
        {
          content: chosen.join(''),
          lines: chosen.length,
          total_lines: lines.length,
          ...metadata,
          truncated,
          offset: input.offset,
          limit: input.limit
        }
      );
    } catch (error) {
      return responseForFileError('读取', error);
    }
  }
}
/** Creates or replaces workspace files with optional optimistic conflict checks. */
export class WriteTool extends WorkspaceTool<typeof WriteTool.inputSchema> {
  static readonly inputSchema = z
    .object({
      path: z.string().min(1),
      content: z.string(),
      file_mtime_ms: z.number().int().optional(),
      file_hash: z.string().length(64).optional()
    })
    .strict();
  public constructor(options: FileToolOptions) {
    super({
      ...options,
      name: 'Write',
      description: '创建或覆盖文件，支持冲突检测和原子写入',
      inputSchema: WriteTool.inputSchema
    });
  }
  protected async run(input: z.output<typeof WriteTool.inputSchema>): Promise<ToolResponse> {
    const file = this.path(input.path);
    if (!file)
      return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, `路径 '${input.path}' 超出工作目录`);
    try {
      await this.assertSafePath(file);
      const cached = cachedVersion(this.registry, input.path);
      const check = await this.conflict(file, {
        file_mtime_ms: input.file_mtime_ms ?? cached.file_mtime_ms,
        file_hash: input.file_hash ?? cached.file_hash
      });
      if (check) return check;
      await this.atomicWrite(file, input.content);
      const metadata = await this.cacheVersion(file, Buffer.from(input.content));
      return ToolResponse.success(
        `成功写入 ${input.path} (${Buffer.byteLength(input.content)} 字节)`,
        { written: true, size_bytes: Buffer.byteLength(input.content), ...metadata }
      );
    } catch (error) {
      return responseForFileError('写入', error);
    }
  }
}
/** Replaces one unique text occurrence in a workspace file atomically. */
export class EditTool extends WorkspaceTool<typeof EditTool.inputSchema> {
  static readonly inputSchema = z
    .object({
      path: z.string().min(1),
      old_string: z.string(),
      new_string: z.string(),
      file_mtime_ms: z.number().int().optional(),
      file_hash: z.string().length(64).optional()
    })
    .strict();
  public constructor(options: FileToolOptions) {
    super({
      ...options,
      name: 'Edit',
      description: '精确替换文件内容，支持冲突检测和原子写入',
      inputSchema: EditTool.inputSchema
    });
  }
  protected async run(input: z.output<typeof EditTool.inputSchema>): Promise<ToolResponse> {
    const file = this.path(input.path);
    if (!file)
      return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, `路径 '${input.path}' 超出工作目录`);
    try {
      await this.assertSafePath(file);
      const cached = cachedVersion(this.registry, input.path);
      const check = await this.conflict(file, {
        file_mtime_ms: input.file_mtime_ms ?? cached.file_mtime_ms,
        file_hash: input.file_hash ?? cached.file_hash
      });
      if (check) return check;
      const raw = await readFile(file);
      if (raw.includes(0)) {
        return ToolResponse.error(ToolErrorCode.BINARY_FILE, `文件 '${input.path}' 是二进制文件`);
      }
      const content = raw.toString('utf8');
      const matches = content.split(input.old_string).length - 1;
      if (matches !== 1)
        return ToolResponse.error(
          ToolErrorCode.INVALID_PARAM,
          `old_string 必须唯一匹配文件内容。找到 ${matches} 处匹配。`,
          undefined,
          { matches }
        );
      const updated = content.replace(input.old_string, input.new_string);
      await this.atomicWrite(file, updated);
      const metadata = await this.cacheVersion(file, Buffer.from(updated));
      return ToolResponse.success(
        `成功编辑 ${input.path} (变化 ${Buffer.byteLength(input.new_string) - Buffer.byteLength(input.old_string)} 字节)`,
        {
          modified: true,
          changed_bytes: Buffer.byteLength(input.new_string) - Buffer.byteLength(input.old_string),
          ...metadata
        }
      );
    } catch (error) {
      return responseForFileError('编辑', error);
    }
  }
}
async function walk(root: string, directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.backups') continue;
    if (entry.isSymbolicLink()) continue;
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(root, absolute)));
    else output.push(relative(root, absolute).replaceAll('\\', '/'));
  }
  return output;
}
function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? '';
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += pattern[index + 2] === '/' ? '(?:.*/)?' : '.*';
        index += pattern[index + 2] === '/' ? 2 : 1;
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else source += /[.+^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${source}$`);
}
/** Finds workspace files matching a glob pattern. */
export class GlobTool extends WorkspaceTool<typeof GlobTool.inputSchema> {
  static readonly inputSchema = z.object({ pattern: z.string().min(1) }).strict();
  public constructor(options: FileToolOptions) {
    super({
      ...options,
      name: 'Glob',
      description: '查找匹配 glob 模式的文件',
      inputSchema: GlobTool.inputSchema
    });
  }
  protected async run(input: z.output<typeof GlobTool.inputSchema>): Promise<ToolResponse> {
    const matches = (await walk(this.root, this.root))
      .filter((path) => globRegex(input.pattern).test(path))
      .sort();
    return ToolResponse.success(`找到 ${matches.length} 个匹配文件`, { matches });
  }
}
/** Finds literal text matches in workspace files. */
export class GrepTool extends WorkspaceTool<typeof GrepTool.inputSchema> {
  static readonly inputSchema = z
    .object({ pattern: z.string().min(1), path: z.string().default('.') })
    .strict();
  public constructor(options: FileToolOptions) {
    super({
      ...options,
      name: 'Grep',
      description: '在工作目录中搜索文本',
      inputSchema: GrepTool.inputSchema
    });
  }
  protected async run(input: z.output<typeof GrepTool.inputSchema>): Promise<ToolResponse> {
    const base = this.path(input.path);
    if (!base)
      return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, `路径 '${input.path}' 超出工作目录`);
    await this.assertSafePath(base);
    const info = await stat(base);
    const files = info.isDirectory()
      ? await walk(this.root, base)
      : [relative(this.root, base).replaceAll('\\', '/')];
    const matches: { path: string; line: number; text: string }[] = [];
    for (const path of files) {
      const raw = await readFile(resolve(this.root, path));
      if (raw.includes(0)) continue;
      const content = raw.toString('utf8');
      content.split('\n').forEach((text, index) => {
        if (text.includes(input.pattern)) matches.push({ path, line: index + 1, text });
      });
    }
    return ToolResponse.success(`找到 ${matches.length} 处匹配`, { matches });
  }
}
