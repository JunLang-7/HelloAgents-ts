import type { LLMMessage } from '../adapters/base.js';
import { AgentEvent } from '../core/lifecycle.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { Message } from '../core/message.js';
import { ToolRegistry } from '../tools/registry.js';

/** Default prompt that asks the model for a literal list of executable steps. */
export const DEFAULT_PLANNER_PROMPT =
  '你是一个顶级的AI规划专家。请将问题拆成独立、可执行的步骤，并以 Python 字符串列表输出。\n\n问题: {question}';
/** Default prompt used to execute each planned step with prior results. */
export const DEFAULT_EXECUTOR_PROMPT =
  '请严格执行当前步骤并只输出该步骤的最终答案。\n\n# 原始问题:\n{question}\n\n# 完整计划:\n{plan}\n\n# 历史步骤与结果:\n{history}\n\n# 当前步骤:\n{current_step}';
/** Returned when the planner response cannot be safely parsed into steps. */
export const INVALID_PLAN_ANSWER = '无法生成有效的行动计划，任务终止。';

export interface PlanSolveAgentOptions {
  /** Stable agent name used in history and lifecycle events. */
  readonly name: string;
  /** LLM client used for planning and execution. */
  readonly llm: HelloAgentsLLM;
  /** Optional instruction prepended to both planning and execution calls. */
  readonly systemPrompt?: string;
  /** Optional tool registry available while planning and executing. */
  readonly toolRegistry?: ToolRegistry;
  /** Enables function calling when a registry is supplied. */
  readonly enableToolCalling?: boolean;
  /** Maximum function-calling rounds per planning or execution request. */
  readonly maxToolIterations?: number;
  /** Partial override for the planner and executor prompts. */
  readonly customPrompts?: { readonly planner?: string; readonly executor?: string };
}

function extractPlanText(response: string): string {
  const block = /```(?:python)?\s*([\s\S]*?)```/i.exec(response)?.[1];
  return (block ?? response).trim();
}

/** Parses only a literal list of quoted strings; it never executes model output. */
export function parsePlan(response: string): string[] {
  const text = extractPlanText(response);
  try {
    const json: unknown = JSON.parse(text);
    return Array.isArray(json) && json.every((step) => typeof step === 'string') ? json : [];
  } catch {
    // Python V1 asks for a Python list. Support its quoted-literal subset safely.
  }
  if (!text.startsWith('[') || !text.endsWith(']')) return [];
  const items: string[] = [];
  let index = 1;
  while (index < text.length - 1) {
    while (/\s|,/.test(text[index] ?? '')) index += 1;
    if (index >= text.length - 1) break;
    const quote = text[index];
    if (quote !== '"' && quote !== "'") return [];
    index += 1;
    let value = '';
    let closed = false;
    while (index < text.length - 1) {
      const character = text[index] ?? '';
      index += 1;
      if (character === '\\') {
        const escaped = text[index] ?? '';
        index += 1;
        value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
      } else if (character === quote) {
        closed = true;
        break;
      } else value += character;
    }
    if (!closed) return [];
    items.push(value);
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (text[index] === ',') index += 1;
    else if (index < text.length - 1) return [];
  }
  return items;
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(
    /\{(question|plan|history|current_step)\}/g,
    (_, key: string) => values[key] ?? ''
  );
}

/** Python V1 PlanAndSolveAgent, named PlanSolveAgent for the public TypeScript API. */
export class PlanSolveAgent {
  public readonly name: string;
  public readonly llm: HelloAgentsLLM;
  public readonly systemPrompt: string | undefined;
  public readonly toolRegistry: ToolRegistry;
  public readonly maxToolIterations: number;
  public readonly plannerPrompt: string;
  public readonly executorPrompt: string;
  public lastPlan: readonly string[] = [];
  public lastStepResults: readonly string[] = [];
  private readonly enableToolCalling: boolean;
  private history: Message[] = [];

