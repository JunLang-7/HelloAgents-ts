import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync
} from 'node:fs';
import { platform } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';

const inputSchema = z.object({ command: z.string() }).strict();
/**
 * This is an in-process teaching tool, not a command runner. The intentionally
 * small surface avoids command lookup and supports only operations that Node
 * can perform without re-opening a user-controlled pathname after validation.
 */
const SAFE_COMMANDS = new Set(['cat', 'echo', 'ls', 'pwd']);
const SHELL_SYNTAX = /[;&|<>`$]|\$\(|\r|\n/;
const NO_FOLLOW_PLATFORMS = new Set(['darwin', 'linux']);

export class TerminalTool extends Tool<typeof inputSchema> {
  public static readonly inputSchema = inputSchema;
  public static readonly ALLOWED_COMMANDS = Object.freeze([...SAFE_COMMANDS]);
  public readonly workspace: string;
  /** Retained for source compatibility; in-process commands cannot time out. */
  public readonly timeout: number;
  public readonly maxOutputSize: number;
  /** Retained for source compatibility; changing directories is deliberately unsupported. */
  public readonly allowCd: boolean;
  private currentDir: string;

  public constructor(
    options: {
      readonly workspace?: string;
      readonly timeout?: number;
      readonly maxOutputSize?: number;
      readonly allowCd?: boolean;
      readonly osType?: 'auto' | 'windows' | 'linux' | 'mac';
    } = {}
  ) {
    super({
      name: 'terminal',
      description: '安全的跨平台终端教学工具 - 仅在进程内执行受限的只读操作',
      inputSchema,
      parameters: [{ name: 'command', type: 'string', description: '要执行的命令', required: true }]
    });
    const requestedWorkspace = resolve(options.workspace ?? '.');
    mkdirSync(requestedWorkspace, { recursive: true });
    this.workspace = realpathSync.native(requestedWorkspace);
    this.timeout = options.timeout ?? 30;
    this.maxOutputSize = options.maxOutputSize ?? 10 * 1024 * 1024;
    this.allowCd = options.allowCd ?? true;
    this.currentDir = this.workspace;
  }

  protected run(input: z.output<typeof inputSchema>): ToolResponse {
    const command = input.command.trim();
    if (!command) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ 命令不能为空');
    if (SHELL_SYNTAX.test(command))
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        '❌ 不允许 shell 运算符、多行命令或控制字符'
      );

    let parts: string[];
    try {
      parts = this.parse(command);
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.INVALID_FORMAT,
        `❌ 命令解析失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const [base, ...args] = parts;
    if (!base || !SAFE_COMMANDS.has(base))
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        `❌ 不允许的命令: ${base ?? ''}\n允许的命令: ${[...SAFE_COMMANDS].sort().join(', ')}`
      );

    let output: string | ToolResponse = '';
    switch (base) {
      case 'cat':
        if (args.length !== 1)
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ cat 只接受一个直接文件名参数');
        output = this.readDirectFile(args[0] ?? '');
        break;
      case 'echo':
        output = `${args.join(' ')}\n`;
        break;
      case 'ls':
        if (args.length)
          return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, '❌ ls 不接受路径或选项参数');
        output = readdirSync(this.currentDir).sort().join('\n');
        break;
      case 'pwd':
        if (args.length)
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ pwd 不接受参数');
        output = `${this.currentDir}\n`;
        break;
    }

    if (output instanceof ToolResponse) return output;
    if (Buffer.byteLength(output) > this.maxOutputSize)
      return ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, '❌ 命令输出超过最大限制');
    return ToolResponse.success(output || '✅ 命令执行成功（无输出）', {
      command,
      cwd: this.currentDir
    });
  }

  private parse(command: string): string[] {
    const parts: string[] = [];
    const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    let consumed = 0;
    while ((match = pattern.exec(command)) !== null) {
      if (match.index !== consumed && command.slice(consumed, match.index).trim())
        throw new Error('命令解析失败');
      parts.push(match[1] ?? match[2] ?? match[3] ?? '');
      consumed = pattern.lastIndex;
    }
    if (command.slice(consumed).trim()) throw new Error('命令解析失败');
    return parts;
  }

  private withinWorkspace(path: string): boolean {
    const value = relative(this.workspace, path);
    return value === '' || (!value.startsWith('..') && !isAbsolute(value));
  }

  /**
   * Open only a direct child of the immutable workspace. Restricting operands
   * to one path component prevents a replaced intermediate directory from
   * redirecting an otherwise no-follow leaf open outside the workspace.
   */
  private readDirectFile(operand: string): string | ToolResponse {
    if (
      !operand ||
      operand === '.' ||
      operand === '..' ||
      isAbsolute(operand) ||
      operand.includes('/') ||
      operand.includes('\\')
    )
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        '❌ cat 仅允许工作目录中的直接文件名，不允许路径、符号链接或选项'
      );
    if (!NO_FOLLOW_PLATFORMS.has(platform()) || fsConstants.O_NOFOLLOW === undefined)
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        '❌ 当前平台不支持安全的无跟随文件读取'
      );

    const candidate = resolve(this.currentDir, operand);
    if (!this.withinWorkspace(candidate))
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        `❌ 不允许访问工作目录外的路径: ${candidate}`
      );

    let descriptor: number | undefined;
    try {
      descriptor = openSync(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      // Validate the opened object, then read this descriptor only. Do not re-open candidate.
      const stat = fstatSync(descriptor);
      if (!stat.isFile())
        return ToolResponse.error(ToolErrorCode.INVALID_PARAM, `❌ 不是普通文件: ${candidate}`);
      if (stat.nlink > 1)
        return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, '❌ 不允许读取具有多个硬链接的文件');
      return this.readDescriptor(descriptor);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT')
        return ToolResponse.error(ToolErrorCode.NOT_FOUND, `❌ 文件不存在: ${candidate}`);
      return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, '❌ 无法安全读取该文件');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private readDescriptor(descriptor: number): string | ToolResponse {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = this.maxOutputSize - total;
      if (remaining < 0)
        return ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, '❌ 命令输出超过最大限制');
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) return Buffer.concat(chunks, total).toString('utf8');
      chunks.push(buffer.subarray(0, read));
      total += read;
      if (total > this.maxOutputSize)
        return ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, '❌ 命令输出超过最大限制');
    }
  }

  public getCurrentDir(): string {
    return this.currentDir;
  }
  public resetDir(): void {
    this.currentDir = this.workspace;
  }
  public getOsType(): 'windows' | 'mac' | 'linux' {
    const value = platform();
    return value === 'win32' ? 'windows' : value === 'darwin' ? 'mac' : 'linux';
  }
}
