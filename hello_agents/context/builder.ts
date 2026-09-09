/**
 * ContextBuilder — GSSC 流水线（上游 `context/builder.py` 的教学版移植）。
 *
 * Gather-Select-Structure-Compress 上下文构建流程：
 * 1. Gather: 从多源收集候选信息（系统指令、记忆、RAG、对话历史、额外包）
 * 2. Select: 基于相关性（关键词重叠）、新近性（指数衰减）的复合分排序，
 *    按 min_relevance 过滤并按 token 预算填充
 * 3. Structure: 组织成 [Role & Policies]/[Task]/[State]/[Evidence]/[Context]/[Output] 模板
 * 4. Compress: 超出可用预算时按行截断
 *
 * 调用契约（两套并存）：
 * - 上游契约（v0.2.0）：`new ContextBuilder(memory_tool?, rag_tool?, config?)`，
 *   `build(user_query, history?, system_instructions?, additional_packets?)` 为 async。
 * - 1.x 兼容契约：`new ContextBuilder({ maxTokens, reserveRatio, minRelevance,
 *   enableCompression, tokenCounter })`，`build({ userQuery, conversationHistory,
 *   systemInstructions, additionalPackets })` 同步返回 string（保留 TokenCounter
 *   注入行为与 1.x 输出格式）。`docs/context-engineering-guide.md` 使用此契约。
 *
 * 与上游的差异（docs/upstream-differences.md）：
 * - DIFF-032：上游 `tiktoken`（cl100k_base）在 TS 无内置等价，`countTokens`
 *   使用字符估算（1 token ≈ 4 字符，与上游降级分支一致）；调用方可注入
 *   精确 tokenizer（`TokenCounter`）。
 * - DIFF-033：上游 `build` 同步调用工具的 `run`；TS 侧 RAGTool 检索为异步，
 *   故 `build`/`_gather` 为 async，返回 `Promise<string>`。
 * - 上游 `ContextConfig.enable_mmr` / `mmr_lambda` / `system_prompt_template`
 *   声明但从未使用（dead parameters），TS 侧同声明不消费，语义完全一致。
 */
import type { Message } from '../core/message.js';
import { TokenCounter } from './token-counter.js';

// ---------------------------------------------------------------------------
// 工具结果接口（结构类型：避免 context → tools 的重依赖）
// ---------------------------------------------------------------------------

/** MemoryTool 的最小公开面（`searchMemory` 返回含「未找到」标记的文本）。 */
export interface MemoryToolLike {
  searchMemory(query?: string, limit?: number, memoryType?: string, minImportance?: number): string;
}

/** RAGTool 的最小公开面（`search` 返回工具响应，文本含「未找到」标记）。 */
export interface RagToolLike {
  search(input: { query?: string; limit?: number }): Promise<{ text: string }>;
}

// ---------------------------------------------------------------------------
// 1.x 兼容类型（保留旧公共 API 的类型导出）
// ---------------------------------------------------------------------------

/** 1.x 构造契约（`new ContextBuilder({ ... })`）；与上游位置参数构造并存。 */
export interface ContextBuilderOptions {
  /** 为响应预留 token 后的最大上下文预算。 */
  readonly maxTokens?: number;
  /** 为模型响应预留的预算比例。 */
  readonly reserveRatio?: number;
  /** 非指令数据包的最低词法相关性。 */
  readonly minRelevance?: number;
  /** 超出预算时是否压缩到可用预算。 */
  readonly enableCompression?: boolean;
  /** 用于执行预算限制的 token 计数器（1.x 注入行为，保留）。 */
  readonly tokenCounter?: TokenCounter;
}

/** 1.x 同步 `build` 的入参（旧字段名，guide 沿用）。 */
export interface BuildContextOptions {
  /** 当前用户请求，始终包含在任务部分。 */
  readonly userQuery: string;
  /** 用于构建上下文部分的最近消息。 */
  readonly conversationHistory?: readonly Message[];
  /** 高优先级指令，存在时始终包含。 */
  readonly systemInstructions?: string;
  /** 检索事实、任务状态和其他上下文数据包（1.x 结构或新 class 均可）。 */
  readonly additionalPackets?: readonly (ContextPacket | ContextPacketLike)[];
}

