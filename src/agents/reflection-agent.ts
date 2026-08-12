import type { LLMMessage } from '../adapters/base.js';
import { AgentEvent } from '../core/lifecycle.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { Message } from '../core/message.js';
import { ToolRegistry } from '../tools/registry.js';

export const DEFAULT_REFLECTION_PROMPTS = Object.freeze({
  initial: '请根据以下要求完成任务：\n\n任务: {task}\n\n请提供一个完整、准确的回答。',
  reflect:
    '请仔细审查以下回答，并找出可能的问题或改进空间：\n\n# 原始任务:\n{task}\n\n# 当前回答:\n{content}\n\n请分析这个回答的质量，指出不足之处，并提出具体的改进建议。\n如果回答已经很好，请回答"无需改进"。',
  refine:
    '请根据反馈意见改进你的回答：\n\n# 原始任务:\n{task}\n\n# 上一轮回答:\n{last_attempt}\n\n# 反馈意见:\n{feedback}\n\n请提供一个改进后的回答。'
});

export interface ReflectionPrompts {
  readonly initial: string;
  readonly reflect: string;
  readonly refine: string;
}

export type ReflectionRecord = {
  readonly type: 'execution' | 'reflection';
  readonly content: string;
};

export class ReflectionMemory {
  public readonly records: ReflectionRecord[] = [];
  public addRecord(type: ReflectionRecord['type'], content: string): void {
    this.records.push({ type, content });
  }
  public getLastExecution(): string {
    return [...this.records].reverse().find((record) => record.type === 'execution')?.content ?? '';
  }
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
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly systemPrompt?: string;
  readonly toolRegistry?: ToolRegistry;
  readonly enableToolCalling?: boolean;
  readonly maxToolIterations?: number;
  readonly maxIterations?: number;
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

/** Python V1 reflection loop with bounded Function Calling for each LLM phase. */
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

  public getHistory(): readonly Message[] {
    return [...this.history];
  }

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
