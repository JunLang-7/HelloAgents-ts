import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { FunctionTool, Tool } from '../tool.js';

const inputSchema = z
  .object({
    action: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    note_type: z.string().optional(),
    tags: z.array(z.string()).optional(),
    note_id: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().positive().optional()
  })
  .strict();
type Note = {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  created_at: string;
  updated_at: string;
};

/** 教学版结构化 Markdown 笔记工具。 */
export class NoteTool extends Tool<typeof inputSchema> {
  public static readonly inputSchema = inputSchema;
  public readonly workspace: string;
  public readonly autoBackup: boolean;
  public readonly maxNotes: number;
  private readonly indexFile: string;
  private notes: Note[] = [];

  public constructor(
    options: {
      readonly workspace?: string;
      readonly autoBackup?: boolean;
      readonly maxNotes?: number;
      readonly expandable?: boolean;
    } = {}
  ) {
    super({
      name: 'note',
      description: '笔记工具 - 创建、读取、更新、删除结构化笔记，支持任务状态、结论、阻塞项等类型',
      inputSchema,
      expandable: options.expandable ?? false,
      parameters: [
        { name: 'action', type: 'string', description: '操作类型', required: true },
        { name: 'title', type: 'string', description: '笔记标题', required: false },
        { name: 'content', type: 'string', description: '笔记内容', required: false },
        {
          name: 'note_type',
          type: 'string',
          description: '笔记类型',
          required: false,
          default: 'general'
        },
        { name: 'tags', type: 'array', description: '标签列表', required: false },
        { name: 'note_id', type: 'string', description: '笔记 ID', required: false },
        { name: 'query', type: 'string', description: '搜索关键词', required: false },
        {
          name: 'limit',
          type: 'integer',
          description: '结果数量限制',
          required: false,
          default: 10
        }
      ]
    });
    this.workspace = resolve(options.workspace ?? './notes');
    this.autoBackup = options.autoBackup ?? true;
    this.maxNotes = options.maxNotes ?? 1000;
    this.indexFile = join(this.workspace, 'notes_index.json');
    mkdirSync(this.workspace, { recursive: true });
    this.loadIndex();
  }

  public getExpandedTools(): readonly Tool[] {
    const actionInput = inputSchema.omit({ action: true });
    const actions = [
      ['note_create', '创建一条新的结构化笔记', 'create'],
      ['note_read', '读取指定 ID 的笔记', 'read'],
      ['note_update', '更新已存在的笔记', 'update'],
      ['note_delete', '删除指定 ID 的笔记', 'delete'],
      ['note_list', '列出笔记', 'list'],
      ['note_search', '搜索笔记', 'search'],
      ['note_summary', '获取笔记摘要', 'summary']
    ] as const;
    return actions.map(
      ([name, description, action]) =>
        new FunctionTool({
          name,
          description,
          inputSchema: actionInput,
          handler: async (input) => (await this.execute({ ...input, action })).text
        })
    );
  }

