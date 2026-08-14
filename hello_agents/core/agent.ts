import type { HelloAgentsLLM } from './llm.js';
import type { ResolvedConfig } from './config.js';
import { Message } from './message.js';
import { HistoryManager } from '../context/history.js';
import type { HistoryManagerOptions } from '../context/history.js';
import type { SessionStore } from './session-store.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolResponse } from '../tools/response.js';
import { SkillLoader } from '../skills/loader.js';
import { SkillTool } from '../tools/builtin/skill-tool.js';

export interface AgentOptions {
  /** Agent 名称，用于事件和持久化会话。 */
  readonly name: string;
  /** 具体执行循环使用的 LLM 客户端。 */
  readonly llm: HelloAgentsLLM;
  /** 具体 Agent 调用前追加的可选系统提示词。 */
  readonly systemPrompt?: string;
  /** 隔离的工具注册表；未提供时创建新的注册表。 */
  readonly toolRegistry?: ToolRegistry;
  /** 可选的持久化会话存储；保存/加载会话需要提供此项。 */
  readonly sessionStore?: SessionStore;
  /** 历史消息保留和压缩策略。 */
  readonly history?: HistoryManagerOptions;
  /** 可选的配置驱动 Skill 发现和注册。 */
  readonly config?: Pick<ResolvedConfig, 'skillsEnabled' | 'skillsDir' | 'skillsAutoRegister'>;
}
export interface LoadedSessionResult {
  /** 保存配置和当前 Agent 配置的比较结果。 */
  readonly config: { consistent: boolean; warnings: string[] };
  /** 工具模式比较结果，用于判断恢复的工具状态是否可能过期。 */
  readonly toolSchema: {
    changed: boolean;
    saved_hash: string;
    current_hash: string;
    recommendation: string;
  };
}

/** Agent 抽象基类，提供共享基础设施；具体执行循环由子类负责。 */
export abstract class Agent {
  public readonly name: string;
  public readonly llm: HelloAgentsLLM;
  public readonly systemPrompt: string | undefined;
  public readonly toolRegistry: ToolRegistry;
  public readonly sessionStore: SessionStore | undefined;
  private readonly config: AgentOptions['config'];
  protected readonly historyManager: HistoryManager;

  public constructor(options: AgentOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt;
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.sessionStore = options.sessionStore;
    this.config = options.config;
    this.historyManager = new HistoryManager(options.history ?? { maxTokens: 128_000 });
  }
  /**
   * 发现已配置的技能，并可选注册其渐进式加载工具。
   *
   * @returns 技能加载器；未启用技能时返回 undefined。
   */
  public async registerConfiguredSkills(): Promise<SkillLoader | undefined> {
    const config = this.config;
    if (!config?.skillsEnabled) return undefined;
    const loader = await SkillLoader.create({ skillsDir: config.skillsDir });
    if (config.skillsAutoRegister) this.toolRegistry.register(new SkillTool(loader));
    return loader;
  }
  /** 按具体 Agent 的执行循环处理输入。 */
  public abstract run(input: string): Promise<string>;
  /** 获取对话历史副本。 */
  public getHistory(): readonly Message[] {
    return this.historyManager.getAll();
  }
  /**
   * 添加消息；超过配置的 token 预算时压缩历史。
   *
   * @param content 消息内容。
   * @param role 消息角色。
   */
  public async addMessage(content: string, role: Message['role']): Promise<void> {
    this.historyManager.add(new Message(content, role));
    await this.historyManager.compact();
  }
  /** 清空所有保留的对话历史。 */
  public clearHistory(): void {
    this.historyManager.clear();
  }
  /** 为当前注册表构建提供商 Function Calling 模式。 */
  public buildToolSchemas(): ReturnType<ToolRegistry['toOpenAISchemas']> {
    return this.toolRegistry.toOpenAISchemas();
  }
  /**
   * 使用协议错误标准化执行一个已注册工具。
   *
   * @param name 工具名称。
   * @param input 工具输入。
   * @returns 标准化的工具响应。
   */
  public executeToolCall(name: string, input: unknown): Promise<ToolResponse> {
    return this.toolRegistry.execute(name, input);
  }
  /** 持久化 Agent 的历史和工具缓存；需要配置 `SessionStore`。 */
  public async saveSession(sessionName?: string): Promise<string> {
    if (!this.sessionStore) throw new Error('SessionStore is not configured');
    return this.sessionStore.save({
      ...(sessionName === undefined ? {} : { sessionName }),
      agentConfig: { name: this.name, llm_model: this.llm.model, max_steps: undefined },
      history: this.getHistory(),
      toolSchemaHash: this.toolSchemaHash(),
      readCache: Object.fromEntries(this.toolRegistry.readMetadataCache),
      metadata: {}
    });
  }
  /** 恢复历史和读取元数据，并报告配置兼容性。 */
  public async loadSession(filepath: string): Promise<LoadedSessionResult> {
    if (!this.sessionStore) throw new Error('SessionStore is not configured');
    const data = await this.sessionStore.load(filepath);
    const json = data.toJSON();
    this.historyManager.clear();
    for (const message of data.history) this.historyManager.add(message);
    this.toolRegistry.clearReadCache();
    for (const [path, metadata] of Object.entries(json.read_cache))
      this.toolRegistry.cacheReadMetadata(path, metadata);
    return {
      config: this.sessionStore.checkConfigConsistency(json.agent_config, {
        name: this.name,
        llm_model: this.llm.model,
        max_steps: undefined
      }),
      toolSchema: this.sessionStore.checkToolSchemaConsistency(
        json.tool_schema_hash,
        this.toolSchemaHash()
      )
    };
  }
  private toolSchemaHash(): string {
    const input = JSON.stringify(this.buildToolSchemas());
    let hash = 0;
    for (let index = 0; index < input.length; index += 1)
      hash = (hash * 31 + input.charCodeAt(index)) | 0;
    return `ts-${(hash >>> 0).toString(16)}`;
  }
}
