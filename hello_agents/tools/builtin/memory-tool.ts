/**
 * 记忆管理工具（上游 `tools/builtin/memory_tool.py` @3927c6d 的教学版移植）。
 *
 * run 派发九种 action：add/search/summary/stats/update/remove/forget/
 * consolidate/clear_all；@tool_action 展开为九个独立 FunctionTool。
 * 所有文案、参数顺序、默认值与上游逐一对齐（上游 run 始终返回字符串，
 * 因此内部失败也以成功响应承载 ❌ 文案，保持线格式一致）。
 *
 * 兼容修复（PR 差异清单登记）：
 * 1. 上游 auto_record_conversation/add_knowledge 向不接收额外关键字参数的
 *    _add_memory 传入 type=/conversation_id=/knowledge_type= 等，必然抛
 *    TypeError 并被吞成“添加失败”；这里按明显意图写入 metadata。
 * 2. 上游 clear_session 只清工作记忆，clear_all 清空全部，分别保留。
 */
import { z } from 'zod';

import type { MemoryItem } from '../../memory/index.js';
import { MemoryConfig, MemoryManager } from '../../memory/index.js';
import { Tool, toolAction } from '../tool.js';
import { ToolResponse } from '../response.js';

type MemoryAction =
  | 'add'
  | 'search'
  | 'summary'
  | 'stats'
  | 'update'
  | 'remove'
  | 'forget'
  | 'consolidate'
  | 'clear_all';

const TYPE_LABELS: Record<string, string> = {
  working: '工作记忆',
  episodic: '情景记忆',
  semantic: '语义记忆',
  perceptual: '感知记忆'
};

export interface MemoryToolOptions {
  /** 注入已有管理器（优先于其他构造参数）。 */
  memoryManager?: MemoryManager | undefined;
  userId?: string | undefined;
  config?: MemoryConfig | undefined;
  memoryTypes?: string[] | undefined;
  expandable?: boolean | undefined;
}

type ResolvedParameter = {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default: unknown;
};

function localSessionStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 与上游 get_parameters 顺序、描述、默认值逐一对齐的参数元数据。 */
const MEMORY_TOOL_PARAMETERS: readonly ResolvedParameter[] = [
  {
    name: 'action',
    type: 'string',
    description:
      '要执行的操作：add(添加记忆), search(搜索记忆), summary(获取摘要), stats(获取统计), update(更新记忆), remove(删除记忆), forget(遗忘记忆), consolidate(整合记忆), clear_all(清空所有记忆)',
    required: true,
    default: null
  },
  {
    name: 'content',
    type: 'string',
    description: '记忆内容（add/update时可用；感知记忆可作描述）',
    required: false,
    default: null
  },
  {
    name: 'query',
    type: 'string',
    description: '搜索查询（search时可用）',
    required: false,
    default: null
  },
  {
    name: 'memory_type',
    type: 'string',
    description: '记忆类型：working, episodic, semantic, perceptual（默认：working）',
    required: false,
    default: 'working'
  },
  {
    name: 'importance',
    type: 'number',
    description: '重要性分数，0.0-1.0（add/update时可用）',
    required: false,
    default: null
  },
  {
    name: 'limit',
    type: 'integer',
    description: '搜索结果数量限制（默认：5）',
    required: false,
    default: 5
  },
  {
    name: 'memory_id',
    type: 'string',
    description: '目标记忆ID（update/remove时必需）',
    required: false,
    default: null
  },
  {
    name: 'file_path',
    type: 'string',
    description: '感知记忆：本地文件路径（image/audio）',
    required: false,
    default: null
  },
  {
    name: 'modality',
    type: 'string',
    description: '感知记忆模态：text/image/audio（不传则按扩展名推断）',
    required: false,
    default: null
  },
  {
    name: 'strategy',
    type: 'string',
    description: '遗忘策略：importance_based/time_based/capacity_based（forget时可用）',
    required: false,
    default: 'importance_based'
  },
  {
    name: 'threshold',
    type: 'number',
    description: '遗忘阈值（forget时可用，默认0.1）',
    required: false,
    default: 0.1
  },
  {
    name: 'max_age_days',
    type: 'integer',
    description: '最大保留天数（forget策略为time_based时可用）',
    required: false,
    default: 30
  },
  {
    name: 'from_type',
    type: 'string',
    description: '整合来源类型（consolidate时可用，默认working）',
    required: false,
    default: 'working'
  },
  {
    name: 'to_type',
    type: 'string',
    description: '整合目标类型（consolidate时可用，默认episodic）',
    required: false,
    default: 'episodic'
  },
  {
    name: 'importance_threshold',
    type: 'number',
    description: '整合重要性阈值（默认0.7）',
    required: false,
    default: 0.7
  }
];

