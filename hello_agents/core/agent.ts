import type { HelloAgentsLLM } from './llm.js';
import { Config } from './config.js';
import type { Message } from './message.js';

/** 教学版 Agent 基类；仅维护追加式消息历史。 */
export abstract class Agent {
  public readonly name: string;
  public readonly llm: HelloAgentsLLM;
  public readonly systemPrompt: string | undefined;
  public readonly config: Config;
  private readonly history: Message[] = [];

  /** 与上游 `Agent(name, llm, system_prompt, config)` 保持一致；config 仅为兼容保留。 */
  public constructor(name: string, llm: HelloAgentsLLM, systemPrompt?: string, config?: Config) {
    this.name = name;
    this.llm = llm;
    this.systemPrompt = systemPrompt;
    this.config = config ?? new Config();
  }

  /** 按具体 Agent 的执行循环处理输入。 */
  public abstract run(input: string): Promise<string>;

  /** 添加消息；教学核心历史只追加，不自动压缩或转换。 */
  public addMessage(message: Message): void {
    this.history.push(message);
  }

  /** 清空所有对话历史。 */
  public clearHistory(): void {
    this.history.length = 0;
  }

  /** 获取历史副本。 */
  public getHistory(): Message[] {
    return this.history.slice();
  }

  public toString(): string {
    return `Agent(name=${this.name}, provider=${this.llm.provider})`;
  }
}
