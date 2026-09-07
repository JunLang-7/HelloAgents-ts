import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';

const inputSchema = z.object({ command: z.string() }).strict();
/**
 * Deliberately narrow read-only policy: no shells, interpreters, pagers, find,
 * sed/awk, or options. Positional file operands are realpath-checked so a
 * symlink cannot escape the workspace. This intentionally rejects some unsafe
 * upstream terminal conveniences (for example `find -exec` and `sort -o`).
 */
const SAFE_COMMANDS = new Set([
  'ls',
  'dir',
  'tree',
  'cat',
  'type',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'findstr',
  'wc',
  'uniq',
  'cut',
  'pwd',
  'file',
  'stat',
  'du',
  'df',
  'echo',
  'cd'
]);
const SHELL_SYNTAX = /[;&|<>`$]|\$\(|\r|\n/;
const NO_PATH_ARGUMENTS = new Set(['echo', 'pwd']);
const PATTERN_FIRST_ARGUMENT = new Set(['grep', 'egrep', 'fgrep', 'findstr']);

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
    const base = parts[0];
    if (!base || !SAFE_COMMANDS.has(base))
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        `❌ 不允许的命令: ${base ?? ''}\n允许的命令: ${[...SAFE_COMMANDS].sort().join(', ')}`
      );
    if (parts.slice(1).some((arg) => arg.startsWith('-')))
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        '❌ 不允许命令选项；它们可能改变只读或路径安全策略'
      );
    if (base === 'cd') return this.handleCd(parts);
    const pathError = this.validatePaths(base, parts.slice(1));
    if (pathError) return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, pathError);
    try {
      const output = String(
        execFileSync(base, parts.slice(1), {
          cwd: this.currentDir,
          shell: false,
          timeout: this.timeout * 1000,
          encoding: 'utf8',
          maxBuffer: this.maxOutputSize
        })
      );
      return ToolResponse.success(output || '✅ 命令执行成功（无输出）', {
        command,
        cwd: this.currentDir
      });
    } catch (error) {
      const detail = error as { status?: number; stdout?: string; stderr?: string; code?: string };
      if (detail.code === 'ETIMEDOUT')
        return ToolResponse.error(
          ToolErrorCode.TIMEOUT,
          `❌ 命令执行超时（超过 ${this.timeout} 秒）`
        );
      const output =
        `${detail.stdout ?? ''}${detail.stderr ? `\n[stderr]\n${detail.stderr}` : ''}`.slice(
          0,
          this.maxOutputSize
        );
      return ToolResponse.error(
        ToolErrorCode.EXECUTION_ERROR,
        `${detail.status === undefined ? '' : `⚠️ 命令返回码: ${detail.status}\n\n`}${output || `❌ 命令执行失败: ${String(error)}`}`
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
  private withinWorkspace(path: string): boolean {
    const value = relative(this.workspace, path);
    return value === '' || (!value.startsWith('..') && !isAbsolute(value));
  }
  private validatePaths(command: string, args: string[]): string | undefined {
    if (NO_PATH_ARGUMENTS.has(command)) return undefined;
    const operands = PATTERN_FIRST_ARGUMENT.has(command) ? args.slice(1) : args;
    for (const operand of operands) {
      const lexical = isAbsolute(operand) ? resolve(operand) : resolve(this.currentDir, operand);
      if (!this.withinWorkspace(lexical)) return `❌ 不允许访问工作目录外的路径: ${lexical}`;
      if (existsSync(lexical)) {
        const actual = realpathSync.native(lexical);
        if (!this.withinWorkspace(actual))
          return `❌ 不允许通过符号链接访问工作目录外的路径: ${actual}`;
      }
    }
    return undefined;
  }
  private handleCd(parts: string[]): ToolResponse {
    if (!this.allowCd) return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, '❌ cd 命令已禁用');
    if (parts.length > 2)
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ cd 只接受一个目录参数');
    const target = parts[1] ?? '.';
    const lexical = resolve(this.currentDir, target === '~' ? this.workspace : target);
    if (!this.withinWorkspace(lexical))
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        `❌ 不允许访问工作目录外的路径: ${lexical}`
      );
    if (!existsSync(lexical))
      return ToolResponse.error(ToolErrorCode.NOT_FOUND, `❌ 目录不存在: ${lexical}`);
    const actual = realpathSync.native(lexical);
    if (!this.withinWorkspace(actual))
      return ToolResponse.error(
        ToolErrorCode.ACCESS_DENIED,
        `❌ 不允许通过符号链接访问工作目录外的路径: ${actual}`
      );
    if (!statSync(actual).isDirectory())
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, `❌ 不是目录: ${actual}`);
    this.currentDir = actual;
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