/** 分层记忆系统的统一操作工具。 */
export class MemoryTool extends Tool {
  public memoryManager: MemoryManager;
  public memoryConfig: MemoryConfig;
  public enabledMemoryTypes: string[];
  public currentSessionId: string | null;
  public conversationCount: number;

  public constructor(options: MemoryToolOptions = {}) {
    super({
      name: 'memory',
      description: '记忆工具 - 可以存储和检索对话历史、知识和经验',
      expandable: options.expandable ?? false,
      parameters: MEMORY_TOOL_PARAMETERS,
      inputSchema: z
        .object({
          action: z.string().min(1),
          content: z.string().optional(),
          query: z.string().optional(),
          memory_type: z.string().optional(),
          importance: z.number().optional(),
          limit: z.number().optional(),
          memory_id: z.string().optional(),
          file_path: z.string().optional(),
          modality: z.string().optional(),
          strategy: z.string().optional(),
          threshold: z.number().optional(),
          max_age_days: z.number().optional(),
          from_type: z.string().optional(),
          to_type: z.string().optional(),
          importance_threshold: z.number().optional(),
          // min_importance 在 search 派发路径真实使用（与上游一致：上游 run 也
          // 读取 parameters.get("min_importance") 但不在 get_parameters 声明）。
          // metadata / memory_types 上游 run 从不读取，刻意不声明——.passthrough()
          // 仍会像上游 validate_parameters 一样宽松接受并忽略未知字段，避免在
          // 工具 schema 层承诺不存在的功能。
          min_importance: z.number().optional()
        })
        .passthrough()
    });
    this.memoryConfig = options.config ?? new MemoryConfig();
    this.enabledMemoryTypes = options.memoryTypes ?? ['working', 'episodic', 'semantic'];
    this.memoryManager =
      options.memoryManager ??
      new MemoryManager({
        config: this.memoryConfig,
        userId: options.userId ?? 'default_user',
        enableWorking: this.enabledMemoryTypes.includes('working'),
        enableEpisodic: this.enabledMemoryTypes.includes('episodic'),
        enableSemantic: this.enabledMemoryTypes.includes('semantic'),
        enablePerceptual: this.enabledMemoryTypes.includes('perceptual')
      });
    this.currentSessionId = null;
    this.conversationCount = 0;
  }

  public getParameters(): ResolvedParameter[] {
    return MEMORY_TOOL_PARAMETERS.map((parameter) => ({ ...parameter }));
  }

  protected async run(input: Record<string, unknown>): Promise<ToolResponse> {
    if (typeof input.action !== 'string' || input.action.length === 0)
      return ToolResponse.success('❌ 参数验证失败：缺少必需的参数');
    const action = input.action as MemoryAction;
    let text: string;
    switch (action) {
      case 'add':
        text = this.addMemory(
          (input.content as string) ?? '',
          (input.memory_type as string) ?? 'working',
          (input.importance as number) ?? 0.5,
          input.file_path as string | undefined,
          input.modality as string | undefined
        );
        break;
      case 'search':
        text = this.searchMemory(
          input.query as string | undefined,
          (input.limit as number) ?? 5,
          input.memory_type as string | undefined,
          (input.min_importance as number) ?? 0.1
        );
        break;
      case 'summary':
        text = this.getSummary((input.limit as number) ?? 10);
        break;
      case 'stats':
        text = this.getStatsText();
        break;
      case 'update':
        text = this.updateMemory(
          input.memory_id as string | undefined,
          input.content as string | undefined,
          input.importance as number | undefined
        );
        break;
      case 'remove':
        text = this.removeMemory(input.memory_id as string | undefined);
        break;
      case 'forget':
        text = this.forget(
          (input.strategy as string) ?? 'importance_based',
          (input.threshold as number) ?? 0.1,
          (input.max_age_days as number) ?? 30
        );
        break;
      case 'consolidate':
        text = this.consolidate(
          (input.from_type as string) ?? 'working',
          (input.to_type as string) ?? 'episodic',
          (input.importance_threshold as number) ?? 0.7
        );
        break;
      case 'clear_all':
        text = this.clearAll();
        break;
      default:
        text = `❌ 不支持的操作: ${action}`;
    }
    return ToolResponse.success(text);
  }

