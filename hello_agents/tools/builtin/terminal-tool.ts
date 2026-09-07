import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';

const inputSchema = z.object({ command: z.string() }).strict();
const SAFE_COMMANDS = new Set([
  'ls',
  'dir',
  'tree',
  'cat',
  'type',
  'head',
  'tail',
  'less',
  'more',
  'find',
  'where',
  'grep',
  'egrep',
  'fgrep',
  'findstr',
  'wc',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed',
  'pwd',
  'file',
  'stat',
  'du',
  'df',
  'echo',
  'which',
  'whereis',
  'cd'
]);
const SHELL_SYNTAX = /[;&|<>`$]|\$\(|\r|\n/;

/** 安全的教学终端：argv-only、沙箱路径、无 shell 和无解释器执行。 */
export class TerminalTool extends Tool<typeof inputSchema> {
  public static readonly inputSchema = inputSchema;
  public static readonly ALLOWED_COMMANDS = Object.freeze([...SAFE_COMMANDS]);
  public readonly workspace: string;
  public readonly timeout: number;
  public readonly maxOutputSize: number;
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
      description: '安全的跨平台命令行工具 - 只执行沙箱内的白名单只读命令',
      inputSchema,
      parameters: [{ name: 'command', type: 'string', description: '要执行的命令', required: true }]
    });
    this.workspace = resolve(options.workspace ?? '.');
    this.timeout = options.timeout ?? 30;
    this.maxOutputSize = options.maxOutputSize ?? 10 * 1024 * 1024;
    this.allowCd = options.allowCd ?? true;
    mkdirSync(this.workspace, { recursive: true });
    this.currentDir = this.workspace;
  }

  protected run(input: z.output<typeof inputSchema>): ToolResponse {
    const command = input.command.trim();
    if (!command) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ 命令不能为空');
    if (SHELL_SYNTAX.test(command))
      return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, '❌ 不允许 shell 运算符或多行命令');
    let parts: string[];
    try {
      parts = this.parse(command);
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.INVALID_FORMAT,
        `❌ 命令解析失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!parts.length) return ToolResponse.error(ToolErrorCode.INVALID_FORMAT, '❌ 命令不能为空');
    const base = parts[0];
    if (!base || !SAFE_COMMANDS.has(base)) {
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        `❌ 不允许的命令: ${base ?? ''}\n允许的命令: ${[...SAFE_COMMANDS].sort().join(', ')}`
      );
    }
    if (base === 'cd') return this.handleCd(parts);
    const pathError = this.validatePaths(parts.slice(1));
    if (pathError) return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, pathError);
    try {
      const result = execFileSync(base, parts.slice(1), {
        cwd: this.currentDir,
        shell: false,
        timeout: this.timeout * 1000,
        encoding: 'utf8',
        maxBuffer: this.maxOutputSize
      });
      const output = String(result);
      return ToolResponse.success(output || '✅ 命令执行成功（无输出）', {
        command,
        cwd: this.currentDir
      });
    } catch (error) {
      const errorWithOutput = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
        code?: string;
      };
      if (errorWithOutput.code === 'ETIMEDOUT')
        return ToolResponse.error(
          ToolErrorCode.TIMEOUT,
          `❌ 命令执行超时（超过 ${this.timeout} 秒）`
        );
      const output =
        `${errorWithOutput.stdout ?? ''}${errorWithOutput.stderr ? `\n[stderr]\n${errorWithOutput.stderr}` : ''}`.slice(
          0,
          this.maxOutputSize
        );
      const status =
        errorWithOutput.status === undefined ? '' : `⚠️ 命令返回码: ${errorWithOutput.status}\n\n`;
      return ToolResponse.error(
        ToolErrorCode.EXECUTION_ERROR,
        `${status}${output || `❌ 命令执行失败: ${String(error)}`}`
      );
    }
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
  private validatePaths(args: string[]): string | undefined {
    for (const arg of args) {
      if (arg.startsWith('-') || !/[/.\\]/.test(arg)) continue;
      const candidate = isAbsolute(arg) ? resolve(arg) : resolve(this.currentDir, arg);
      const outside = relative(this.workspace, candidate).startsWith('..');
      if (outside || (isAbsolute(arg) && !candidate.startsWith(this.workspace)))
        return `❌ 不允许访问工作目录外的路径: ${candidate}`;
    }
    return undefined;
  }
  private handleCd(parts: string[]): ToolResponse {
    if (!this.allowCd) return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, '❌ cd 命令已禁用');
    const target = parts[1] ?? '.';
    const next = resolve(this.currentDir, target === '~' ? this.workspace : target);
    if (relative(this.workspace, next).startsWith('..'))
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        `❌ 不允许访问工作目录外的路径: ${next}`
      );
    if (!existsSync(next))
      return ToolResponse.error(ToolErrorCode.NOT_FOUND, `❌ 目录不存在: ${next}`);
    if (!statSync(next).isDirectory())
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, `❌ 不是目录: ${next}`);
    this.currentDir = next;
    return ToolResponse.success(`✅ 切换到目录: ${this.currentDir}`);
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