/** 1.x 结构的上下文包（旧字段名 `tokenCount`/`relevanceScore`/数值时间戳）。 */
export interface ContextPacketLike {
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
  readonly timestamp?: number | Date;
  readonly tokenCount?: number;
  readonly relevanceScore?: number;
}

// ---------------------------------------------------------------------------
// ContextPacket / ContextConfig
// ---------------------------------------------------------------------------

/** 上下文信息包（上游 `ContextPacket` dataclass）。 */
export class ContextPacket {
  public content: string;
  public timestamp: Date;
  public metadata: Record<string, unknown>;
  public token_count: number;
  public relevance_score: number;

  public constructor(
    content: string,
    timestamp?: Date,
    metadata?: Record<string, unknown>,
    token_count?: number,
    relevance_score?: number
  ) {
    this.content = content;
    this.timestamp = timestamp ?? new Date();
    this.metadata = metadata ?? {};
    this.token_count = token_count ?? 0;
    this.relevance_score = relevance_score ?? 0.0;
    // 上游 __post_init__：token_count 为 0 时自动按内容计算
    if (this.token_count === 0) this.token_count = countTokens(this.content);
  }

  /** 1.x 兼容字段名（新字段为 `token_count`）。 */
  public get tokenCount(): number {
    return this.token_count;
  }

  /** 1.x 兼容字段名（新字段为 `relevance_score`）。 */
  public get relevanceScore(): number {
    return this.relevance_score;
  }
}

/** 上下文构建配置（上游 `ContextConfig` dataclass）。 */
export class ContextConfig {
  /** 总预算（token）。 */
  public max_tokens = 8000;
  /** 生成余量比例（10-20%）。 */
  public reserve_ratio = 0.15;
  /** 最小相关性阈值。 */
  public min_relevance = 0.3;
  /** 是否启用最大边际相关性（多样性）——上游声明但未使用。 */
  public enable_mmr = true;
  /** MMR 平衡参数（0=纯多样性, 1=纯相关性）——上游声明但未使用。 */
  public mmr_lambda = 0.7;
  /** 系统提示模板——上游声明但未使用。 */
  public system_prompt_template = '';
  /** 是否启用压缩。 */
  public enable_compression = true;

  public constructor(values?: Partial<ContextConfig>) {
    if (values === undefined) return;
    // 显式赋值并跳过 undefined：保留默认值（避免 Object.assign 写入 undefined）
    if (values.max_tokens !== undefined) this.max_tokens = values.max_tokens;
    if (values.reserve_ratio !== undefined) this.reserve_ratio = values.reserve_ratio;
    if (values.min_relevance !== undefined) this.min_relevance = values.min_relevance;
    if (values.enable_mmr !== undefined) this.enable_mmr = values.enable_mmr;
    if (values.mmr_lambda !== undefined) this.mmr_lambda = values.mmr_lambda;
    if (values.system_prompt_template !== undefined)
      this.system_prompt_template = values.system_prompt_template;
    if (values.enable_compression !== undefined)
      this.enable_compression = values.enable_compression;
  }

  /** 获取可用 token 预算（扣除余量）。 */
  public getAvailableTokens(): number {
    return Math.floor(this.max_tokens * (1 - this.reserve_ratio));
  }
}

// ---------------------------------------------------------------------------
// ContextBuilder
// ---------------------------------------------------------------------------

/** 上下文构建器 — GSSC 流水线（上游 `ContextBuilder`，兼容 1.x 契约）。 */
export class ContextBuilder {
  public readonly memory_tool: MemoryToolLike | undefined;
  public readonly rag_tool: RagToolLike | undefined;
  public readonly config: ContextConfig;

  /** 1.x 兼容：注入的 TokenCounter（旧契约 `build` 的预算计数）。 */
  public readonly tokenCounter: TokenCounter;

