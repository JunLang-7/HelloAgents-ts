import type { LLMMessage } from '../adapters/base.js';
import { AgentEvent } from '../core/lifecycle.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { Message } from '../core/message.js';
import { ToolRegistry } from '../tools/registry.js';

/** 初始执行、反思和改进阶段使用的默认提示词。 */
export const DEFAULT_REFLECTION_PROMPTS = Object.freeze({
  initial: '请根据以下要求完成任务：\n\n任务: {task}\n\n请提供一个完整、准确的回答。',
  reflect:
    '请仔细审查以下回答，并找出可能的问题或改进空间：\n\n# 原始任务:\n{task}\n\n# 当前回答:\n{content}\n\n请分析这个回答的质量，指出不足之处，并提出具体的改进建议。\n如果回答已经很好，请回答"无需改进"。',
  refine:
    '请根据反馈意见改进你的回答：\n\n# 原始任务:\n{task}\n\n# 上一轮回答:\n{last_attempt}\n\n# 反馈意见:\n{feedback}\n\n请提供一个改进后的回答。'
});

export interface ReflectionPrompts {
  /** 生成第一版回答的提示词。 */
  readonly initial: string;
  /** 评审当前回答的提示词。 */
  readonly reflect: string;
  /** 根据反馈改进回答的提示词。 */
  readonly refine: string;
}

/** 反思运行中保留的一次回答或评审记录。 */
export type ReflectionRecord = {
  readonly type: 'execution' | 'reflection';
  readonly content: string;
};

/** 按顺序保存回答和反馈的反思记忆。 */
export class ReflectionMemory {
  public readonly records: ReflectionRecord[] = [];
  /** 添加一次执行回答或反思反馈记录。 */
  public addRecord(type: ReflectionRecord['type'], content: string): void {
    this.records.push({ type, content });
  }
  /** 返回最近一次回答；不存在时返回空字符串。 */
  public getLastExecution(): string {
    return [...this.records].reverse().find((record) => record.type === 'execution')?.content ?? '';
  }
  /** 格式化完整的执行/反思轨迹，便于检查。 */
  public getTrajectory(): string {
    return this.records
      .map((record) =>
        record.type === 'execution'
          ? `--- 上一轮尝试 (代码) ---\n${record.content}`
          : `--- 评审员反馈 ---\n${record.content}`
      )
      .join('\n\n');
  }
}

export interface ReflectionAgentOptions {
  /** Agent 名称，用于历史记录和事件。 */
  readonly name: string;
  /** 所有反思阶段使用的 LLM 客户端。 */
  readonly llm: HelloAgentsLLM;
  /** 每个阶段前追加的可选系统提示词。 */
  readonly systemPrompt?: string;
  /** 每个阶段进行函数调用时使用的可选工具注册表。 */
  readonly toolRegistry?: ToolRegistry;
  /** 存在工具注册表时是否启用工具调用。 */
  readonly enableToolCalling?: boolean;
  /** 每个阶段允许的最大 Function Calling 轮数。 */
  readonly maxToolIterations?: number;
  /** 初始回答之后允许的最大评审/改进轮数。 */
  readonly maxIterations?: number;
  /** 对默认反思提示词的部分覆盖。 */
  readonly customPrompts?: Partial<ReflectionPrompts>;
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(
    /\{(task|content|last_attempt|feedback)\}/g,
    (_, key: string) => values[key] ?? ''
  );
}

function noImprovement(value: string): boolean {
  return value.includes('无需改进') || value.toLowerCase().includes('no need for improvement');
}

/** 反思型 Agent；每个 LLM 阶段都支持有界 Function Calling。 */
export class ReflectionAgent {
  public readonly name: string;
  public readonly llm: HelloAgentsLLM;
  public readonly systemPrompt: string | undefined;
  public readonly toolRegistry: ToolRegistry;
  public readonly maxIterations: number;
  public readonly maxToolIterations: number;
  public readonly prompts: ReflectionPrompts;
  public memory = new ReflectionMemory();
  private readonly enableToolCalling: boolean;
  private history: Message[] = [];

