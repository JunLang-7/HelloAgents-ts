import { Agent } from '../core/agent.js';
import type { Config } from '../core/config.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { Message } from '../core/message.js';

/** 上游 Planner 使用的默认提示词模板。 */
export const DEFAULT_PLANNER_PROMPT = `
你是一个顶级的AI规划专家。你的任务是将用户提出的复杂问题分解成一个由多个简单步骤组成的行动计划。
请确保计划中的每个步骤都是一个独立的、可执行的子任务，并且严格按照逻辑顺序排列。
你的输出必须是一个Python列表，其中每个元素都是一个描述子任务的字符串。

问题: {question}

请严格按照以下格式输出你的计划:
\`\`\`python
["步骤1", "步骤2", "步骤3", ...]
\`\`\`
`;

/** 上游 Executor 使用的默认提示词模板。 */
export const DEFAULT_EXECUTOR_PROMPT = `
你是一位顶级的AI执行专家。你的任务是严格按照给定的计划，一步步地解决问题。
你将收到原始问题、完整的计划、以及到目前为止已经完成的步骤和结果。
请你专注于解决"当前步骤"，并仅输出该步骤的最终答案，不要输出任何额外的解释或对话。

# 原始问题:
{question}

# 完整计划:
{plan}

# 历史步骤与结果:
{history}

# 当前步骤:
{current_step}

请仅输出针对"当前步骤"的回答:
`;

/** 计划响应无法按上游 ```python 列表格式解析时的最终答案。 */
export const INVALID_PLAN_ANSWER = '无法生成有效的行动计划，任务终止。';

export interface PlannerOptions {
  readonly llm: HelloAgentsLLM;
  readonly promptTemplate?: string;
}

export interface ExecutorOptions {
  readonly llm: HelloAgentsLLM;
  readonly promptTemplate?: string;
}

export interface PlanAndSolveAgentOptions {
  readonly name: string;
  readonly llm: Agent['llm'];
  readonly systemPrompt?: string;
  readonly config?: Config;
  readonly customPrompts?: { readonly planner?: string; readonly executor?: string };
}

/**
 * Safely parses the quoted-string list accepted by the upstream Planner's
 * `ast.literal_eval` path. The source only examines the content between an
 * exact ```python opener and its next closing fence.
 */
export function parsePlan(response: string): string[] {
  const pythonFence = '```python';
  const opener = response.indexOf(pythonFence);
  if (opener === -1) return [];
  const closer = response.indexOf('```', opener + pythonFence.length);
  if (closer === -1) return [];
  const source = response.slice(opener + pythonFence.length, closer).trim();
  if (!source.startsWith('[') || !source.endsWith(']')) return [];

  const steps: string[] = [];
  let index = 1;
  while (index < source.length - 1) {
    while (/\s|,/.test(source[index] ?? '')) index += 1;
    if (index >= source.length - 1) break;
    const quote = source[index];
    if (quote !== "'" && quote !== '"') return [];
    index += 1;

    let value = '';
    let closed = false;
    while (index < source.length - 1) {
      const character = source[index] ?? '';
      index += 1;
      if (character === '\\') {
        const escaped = source[index] ?? '';
        index += 1;
        value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
      } else if (character === quote) {
        closed = true;
        break;
      } else value += character;
    }
    if (!closed) return [];
    steps.push(value);

    while (/\s/.test(source[index] ?? '')) index += 1;
    if (source[index] === ',') index += 1;
    else if (index < source.length - 1) return [];
  }
  return steps;
}

/** 将复杂问题拆解为上游要求的 Python 字符串列表。 */
export class Planner {
  public readonly llmClient: HelloAgentsLLM;
  public readonly promptTemplate: string;

  public constructor(options: PlannerOptions | HelloAgentsLLM, promptTemplate?: string) {
    if (options instanceof Object && 'llm' in options) {
      this.llmClient = options.llm;
      this.promptTemplate = options.promptTemplate ?? DEFAULT_PLANNER_PROMPT;
    } else {
      this.llmClient = options;
      this.promptTemplate = promptTemplate ?? DEFAULT_PLANNER_PROMPT;
    }
  }

  public async plan(question: string, options?: LLMInvokeOptions): Promise<string[]> {
    const response =
      (await this.llmClient.invoke(
        [{ role: 'user', content: this.promptTemplate.replaceAll('{question}', question) }],
        options
      )) || '';
    return parsePlan(response);
  }
}

/** 按计划顺序执行每一个教学步骤。 */
export class Executor {
  public readonly llmClient: HelloAgentsLLM;
  public readonly promptTemplate: string;

  public constructor(options: ExecutorOptions | HelloAgentsLLM, promptTemplate?: string) {
    if (options instanceof Object && 'llm' in options) {
      this.llmClient = options.llm;
      this.promptTemplate = options.promptTemplate ?? DEFAULT_EXECUTOR_PROMPT;
    } else {
      this.llmClient = options;
      this.promptTemplate = promptTemplate ?? DEFAULT_EXECUTOR_PROMPT;
    }
  }

  public async execute(
    question: string,
    plan: readonly string[],
    options?: LLMInvokeOptions
  ): Promise<string> {
    let history = '';
    let finalAnswer = '';

    for (const [index, step] of plan.entries()) {
      const prompt = this.promptTemplate
        .replaceAll('{question}', question)
        .replaceAll('{plan}', formatPythonStringList(plan))
        .replaceAll('{history}', history || '无')
        .replaceAll('{current_step}', step);
      const response = await this.llmClient.invoke([{ role: 'user', content: prompt }], options);
      finalAnswer = response || '';
      history += `步骤 ${index + 1}: ${step}\n结果: ${finalAnswer}\n\n`;
    }
    return finalAnswer;
  }
}

/** 组合 Planner 和 Executor 的上游 Plan-and-Solve Agent。 */
export class PlanAndSolveAgent extends Agent {
  public readonly planner: Planner;
  public readonly executor: Executor;

  public constructor(options: PlanAndSolveAgentOptions) {
    super(options.name, options.llm, options.systemPrompt, options.config);
    this.planner = new Planner(options.llm, options.customPrompts?.planner);
    this.executor = new Executor(options.llm, options.customPrompts?.executor);
  }

  public override async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    const plan = await this.planner.plan(input, options);
    const finalAnswer = plan.length
      ? await this.executor.execute(input, plan, options)
      : INVALID_PLAN_ANSWER;
    this.addMessage(new Message(input, 'user'));
    this.addMessage(new Message(finalAnswer, 'assistant'));
    return finalAnswer;
  }
}

function formatPythonStringList(plan: readonly string[]): string {
  return `[${plan.map((step) => `'${step.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`).join(', ')}]`;
}