  private readonly legacyBudget: { maxTokens: number; reserveRatio: number } | undefined;

  /** 1.x 构造契约：`new ContextBuilder({ maxTokens, tokenCounter, ... })`。 */
  public constructor(options?: ContextBuilderOptions | undefined);
  /** 上游构造契约：`new ContextBuilder(memory_tool?, rag_tool?, config?)`。 */
  public constructor(
    memory_tool?: MemoryToolLike | undefined,
    rag_tool?: RagToolLike | undefined,
    config?: ContextConfig | undefined
  );
  public constructor(
    a?: ContextBuilderOptions | MemoryToolLike | undefined,
    b?: RagToolLike | undefined,
    c?: ContextConfig | undefined
  ) {
    if (isLegacyOptions(a)) {
      // 1.x 契约：options 对象 → 旧配置（默认值与上游一致）
      this.tokenCounter = a.tokenCounter ?? new TokenCounter();
      this.config = new ContextConfig({
        ...(a.maxTokens !== undefined ? { max_tokens: a.maxTokens } : {}),
        ...(a.reserveRatio !== undefined ? { reserve_ratio: a.reserveRatio } : {}),
        ...(a.minRelevance !== undefined ? { min_relevance: a.minRelevance } : {}),
        ...(a.enableCompression !== undefined ? { enable_compression: a.enableCompression } : {})
      });
      this.memory_tool = undefined;
      this.rag_tool = undefined;
      this.legacyBudget = {
        maxTokens: a.maxTokens ?? 8000,
        reserveRatio: a.reserveRatio ?? 0.15
      };
    } else {
      // 上游契约：位置参数
      this.memory_tool = a as MemoryToolLike | undefined;
      this.rag_tool = b;
      this.config = c ?? new ContextConfig();
      this.tokenCounter = new TokenCounter();
      this.legacyBudget = undefined;
    }
  }

  /** 1.x 同步构建（`build({ userQuery, ... })`，TokenCounter 预算，返回 string）。 */
  public build(options: BuildContextOptions): string;
  /** 上游异步构建（`build(user_query, history?, sys?, extra?)`，返回 Promise<string>）。 */
  public build(
    user_query: string,
    conversation_history?: readonly Message[] | undefined,
    system_instructions?: string | undefined,
    additional_packets?: readonly (ContextPacket | ContextPacketLike)[] | undefined
  ): Promise<string>;
  public build(
    a: string | BuildContextOptions,
    b?: readonly Message[],
    c?: string,
    d?: readonly (ContextPacket | ContextPacketLike)[]
  ): string | Promise<string> {
    if (typeof a === 'string') return this.buildUpstream(a, b, c, d);
    return this.buildLegacy(a);
  }

  /** 上游 GSSC 异步流水线（Gather → Select → Structure → Compress）。 */
  private async buildUpstream(
    user_query: string,
    conversation_history: readonly Message[] | undefined,
    system_instructions: string | undefined,
    additional_packets: readonly (ContextPacket | ContextPacketLike)[] | undefined
  ): Promise<string> {
    const normalized_extra = (additional_packets ?? []).map((p) => normalizePacket(p));
    const packets = await this._gather(
      user_query,
      conversation_history ?? [],
      system_instructions,
      normalized_extra
    );
    const selected_packets = this._select(packets, user_query);
    const structured_context = this._structure(selected_packets, user_query, system_instructions);
    return this._compress(structured_context);
  }