  public constructor(options: PlanSolveAgentOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt;
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.enableToolCalling =
      (options.enableToolCalling ?? true) && options.toolRegistry !== undefined;
    this.maxToolIterations = options.maxToolIterations ?? 3;
    this.plannerPrompt = options.customPrompts?.planner ?? DEFAULT_PLANNER_PROMPT;
    this.executorPrompt = options.customPrompts?.executor ?? DEFAULT_EXECUTOR_PROMPT;
  }

  /** Returns a snapshot of completed user/assistant exchanges. */
  public getHistory(): readonly Message[] {
    return [...this.history];
  }

  /** Creates a plan, executes its steps in order, and returns the final step result. */
  public async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    const plan = await this.createPlan(input, options);
    if (plan.length === 0) return this.complete(input, INVALID_PLAN_ANSWER);
    const results = await this.executePlan(input, plan, options);
    return this.complete(input, results.at(-1) ?? '');
  }

  /** Emits planning and per-step execution events for one plan-and-solve run. */
  public async *arunStream(input: string, options?: LLMInvokeOptions): AsyncIterable<AgentEvent> {
    yield AgentEvent.create('agent_start', this.name, { input_text: input });
    try {
      yield AgentEvent.create('step_start', this.name, {
        phase: 'planning',
        description: '生成执行计划'
      });
      const plan = await this.createPlan(input, options);
      if (plan.length === 0) {
        const result = this.complete(input, INVALID_PLAN_ANSWER);
        yield AgentEvent.create('agent_error', this.name, { error: result, phase: 'planning' });
        yield AgentEvent.create('agent_finish', this.name, { result });
        return;
      }
      yield AgentEvent.create('plan', this.name, { plan, total_steps: plan.length });
      yield AgentEvent.create('step_finish', this.name, {
        phase: 'planning',
        plan,
        total_steps: plan.length
      });
      const results: string[] = [];
      for (const [index, step] of plan.entries()) {
        yield AgentEvent.create('step_start', this.name, {
          phase: 'execution',
          step: index + 1,
          total_steps: plan.length,
          description: step
        });
        const result = await this.executeStep(input, plan, results, step, options);
        results.push(result);
        yield AgentEvent.create('step_finish', this.name, {
          phase: 'execution',
          step: index + 1,
          result
        });
      }
      this.lastStepResults = results;
      const result = this.complete(input, results.at(-1) ?? '');
      yield AgentEvent.create('agent_finish', this.name, { result, total_steps: plan.length });
    } catch (error) {
      yield AgentEvent.create('agent_error', this.name, {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private async createPlan(
    input: string,
    options: LLMInvokeOptions | undefined
  ): Promise<string[]> {
    const response = await this.respond(render(this.plannerPrompt, { question: input }), options);
    const plan = parsePlan(response);
    this.lastPlan = plan;
    this.lastStepResults = [];
    return plan;
  }

  private async executePlan(
    input: string,
    plan: readonly string[],
    options: LLMInvokeOptions | undefined
  ): Promise<string[]> {
    const results: string[] = [];
    for (const step of plan)
      results.push(await this.executeStep(input, plan, results, step, options));
    this.lastStepResults = results;
    return results;
  }

  private executeStep(
    input: string,
    plan: readonly string[],
    results: readonly string[],
    step: string,
    options: LLMInvokeOptions | undefined
  ): Promise<string> {
    const history =
      results.length === 0
        ? '无'
        : results
            .map((result, index) => `步骤 ${index + 1}: ${plan[index]}\n结果: ${result}`)
            .join('\n\n');
    return this.respond(
      render(this.executorPrompt, {
        question: input,
        plan: plan.join('\n'),
        history,
        current_step: step
      }),
      options
    );
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

  private complete(input: string, result: string): string {
    this.history.push(new Message(input, 'user'), new Message(result, 'assistant'));
    return result;
  }
}

/** Compatibility alias for Python's `PlanAndSolveAgent` name. */
export { PlanSolveAgent as PlanAndSolveAgent };