  public constructor(options: ReflectionAgentOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt;
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.enableToolCalling =
      (options.enableToolCalling ?? true) && options.toolRegistry !== undefined;
    this.maxIterations = options.maxIterations ?? 3;
    this.maxToolIterations = options.maxToolIterations ?? 3;
    this.prompts = { ...DEFAULT_REFLECTION_PROMPTS, ...options.customPrompts };
  }

  /** 获取已完成用户/助手对话的副本。 */
  public getHistory(): readonly Message[] {
    return [...this.history];
  }

  /** 生成、评审并改进回答，直到评审认为无需改进。 */
  public async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    this.memory = new ReflectionMemory();
    const initial = await this.respond(render(this.prompts.initial, { task: input }), options);
    this.memory.addRecord('execution', initial);
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const previous = this.memory.getLastExecution();
      const feedback = await this.respond(
        render(this.prompts.reflect, { task: input, content: previous }),
        options
      );
      this.memory.addRecord('reflection', feedback);
      if (noImprovement(feedback)) break;
      const refined = await this.respond(
        render(this.prompts.refine, { task: input, last_attempt: previous, feedback }),
        options
      );
      this.memory.addRecord('execution', refined);
    }
    return this.complete(input);
  }

  /** 为初始、反思和改进阶段发送生命周期事件。 */
  public async *arunStream(input: string, options?: LLMInvokeOptions): AsyncIterable<AgentEvent> {
    yield AgentEvent.create('agent_start', this.name, { input_text: input });
    try {
      this.memory = new ReflectionMemory();
      yield AgentEvent.create('step_start', this.name, { phase: 'initial_execution' });
      const initial = await this.respond(render(this.prompts.initial, { task: input }), options);
      this.memory.addRecord('execution', initial);
      yield AgentEvent.create('step_finish', this.name, {
        phase: 'initial_execution',
        result: initial
      });
      for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
        const previous = this.memory.getLastExecution();
        yield AgentEvent.create('step_start', this.name, {
          phase: 'reflection',
          iteration: iteration + 1
        });
        const feedback = await this.respond(
          render(this.prompts.reflect, { task: input, content: previous }),
          options
        );
        this.memory.addRecord('reflection', feedback);
        yield AgentEvent.create('reflection', this.name, { iteration: iteration + 1, feedback });
        yield AgentEvent.create('step_finish', this.name, {
          phase: 'reflection',
          iteration: iteration + 1
        });
        if (noImprovement(feedback)) break;
        yield AgentEvent.create('step_start', this.name, {
          phase: 'refinement',
          iteration: iteration + 1
        });
        const refined = await this.respond(
          render(this.prompts.refine, { task: input, last_attempt: previous, feedback }),
          options
        );
        this.memory.addRecord('execution', refined);
        yield AgentEvent.create('step_finish', this.name, {
          phase: 'refinement',
          iteration: iteration + 1,
          result: refined
        });
      }
      const result = this.complete(input);
      yield AgentEvent.create('agent_finish', this.name, { result });
    } catch (error) {
      yield AgentEvent.create('agent_error', this.name, {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async respond(prompt: string, options: LLMInvokeOptions | undefined): Promise<string> {
    const messages: LLMMessage[] = [
      ...(this.systemPrompt === undefined
        ? []
        : [{ role: 'system' as const, content: this.systemPrompt }]),
      { role: 'user', content: prompt }
    ];
    if (!this.enableToolCalling) return (await this.llm.invoke(messages, options)).content;
    const schemas = this.toolRegistry.toOpenAISchemas() as unknown as Record<string, unknown>[];
    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      const response = await this.llm.invokeWithTools(messages, schemas, 'auto', options);
      if (response.toolCalls.length === 0) return response.content ?? '';
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
      });
      for (const call of response.toolCalls) {
        const result = await this.toolRegistry.execute(call.name, call.arguments);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
      }
    }
    return (await this.llm.invoke(messages, options)).content;
  }

  private complete(input: string): string {
    const result = this.memory.getLastExecution();
    this.history.push(new Message(input, 'user'), new Message(result, 'assistant'));
    return result;
  }
}