  /**
   * 1.x 同步契约（精确复刻 1.x 行为：TokenCounter 预算、1.x 输出模板、顺序保留）。
   * 与上游 async 路径并存；`docs/context-engineering-guide.md` 使用本路径。
   */
  private buildLegacy(options: BuildContextOptions): string {
    const budget = Math.floor(
      (this.legacyBudget?.maxTokens ?? 8000) * (1 - (this.legacyBudget?.reserveRatio ?? 0.15))
    );
    const minRelevance = this.config.min_relevance;
    const enableCompression = this.config.enable_compression;

    const packets: LegacyPacket[] = [
      ...(options.systemInstructions
        ? [
            {
              content: options.systemInstructions,
              metadata: { type: 'instructions' },
              explicitScore: undefined
            }
          ]
        : []),
      ...(options.conversationHistory?.length
        ? [
            {
              content: options.conversationHistory
                .slice(-10)
                .map((message) => message.toText())
                .join('\n'),
              metadata: { type: 'history' },
              explicitScore: undefined
            }
          ]
        : []),
      ...(options.additionalPackets ?? []).map((packet) => ({
        content: packet.content,
        metadata: packet.metadata ?? {},
        explicitScore: packet.relevanceScore
      }))
    ];

    const query = new Set(options.userQuery.toLowerCase().split(/\s+/).filter(Boolean));
    const selected = packets.filter((packet) => {
      const type = packet.metadata['type'];
      if (type === 'instructions') return true;
      const words = new Set(packet.content.toLowerCase().split(/\s+/));
      const score =
        packet.explicitScore ??
        (query.size === 0 ? 0 : [...query].filter((word) => words.has(word)).length / query.size);
      return score >= minRelevance;
    });

    const byType = (type: string | readonly string[]) =>
      selected.filter((packet) => {
        const value = packet.metadata['type'];
        return Array.isArray(type) ? type.includes(String(value)) : value === type;
      });

    const sections = [
      ...byType('instructions').map((packet) => `[Role & Policies]\n${packet.content}`),
      `[Task]\n用户问题：${options.userQuery}`,
      ...(byType(['task_state']).length
        ? [
            `[State]\n关键进展与未决问题：\n${byType('task_state')
              .map((packet) => packet.content)
              .join('\n')}`
          ]
        : []),
      ...(byType(['related_memory', 'knowledge_base', 'retrieval', 'tool_result']).length
        ? [
            `[Evidence]\n事实与引用：\n${byType([
              'related_memory',
              'knowledge_base',
              'retrieval',
              'tool_result'
            ])
              .map((packet) => packet.content)
              .join('\n')}`
          ]
        : []),
      ...(byType('history').length
        ? [
            `[Context]\n对话历史与背景：\n${byType('history')
              .map((packet) => packet.content)
              .join('\n')}`
          ]
        : []),
      '[Output]\n请按以下格式回答：\n1. 结论（简洁明确）\n2. 依据（列出支撑证据及来源）\n3. 风险与假设（如有）\n4. 下一步行动建议（如适用）'
    ];
    const result = sections.join('\n\n');
    if (!enableCompression || this.tokenCounter.count(result) <= budget) return result;
    const kept: string[] = [];
    for (const line of result.split('\n')) {
      if (this.tokenCounter.count([...kept, line].join('\n')) > budget) break;
      kept.push(line);
    }
    return kept.join('\n');
  }

