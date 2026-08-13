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
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly systemPrompt?: string;
  readonly toolRegistry?: ToolRegistry;
  readonly sessionStore?: SessionStore;
  readonly history?: HistoryManagerOptions;
  /** Opt-in configuration-driven Skill discovery and registration. */
  readonly config?: Pick<ResolvedConfig, 'skillsEnabled' | 'skillsDir' | 'skillsAutoRegister'>;
}
export interface LoadedSessionResult {
  readonly config: { consistent: boolean; warnings: string[] };
  readonly toolSchema: {
    changed: boolean;
    saved_hash: string;
    current_hash: string;
    recommendation: string;
  };
}

/** Abstract shared Agent infrastructure; concrete execution loops remain subclasses' responsibility. */
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
  public async registerConfiguredSkills(): Promise<SkillLoader | undefined> {
    const config = this.config;
    if (!config?.skillsEnabled) return undefined;
    const loader = await SkillLoader.create({ skillsDir: config.skillsDir });
    if (config.skillsAutoRegister) this.toolRegistry.register(new SkillTool(loader));
    return loader;
  }
  public abstract run(input: string): Promise<string>;
  public getHistory(): readonly Message[] {
    return this.historyManager.getAll();
  }
  public async addMessage(content: string, role: Message['role']): Promise<void> {
    this.historyManager.add(new Message(content, role));
    await this.historyManager.compact();
  }
  public clearHistory(): void {
    this.historyManager.clear();
  }
  public buildToolSchemas(): ReturnType<ToolRegistry['toOpenAISchemas']> {
    return this.toolRegistry.toOpenAISchemas();
  }
  public executeToolCall(name: string, input: unknown): Promise<ToolResponse> {
    return this.toolRegistry.execute(name, input);
  }
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
