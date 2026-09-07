import { platform } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';

const inputSchema = z.object({ command: z.string() }).strict();
/**
 * Deliberately limited to pure in-process operations. Filesystem reads and
 * navigation are excluded because portable Node APIs cannot safely contain a
 * workspace that is replaced after construction.
 */
const SAFE_COMMANDS = new Set(['echo', 'pwd']);
const SHELL_SYNTAX = /[;&|<>`$]|\$\(|\r|\n/;

export class TerminalTool extends Tool<typeof inputSchema> {
  public static readonly inputSchema = inputSchema;
  public static readonly ALLOWED_COMMANDS = Object.freeze([...SAFE_COMMANDS]);
  /** A lexical label captured at construction; it is never dereferenced by commands. */
  public readonly workspace: string;
  /** Retained for source compatibility; in-process commands cannot time out. */
  public readonly timeout: number;
  public readonly maxOutputSize: number;
  /** Retained for source compatibility; changing directories is deliberately unsupported. */
  public readonly allowCd: boolean;

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
      description: '安全的跨平台终端教学工具 - 仅执行无文件系统访问的进程内命令',
      inputSchema,
      parameters: [{ name: 'command', type: 'string', description: '要执行的命令', required: true }]
    });
    this.workspace = resolve(options.workspace ?? '.');
    this.timeout = options.timeout ?? 30;
    this.maxOutputSize = options.maxOutputSize ?? 10 * 1024 * 1024;
    this.allowCd = false;
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

    let output = '';
    switch (base) {
      case 'echo':
        output = `${args.join(' ')}\n`;
        break;
      case 'pwd':
        if (args.length)
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ pwd 不接受参数');
        output = `${this.workspace}\n`;
        break;
    }

    if (Buffer.byteLength(output) > this.maxOutputSize)
      return ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, '❌ 命令输出超过最大限制');
    return ToolResponse.success(output || '✅ 命令执行成功（无输出）', {
      command,
      cwd: this.workspace
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

  public getCurrentDir(): string {
    return this.workspace;
  }

  /** Retained for source compatibility; terminal navigation is unsupported. */
  public resetDir(): void {}

  public getOsType(): 'windows' | 'mac' | 'linux' {
    const value = platform();
    return value === 'win32' ? 'windows' : value === 'darwin' ? 'mac' : 'linux';
  }
}