  /** Gather: 收集候选信息（P0 系统指令 / P1 记忆 / P2 RAG / P3 对话历史 / 额外包）。 */
  public async _gather(
    user_query: string,
    conversation_history: readonly Message[],
    system_instructions: string | undefined,
    additional_packets: readonly ContextPacket[]
  ): Promise<ContextPacket[]> {
    const packets: ContextPacket[] = [];

    // P0: 系统指令（强约束）
    if (system_instructions) {
      packets.push(new ContextPacket(system_instructions, undefined, { type: 'instructions' }));
    }

    // P1: 从记忆中获取任务状态与关键结论
    if (this.memory_tool) {
      try {
        const state_results = this.memory_tool.searchMemory(
          '(任务状态 OR 子目标 OR 结论 OR 阻塞)',
          5,
          undefined,
          0.7
        );
        if (state_results && !state_results.includes('未找到')) {
          packets.push(
            new ContextPacket(state_results, undefined, { type: 'task_state', importance: 'high' })
          );
        }

        const related_results = this.memory_tool.searchMemory(user_query, 5);
        if (related_results && !related_results.includes('未找到')) {
          packets.push(new ContextPacket(related_results, undefined, { type: 'related_memory' }));
        }
      } catch (error) {
        console.warn(`⚠️ 记忆检索失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // P2: 从 RAG 中获取事实证据（DIFF-033：检索为异步）
    if (this.rag_tool) {
      try {
        const rag_response = await this.rag_tool.search({ query: user_query, limit: 5 });
        const rag_results = rag_response.text;
        if (rag_results && !rag_results.includes('未找到') && !rag_results.includes('错误')) {
          packets.push(new ContextPacket(rag_results, undefined, { type: 'knowledge_base' }));
        }
      } catch (error) {
        console.warn(`⚠️ RAG检索失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // P3: 对话历史（辅助材料，只保留最近 10 条）
    if (conversation_history.length > 0) {
      const recent_history = conversation_history.slice(-10);
      const history_text = recent_history.map((msg) => `[${msg.role}] ${msg.content}`).join('\n');
      packets.push(
        new ContextPacket(history_text, undefined, {
          type: 'history',
          count: recent_history.length
        })
      );
    }

    // 添加额外包
    packets.push(...additional_packets);

    return packets;
  }

  /** Select: 基于复合分（0.7 相关性 + 0.3 新近性）与预算的筛选。 */
  public _select(packets: ContextPacket[], user_query: string): ContextPacket[] {
    // 1) 计算相关性（关键词重叠）
    const query_tokens = new Set(user_query.toLowerCase().split(/\s+/).filter(Boolean));
    for (const packet of packets) {
      const content_tokens = new Set(packet.content.toLowerCase().split(/\s+/).filter(Boolean));
      packet.relevance_score =
        query_tokens.size > 0
          ? [...query_tokens].filter((token) => content_tokens.has(token)).length /
            query_tokens.size
          : 0.0;
    }

    // 2) 计算新近性（指数衰减，1 小时时间尺度）
    const recency_score = (ts: Date): number => {
      const delta = Math.max((Date.now() - ts.getTime()) / 1000, 0);
      const tau = 3600;
      return Math.exp(-delta / tau);
    };

    // 3) 计算复合分：0.7*相关性 + 0.3*新近性
    const scored_packets: Array<[number, ContextPacket]> = packets.map((p) => {
      const rec = recency_score(p.timestamp);
      return [0.7 * p.relevance_score + 0.3 * rec, p];
    });

    // 4) 系统指令单独拿出，固定纳入
    const system_packets = scored_packets
      .filter(([, p]) => p.metadata['type'] === 'instructions')
      .map(([, p]) => p);
    const remaining = [...scored_packets]
      .sort((a, b) => b[0] - a[0])
      .map(([, p]) => p)
      .filter((p) => p.metadata['type'] !== 'instructions');

    // 5) 依据 min_relevance 过滤（对非系统包）
    const filtered = remaining.filter((p) => p.relevance_score >= this.config.min_relevance);

    // 6) 按预算填充（先系统指令，再按分数加入其余）
    const available_tokens = this.config.getAvailableTokens();
    const selected: ContextPacket[] = [];
    let used_tokens = 0;

    for (const p of system_packets) {
      if (used_tokens + p.token_count <= available_tokens) {
        selected.push(p);
        used_tokens += p.token_count;
      }
    }
    for (const p of filtered) {
      if (used_tokens + p.token_count > available_tokens) continue;
      selected.push(p);
      used_tokens += p.token_count;
    }

    return selected;
  }

  /** Structure: 组织成结构化上下文模板。 */
  public _structure(
    selected_packets: ContextPacket[],
    user_query: string,
    system_instructions: string | undefined
  ): string {
    // 上游同签名：system_instructions 在 _structure 中不消费（仅 build 透传）
    void system_instructions;
    const sections: string[] = [];

    // [Role & Policies] - 系统指令
    const p0_packets = selected_packets.filter((p) => p.metadata['type'] === 'instructions');
    if (p0_packets.length > 0) {
      let role_section = '[Role & Policies]\n';
      role_section += p0_packets.map((p) => p.content).join('\n');
      sections.push(role_section);
    }

    // [Task] - 当前任务
    sections.push(`[Task]\n用户问题：${user_query}`);

    // [State] - 任务状态
    const p1_packets = selected_packets.filter((p) => p.metadata['type'] === 'task_state');
    if (p1_packets.length > 0) {
      let state_section = '[State]\n关键进展与未决问题：\n';
      state_section += p1_packets.map((p) => p.content).join('\n');
      sections.push(state_section);
    }

    // [Evidence] - 事实证据
    const p2_packets = selected_packets.filter((p) =>
      ['related_memory', 'knowledge_base', 'retrieval', 'tool_result'].includes(
        String(p.metadata['type'])
      )
    );
    if (p2_packets.length > 0) {
      let evidence_section = '[Evidence]\n事实与引用：\n';
      for (const p of p2_packets) {
        evidence_section += `\n${p.content}\n`;
      }
      sections.push(evidence_section);
    }

    // [Context] - 辅助材料（历史等）
    const p3_packets = selected_packets.filter((p) => p.metadata['type'] === 'history');
    if (p3_packets.length > 0) {
      let context_section = '[Context]\n对话历史与背景：\n';
      context_section += p3_packets.map((p) => p.content).join('\n');
      sections.push(context_section);
    }

    // [Output] - 输出约束（与上游模板逐字一致，含缩进）
    const output_section = `[Output]
                            请按以下格式回答：
                            1. 结论（简洁明确）
                            2. 依据（列出支撑证据及来源）
                            3. 风险与假设（如有）
                            4. 下一步行动建议（如适用）`;
    sections.push(output_section);

    return sections.join('\n\n');
  }

  /** Compress: 压缩与规范化（超出预算时按行截断，保留结构）。 */
  public _compress(context: string): string {
    if (!this.config.enable_compression) return context;

    const current_tokens = countTokens(context);
    const available_tokens = this.config.getAvailableTokens();

    if (current_tokens <= available_tokens) return context;

    // 简单截断策略（保留前 N 个 token）；实际应用可用 LLM 做高保真摘要
    console.warn(`⚠️ 上下文超预算 (${current_tokens} > ${available_tokens})，执行截断`);

    const lines = context.split('\n');
    const compressed_lines: string[] = [];
    let used_tokens = 0;

    for (const line of lines) {
      const line_tokens = countTokens(line);
      if (used_tokens + line_tokens > available_tokens) break;
      compressed_lines.push(line);
      used_tokens += line_tokens;
    }

    return compressed_lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 1.x 同步路径的内部包形状（显式分数用于区分「未提供」与「显式 0」）。 */
interface LegacyPacket {
  content: string;
  metadata: Record<string, unknown>;
  explicitScore: number | undefined;
}

/** 将 1.x 结构或 class 包统一归一化为 class 实例。 */
function normalizePacket(packet: ContextPacket | ContextPacketLike): ContextPacket {
  if (packet instanceof ContextPacket) return packet;
  return new ContextPacket(
    packet.content,
    packet.timestamp === undefined
      ? undefined
      : packet.timestamp instanceof Date
        ? packet.timestamp
        : new Date(packet.timestamp),
    packet.metadata,
    packet.tokenCount,
    packet.relevanceScore
  );
}

/** 判定 1.x options 构造（对象含任一旧选项键）。 */
function isLegacyOptions(
  value: ContextBuilderOptions | MemoryToolLike | undefined
): value is ContextBuilderOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('maxTokens' in value ||
      'reserveRatio' in value ||
      'minRelevance' in value ||
      'enableCompression' in value ||
      'tokenCounter' in value)
  );
}

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

/**
 * 计算文本 token 数（上游 `count_tokens`）。
 * DIFF-032：上游用 tiktoken（cl100k_base），TS 无内置等价 tokenizer；
 * 使用降级估算（1 token ≈ 4 字符），与上游异常分支的语义一致。
 */
export function countTokens(text: string): number {
  return Math.floor([...text].length / 4);
}
