import { Agent } from '../core/agent.js';
import type { Config } from '../core/config.js';
import type { LLMInvokeOptions } from '../core/llm.js';
import { Message } from '../core/message.js';

/** 上游 Reflection Agent 的默认提示词模板。 */
export const DEFAULT_PROMPTS = Object.freeze({
  initial: `
请根据以下要求完成任务：

任务: {task}

请提供一个完整、准确的回答。
`,
  reflect: `
请仔细审查以下回答，并找出可能的问题或改进空间：

# 原始任务:
{task}

# 当前回答:
{content}

请分析这个回答的质量，指出不足之处，并提出具体的改进建议。
如果回答已经很好，请回答"无需改进"。
`,
  refine: `
请根据反馈意见改进你的回答：

# 原始任务:
{task}

# 上一轮回答:
{last_attempt}

# 反馈意见:
{feedback}

请提供一个改进后的回答。
`
});

export interface ReflectionPrompts {
  readonly initial: string;
  readonly reflect: string;
  readonly refine: string;
}

/** Reflection 轨迹中存储的一条执行或评审记录。 */
export interface ReflectionRecord {
  readonly type: string;
  readonly content: string;
}

/** 上游 `Memory` 的短期执行/反思轨迹存储。 */
export class Memory {
  public readonly records: ReflectionRecord[] = [];

  public addRecord(recordType: string, content: string): void {
    this.records.push({ type: recordType, content });
  }

  public getTrajectory(): string {
    let trajectory = '';
    for (const record of this.records) {
      if (record.type === 'execution')
        trajectory += `--- 上一轮尝试 (代码) ---\n${record.content}\n\n`;
      else if (record.type === 'reflection')
        trajectory += `--- 评审员反馈 ---\n${record.content}\n\n`;
    }
    return trajectory.trim();
  }

  public getLastExecution(): string {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record?.type === 'execution') return record.content;
    }
    return '';
  }
}

export interface ReflectionAgentOptions {
  readonly name: string;
  readonly llm: Agent['llm'];
  readonly systemPrompt?: string;
  readonly config?: Config;
  readonly maxIterations?: number;
  /** 提供时与 Python `custom_prompts` 一样整体替换默认提示词字典。 */
  readonly customPrompts?: ReflectionPrompts;
}

/** 执行、反思并改进回答的教学版 Reflection Agent。 */
export class ReflectionAgent extends Agent {
  public readonly maxIterations: number;
  public readonly prompts: ReflectionPrompts;
  public memory: Memory;

  public constructor(options: ReflectionAgentOptions) {
    super(options.name, options.llm, options.systemPrompt, options.config);
    this.maxIterations = options.maxIterations ?? 3;
    this.memory = new Memory();
    this.prompts = options.customPrompts ?? DEFAULT_PROMPTS;
  }

  public override async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    this.memory = new Memory();

    const initialResult = await this.getLlmResponse(
      this.prompts.initial.replaceAll('{task}', input),
      options
    );
    this.memory.addRecord('execution', initialResult);

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const lastResult = this.memory.getLastExecution();
      const feedback = await this.getLlmResponse(
        this.prompts.reflect.replaceAll('{task}', input).replaceAll('{content}', lastResult),
        options
      );
      this.memory.addRecord('reflection', feedback);

      if (
        feedback.includes('无需改进') ||
        feedback.toLowerCase().includes('no need for improvement')
      )
        break;

      const refinedResult = await this.getLlmResponse(
        this.prompts.refine
          .replaceAll('{task}', input)
          .replaceAll('{last_attempt}', lastResult)
          .replaceAll('{feedback}', feedback),
        options
      );
      this.memory.addRecord('execution', refinedResult);
    }

    const finalResult = this.memory.getLastExecution();
    this.addMessage(new Message(input, 'user'));
    this.addMessage(new Message(finalResult, 'assistant'));
    return finalResult;
  }

  private async getLlmResponse(
    prompt: string,
    options: LLMInvokeOptions | undefined
  ): Promise<string> {
    return (await this.llm.invoke([{ role: 'user', content: prompt }], options)) || '';
  }
}