  /** 添加新记忆（禁用自动分类，使用明确指定的类型）。 */
  public addMemory(
    content = '',
    memoryType = 'working',
    importance = 0.5,
    filePath?: string,
    modality?: string,
    extraMetadata: Record<string, unknown> = {}
  ): string {
    const metadata: Record<string, unknown> = { ...extraMetadata };
    try {
      if (this.currentSessionId === null) this.currentSessionId = `session_${localSessionStamp()}`;
      if (memoryType === 'perceptual' && filePath) {
        const inferred = modality ?? this.inferModality(filePath);
        metadata.modality ??= inferred;
        metadata.raw_data ??= filePath;
      }
      metadata.session_id = this.currentSessionId;
      metadata.timestamp = new Date().toISOString();
      const memoryId = this.memoryManager.addMemory(
        content,
        memoryType,
        importance,
        metadata,
        false
      );
      return `✅ 记忆已添加 (ID: ${memoryId.slice(0, 8)}...)`;
    } catch (error) {
      return `❌ 添加记忆失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  public add_memory(content = '', memoryType?: string, importance?: number): string {
    return this.addMemory(content, memoryType ?? 'working', importance ?? 0.5);
  }

  /** 根据扩展名推断模态（image/audio/text）。 */
  public inferModality(path: string): string {
    try {
      const ext = (path.split('.').pop() ?? '').toLowerCase();
      if (['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'].includes(ext)) return 'image';
      if (['mp3', 'wav', 'flac', 'm4a', 'ogg'].includes(ext)) return 'audio';
      return 'text';
    } catch {
      return 'text';
    }
  }
  public infer_modality(path: string): string {
    return this.inferModality(path);
  }

  public searchMemory(query?: string, limit = 5, memoryType?: string, minImportance = 0.1): string {
    try {
      const memoryTypes = memoryType ? [memoryType] : undefined;
      const results = this.memoryManager.retrieveMemories(
        query ?? '',
        memoryTypes,
        limit,
        minImportance
      );
      if (results.length === 0) return `🔍 未找到与 '${query ?? ''}' 相关的记忆`;
      const lines = [`🔍 找到 ${results.length} 条相关记忆:`];
      results.forEach((memory, index) => {
        const label = TYPE_LABELS[memory.memoryType] ?? memory.memoryType;
        const preview =
          memory.content.length > 80 ? `${memory.content.slice(0, 80)}...` : memory.content;
        lines.push(`${index + 1}. [${label}] ${preview} (重要性: ${memory.importance.toFixed(2)})`);
      });
      return lines.join('\n');
    } catch (error) {
      return `❌ 搜索记忆失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  public search_memory(query?: string, limit?: number, memoryType?: string): string {
    return this.searchMemory(query, limit ?? 5, memoryType);
  }

  public getSummary(limit = 10): string {
    try {
      const stats = this.memoryManager.getMemoryStats();
      const parts = [
        '📊 记忆系统摘要',
        `总记忆数: ${stats.total_memories}`,
        `当前会话: ${this.currentSessionId ?? '未开始'}`,
        `对话轮次: ${this.conversationCount}`
      ];
      const byType = stats.memories_by_type as Record<
        string,
        { count?: number; avg_importance?: number }
      >;
      if (Object.keys(byType).length > 0) {
        parts.push('\n📋 记忆类型分布:');
        for (const [type, typeStats] of Object.entries(byType)) {
          const label = TYPE_LABELS[type] ?? type;
          const count = typeStats.count ?? 0;
          const avg = typeStats.avg_importance ?? 0;
          parts.push(`  • ${label}: ${count} 条 (平均重要性: ${Number(avg).toFixed(2)})`);
        }
      }

      const candidates = this.memoryManager.retrieveMemories('', undefined, limit * 3, 0.5);
      const seenIds = new Set<string>();
      const seenContents = new Set<string>();
      const unique: MemoryItem[] = [];
      for (const memory of candidates) {
        if (seenIds.has(memory.id)) continue;
        const contentKey = memory.content.trim().toLowerCase();
        if (seenContents.has(contentKey)) continue;
        seenIds.add(memory.id);
        seenContents.add(contentKey);
        unique.push(memory);
      }
      unique.sort((a, b) => b.importance - a.importance);
      if (unique.length > 0) {
        parts.push(`\n⭐ 重要记忆 (前${Math.min(limit, unique.length)}条):`);
        unique.slice(0, limit).forEach((memory, index) => {
          const preview =
            memory.content.length > 60 ? `${memory.content.slice(0, 60)}...` : memory.content;
          parts.push(`  ${index + 1}. ${preview} (重要性: ${memory.importance.toFixed(2)})`);
        });
      }
      return parts.join('\n');
    } catch (error) {
      return `❌ 获取摘要失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public getStatsText(): string {
    try {
      const stats = this.memoryManager.getMemoryStats();
      return [
        '📈 记忆系统统计',
        `总记忆数: ${stats.total_memories}`,
        `启用的记忆类型: ${(stats.enabled_types as string[]).join(', ')}`,
        `会话ID: ${this.currentSessionId ?? '未开始'}`,
        `对话轮次: ${this.conversationCount}`
      ].join('\n');
    } catch (error) {
      return `❌ 获取统计信息失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public updateMemory(memoryId?: string, content?: string, importance?: number): string {
    try {
      const success = this.memoryManager.updateMemory(memoryId ?? '', content, importance);
      return success ? '✅ 记忆已更新' : '⚠️ 未找到要更新的记忆';
    } catch (error) {
      return `❌ 更新记忆失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public removeMemory(memoryId?: string): string {
    try {
      const success = this.memoryManager.removeMemory(memoryId ?? '');
      return success ? '✅ 记忆已删除' : '⚠️ 未找到要删除的记忆';
    } catch (error) {
      return `❌ 删除记忆失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public forget(strategy = 'importance_based', threshold = 0.1, maxAgeDays = 30): string {
    try {
      const count = this.memoryManager.forgetMemories(strategy, threshold, maxAgeDays);
      return `🧹 已遗忘 ${count} 条记忆（策略: ${strategy}）`;
    } catch (error) {
      return `❌ 遗忘记忆失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public consolidate(fromType = 'working', toType = 'episodic', importanceThreshold = 0.7): string {
    try {
      const count = this.memoryManager.consolidateMemories(fromType, toType, importanceThreshold);
      return `🔄 已整合 ${count} 条记忆为长期记忆（${fromType} → ${toType}，阈值=${importanceThreshold}）`;
    } catch (error) {
      return `❌ 整合记忆失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public clearAll(): string {
    try {
      this.memoryManager.clearAllMemories();
      return '🧽 已清空所有记忆';
    } catch (error) {
      return `❌ 清空记忆失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  public clear_all(): string {
    return this.clearAll();
  }

  /** 自动记录一轮对话（兼容修复：额外字段写入 metadata 而非非法关键字参数）。 */
  public autoRecordConversation(userInput: string, agentResponse: string): void {
    this.conversationCount += 1;
    this.addMemory(`用户: ${userInput}`, 'working', 0.6, undefined, undefined, {
      type: 'user_input',
      conversation_id: this.conversationCount
    });
    this.addMemory(`助手: ${agentResponse}`, 'working', 0.7, undefined, undefined, {
      type: 'agent_response',
      conversation_id: this.conversationCount
    });
    if (agentResponse.length > 100 || userInput.includes('重要') || userInput.includes('记住')) {
      this.addMemory(
        `对话 - 用户: ${userInput}\n助手: ${agentResponse}`,
        'episodic',
        0.8,
        undefined,
        undefined,
        { type: 'interaction', conversation_id: this.conversationCount }
      );
    }
  }
  public auto_record_conversation(userInput: string, agentResponse: string): void {
    return this.autoRecordConversation(userInput, agentResponse);
  }

  public addKnowledge(content: string, importance = 0.9): string {
    return this.addMemory(content, 'semantic', importance, undefined, undefined, {
      knowledge_type: 'factual',
      source: 'manual'
    });
  }
  public add_knowledge(content: string, importance?: number): string {
    return this.addKnowledge(content, importance ?? 0.9);
  }

  public getContextForQuery(query: string, limit = 3): string {
    const results = this.memoryManager.retrieveMemories(query, undefined, limit, 0.3);
    if (results.length === 0) return '';
    return ['相关记忆:', ...results.map((memory) => `- ${memory.content}`)].join('\n');
  }
  public get_context_for_query(query: string, limit?: number): string {
    return this.getContextForQuery(query, limit ?? 3);
  }

  /** 清除当前会话：重置会话状态，仅清理工作记忆。 */
  public clearSession(): void {
    this.currentSessionId = null;
    this.conversationCount = 0;
    this.memoryManager.memoryTypes.working?.clear();
  }
  public clear_session(): void {
    this.clearSession();
  }

  public consolidateMemories(): number {
    return this.memoryManager.consolidateMemories();
  }
  public consolidate_memories(): number {
    return this.consolidateMemories();
  }

  public forgetOldMemories(maxAgeDays = 30): number {
    return this.memoryManager.forgetMemories('time_based', 0.1, maxAgeDays);
  }
  public forget_old_memories(maxAgeDays?: number): number {
    return this.forgetOldMemories(maxAgeDays ?? 30);
  }

  public override getExpandedTools(): readonly Tool[] | undefined {
    if (!this.expandable) return undefined;
    const specs: Array<{
      action: MemoryAction;
      name: string;
      description: string;
      fields: Record<string, z.ZodTypeAny>;
    }> = [
      {
        action: 'add',
        name: 'memory_add',
        description: '添加新记忆到记忆系统中',
        fields: {
          content: z.string().describe('记忆内容'),
          memory_type: z.string().optional(),
          importance: z.number().optional(),
          file_path: z.string().optional(),
          modality: z.string().optional()
        }
      },
      {
        action: 'search',
        name: 'memory_search',
        description: '搜索相关记忆',
        fields: {
          query: z.string(),
          limit: z.number().optional(),
          memory_type: z.string().optional(),
          min_importance: z.number().optional()
        }
      },
      {
        action: 'summary',
        name: 'memory_summary',
        description: '获取记忆系统摘要（包含重要记忆和统计信息）',
        fields: { limit: z.number().optional() }
      },
      {
        action: 'stats',
        name: 'memory_stats',
        description: '获取记忆系统的统计信息',
        fields: {}
      },
      {
        action: 'update',
        name: 'memory_update',
        description: '更新已存在的记忆',
        fields: {
          memory_id: z.string(),
          content: z.string().optional(),
          importance: z.number().optional()
        }
      },
      {
        action: 'remove',
        name: 'memory_remove',
        description: '删除指定的记忆',
        fields: { memory_id: z.string() }
      },
      {
        action: 'forget',
        name: 'memory_forget',
        description: '按照策略批量遗忘记忆',
        fields: {
          strategy: z.string().optional(),
          threshold: z.number().optional(),
          max_age_days: z.number().optional()
        }
      },
      {
        action: 'consolidate',
        name: 'memory_consolidate',
        description: '将重要的短期记忆整合为长期记忆',
        fields: {
          from_type: z.string().optional(),
          to_type: z.string().optional(),
          importance_threshold: z.number().optional()
        }
      },
      {
        action: 'clear_all',
        name: 'memory_clear',
        description: '清空所有记忆（危险操作，请谨慎使用）',
        fields: {}
      }
    ];
    return specs.map(({ action, name, description, fields }) =>
      toolAction({
        name,
        description,
        parameters: [],
        inputSchema: z.object({ action: z.literal(action).optional(), ...fields }),
        handler: async (input: Record<string, unknown>) =>
          (await this.execute({ ...input, action })).text
      })
    );
  }
}

export type { MemoryItem };