  protected run(input: z.output<typeof inputSchema>): ToolResponse {
    const action = input.action;
    try {
      switch (action) {
        case 'create':
          return this.createNote(input);
        case 'read':
          return this.readNote(input.note_id);
        case 'update':
          return this.updateNote(input);
        case 'delete':
          return this.deleteNote(input.note_id);
        case 'list':
          return this.listNotes(input.note_type, input.limit ?? 10);
        case 'search':
          return this.searchNotes(input.query, input.limit ?? 10);
        case 'summary':
          return this.summary();
        default:
          return ToolResponse.error(ToolErrorCode.INVALID_PARAM, `❌ 不支持的操作: ${action}`);
      }
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.EXECUTION_ERROR,
        `❌ 笔记操作失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private loadIndex(): void {
    if (!existsSync(this.indexFile)) {
      this.saveIndex();
      return;
    }
    const parsed: unknown = JSON.parse(readFileSync(this.indexFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'notes' in parsed && Array.isArray(parsed.notes)) {
      this.notes = parsed.notes as Note[];
    }
  }
  private saveIndex(): void {
    writeFileSync(
      this.indexFile,
      JSON.stringify({ notes: this.notes, metadata: { total_notes: this.notes.length } }, null, 2)
    );
  }
  private notePath(id: string): string | undefined {
    if (!/^note_[A-Za-z0-9_-]+$/.test(id)) return undefined;
    const path = resolve(this.workspace, `${id}.md`);
    return path.startsWith(`${this.workspace}/`) ? path : undefined;
  }
  private generateId(): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, '')
      .slice(0, 15);
    return `note_${stamp}_${this.notes.length}`;
  }
  private toMarkdown(note: Note): string {
    return `---\nid: ${note.id}\ntitle: ${note.title}\ntype: ${note.type}\ntags: ${JSON.stringify(note.tags)}\ncreated_at: ${note.created_at}\nupdated_at: ${note.updated_at}\n---\n\n# ${note.title}\n\n${note.content}`;
  }
  private fromMarkdown(value: string): Note {
    const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(value);
    if (!match) throw new Error('无效的笔记格式：缺少YAML前置元数据');
    const fields: Record<string, string> = {};
    const header = match[1] ?? '';
    const markdownBody = match[2] ?? '';
    for (const line of header.split('\n')) {
      const separator = line.indexOf(':');
      if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    const body = markdownBody.replace(/^# .*?\n\s*/, '');
    let tags: string[] = [];
    try {
      tags = JSON.parse(fields.tags ?? '[]') as string[];
    } catch {
      tags = [];
    }
    return {
      id: fields.id ?? '',
      title: fields.title ?? '',
      type: fields.type ?? 'general',
      tags,
      created_at: fields.created_at ?? '',
      updated_at: fields.updated_at ?? '',
      content: body.trim()
    };
  }
  private createNote(input: z.output<typeof inputSchema>): ToolResponse {
    if (!input.title || !input.content)
      return ToolResponse.error(
        ToolErrorCode.INVALID_PARAM,
        '❌ 创建笔记需要提供 title 和 content'
      );
    if (this.notes.length >= this.maxNotes)
      return ToolResponse.error(
        ToolErrorCode.INVALID_PARAM,
        `❌ 笔记数量已达上限 (${this.maxNotes})`
      );
    const now = new Date().toISOString();
    const note: Note = {
      id: this.generateId(),
      title: input.title,
      content: input.content,
      type: input.note_type ?? 'general',
      tags: input.tags ?? [],
      created_at: now,
      updated_at: now
    };
    const path = this.notePath(note.id);
    if (!path) return ToolResponse.error(ToolErrorCode.ACCESS_DENIED, '❌ 笔记路径无效');
    writeFileSync(path, this.toMarkdown(note));
    this.notes.push(note);
    this.saveIndex();
    return ToolResponse.success(
      `✅ 笔记创建成功\nID: ${note.id}\n标题: ${note.title}\n类型: ${note.type}`,
      { id: note.id }
    );
  }
  private readNote(id: string | undefined): ToolResponse {
    if (!id) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ 读取笔记需要提供 note_id');
    const path = this.notePath(id);
    if (!path || !existsSync(path))
      return ToolResponse.error(ToolErrorCode.NOT_FOUND, `❌ 笔记不存在: ${id}`);
    return ToolResponse.success(this.formatNote(this.fromMarkdown(readFileSync(path, 'utf8'))));
  }
  private updateNote(input: z.output<typeof inputSchema>): ToolResponse {
    if (!input.note_id)
      return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ 更新笔记需要提供 note_id');
    const path = this.notePath(input.note_id);
    if (!path || !existsSync(path))
      return ToolResponse.error(ToolErrorCode.NOT_FOUND, `❌ 笔记不存在: ${input.note_id}`);
    const note = this.fromMarkdown(readFileSync(path, 'utf8'));
    if (input.title) note.title = input.title;
    if (input.content) note.content = input.content;
    if (input.note_type) note.type = input.note_type;
    if (input.tags) note.tags = input.tags;
    note.updated_at = new Date().toISOString();
    writeFileSync(path, this.toMarkdown(note));
    const index = this.notes.findIndex((item) => item.id === note.id);
    if (index >= 0) this.notes[index] = note;
    this.saveIndex();
    return ToolResponse.success(`✅ 笔记更新成功: ${note.id}`);
  }
  private deleteNote(id: string | undefined): ToolResponse {
    if (!id) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ 删除笔记需要提供 note_id');
    const path = this.notePath(id);
    if (!path || !existsSync(path))
      return ToolResponse.error(ToolErrorCode.NOT_FOUND, `❌ 笔记不存在: ${id}`);
    unlinkSync(path);
    this.notes = this.notes.filter((item) => item.id !== id);
    this.saveIndex();
    return ToolResponse.success(`✅ 笔记已删除: ${id}`);
  }
  private listNotes(type: string | undefined, limit: number): ToolResponse {
    const notes = this.notes.filter((note) => !type || note.type === type).slice(0, limit);
    if (!notes.length) return ToolResponse.success('📝 暂无笔记');
    const text = `📝 笔记列表（共 ${notes.length} 条）\n\n${notes.map((note) => `• [${note.type}] ${note.title}\n  ID: ${note.id}\n  创建时间: ${note.created_at}\n`).join('\n')}`;
    return ToolResponse.success(text, { notes });
  }
  private searchNotes(query: string | undefined, limit: number): ToolResponse {
    if (!query) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '❌ 搜索需要提供 query');
    const needle = query.toLowerCase();
    const notes = this.notes
      .filter(
        (note) =>
          note.title.toLowerCase().includes(needle) ||
          note.content.toLowerCase().includes(needle) ||
          note.tags.some((tag) => tag.toLowerCase().includes(needle))
      )
      .slice(0, limit);
    if (!notes.length) return ToolResponse.success(`📝 未找到匹配 '${query}' 的笔记`);
    return ToolResponse.success(
      `🔍 搜索结果（共 ${notes.length} 条）\n\n${notes.map((note) => this.formatNote(note, true)).join('\n\n')}`,
      { notes }
    );
  }
  private summary(): ToolResponse {
    const counts: Record<string, number> = {};
    for (const note of this.notes) counts[note.type] = (counts[note.type] ?? 0) + 1;
    return ToolResponse.success(
      `📊 笔记摘要\n\n总笔记数: ${this.notes.length}\n\n按类型统计:\n${Object.keys(counts)
        .sort()
        .map((type) => `  • ${type}: ${counts[type]}`)
        .join('\n')}`,
      { total: this.notes.length, by_type: counts }
    );
  }
  private formatNote(note: Note, compact = false): string {
    if (compact)
      return `[${note.type}] ${note.title}\nID: ${note.id}\n内容: ${note.content.slice(0, 100)}${note.content.length > 100 ? '...' : ''}`;
    return `📝 笔记详情\n\nID: ${note.id}\n标题: ${note.title}\n类型: ${note.type}\n${note.tags.length ? `标签: ${note.tags.join(', ')}\n` : ''}创建时间: ${note.created_at}\n更新时间: ${note.updated_at}\n\n内容:\n${note.content}\n`;
  }
}
