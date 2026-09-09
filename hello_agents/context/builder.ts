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
 * 与上游的差异（docs/upstream-differences.md）：
 * - DIFF-030：上游 `tiktoken`（cl100k_base）在 TS 无内置等价，`countTokens`
 *   使用字符估算（1 token ≈ 4 字符，与上游降级分支一致）；调用方可注入
 *   精确 tokenizer（`TokenCounter`）。
 * - DIFF-031：上游 `build` 同步调用工具的 `run`；TS 侧 RAGTool 检索为异步，
 *   故 `build`/`_gather` 为 async，返回 `Promise<string>`。
 * - 上游 `ContextConfig.enable_mmr` / `mmr_lambda` / `system_prompt_template`
 *   声明但从未使用（dead parameters），TS 侧同声明不消费，语义完全一致。
 */
import type { Message } from '../core/message.js';

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
    Object.assign(this, values);
  }

  /** 获取可用 token 预算（扣除余量）。 */
  public getAvailableTokens(): number {
    return Math.floor(this.max_tokens * (1 - this.reserve_ratio));
  }
}

// ---------------------------------------------------------------------------
// ContextBuilder
// ---------------------------------------------------------------------------

/** 上下文构建器 — GSSC 流水线（上游 `ContextBuilder`）。 */
export class ContextBuilder {
  public readonly memory_tool: MemoryToolLike | undefined;
  public readonly rag_tool: RagToolLike | undefined;
  public readonly config: ContextConfig;

  public constructor(
    memory_tool?: MemoryToolLike | undefined,
    rag_tool?: RagToolLike | undefined,
    config?: ContextConfig | undefined
  ) {
    this.memory_tool = memory_tool;
    this.rag_tool = rag_tool;
    this.config = config ?? new ContextConfig();
  }

  /** 构建完整上下文（Gather → Select → Structure → Compress）。 */
  public async build(
    user_query: string,
    conversation_history?: readonly Message[] | undefined,
    system_instructions?: string | undefined,
    additional_packets?: readonly ContextPacket[] | undefined
  ): Promise<string> {
    // 1. Gather: 收集候选信息
    const packets = await this._gather(
      user_query,
      conversation_history ?? [],
      system_instructions,
      additional_packets ?? []
    );

    // 2. Select: 筛选与排序
    const selected_packets = this._select(packets, user_query);

    // 3. Structure: 组织成结构化模板
    const structured_context = this._structure(selected_packets, user_query, system_instructions);

    // 4. Compress: 压缩与规范化（如果超预算）
    return this._compress(structured_context);
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

    // P2: 从 RAG 中获取事实证据（DIFF-031：检索为异步）
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
// countTokens
// ---------------------------------------------------------------------------

/**
 * 计算文本 token 数（上游 `count_tokens`）。
 * DIFF-030：上游用 tiktoken（cl100k_base），TS 无内置等价 tokenizer；
 * 使用降级估算（1 token ≈ 4 字符），与上游异常分支的语义一致。
 */
export function countTokens(text: string): number {
  return Math.floor([...text].length / 4);
}
