import type { LLMInvokeOptions } from '../core/llm.js';
import { Agent } from '../core/agent.js';
import type { Config } from '../core/config.js';
import { Message } from '../core/message.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ExpandableTool, Tool } from '../tools/tool.js';

/** ReAct 教学范式使用的上游默认提示词模板。 */
export const DEFAULT_REACT_PROMPT = `你是一个具备推理和行动能力的AI助手。你可以通过思考分析问题，然后调用合适的工具来获取信息，最终给出准确的答案。

## 可用工具
{tools}

## 工作流程
请严格按照以下格式进行回应，每次只能执行一个步骤：

Thought: 分析问题，确定需要什么信息，制定研究策略。
Action: 选择合适的工具获取信息，格式为：
- \`{tool_name}[{tool_input}]\`：调用工具获取信息。
- \`Finish[研究结论]\`：当你有足够信息得出结论时。

## 重要提醒
1. 每次回应必须包含Thought和Action两部分
2. 工具调用的格式必须严格遵循：工具名[参数]
3. 只有当你确信有足够信息回答问题时，才使用Finish
4. 如果工具返回的信息不够，继续使用其他工具或相同工具的不同参数

## 当前任务
**Question:** {question}

## 执行历史
{history}

现在开始你的推理和行动：`;

export interface ReActAgentOptions {
  readonly name: string;
  readonly llm: Agent['llm'];
  readonly toolRegistry?: ToolRegistry;
  readonly systemPrompt?: string;
  readonly config?: Config;
  readonly maxSteps?: number;
  readonly customPrompt?: string;
}

/** 从一条 ReAct 响应中提取首个 Thought 和 Action 行。 */
export function parseReActOutput(text: string): [string | undefined, string | undefined] {
  const thought = /Thought: (.*)/.exec(text)?.[1]?.trim();
  const action = /Action: (.*)/.exec(text)?.[1]?.trim();
  return [thought, action];
}

/** 从 `工具名[参数]` 行中提取工具名和原始字符串参数。 */
export function parseReActAction(actionText: string): [string | undefined, string | undefined] {
  const match = /^(\w+)\[(.*)\]/.exec(actionText);
  return match === null ? [undefined, undefined] : [match[1], match[2]];
}

/** 提取包括 `Finish[...]` 在内的 Action 方括号内容。 */
export function parseReActActionInput(actionText: string): string {
  return /^\w+\[(.*)\]/.exec(actionText)?.[1] ?? '';
}

/**
 * ReAct（推理与行动）Agent。
 *
 * 该教学实现以文本 Thought/Action 格式驱动当前教学版工具注册表，而非 1.x
 * 的原生 Function Calling 循环。
 */
export class ReActAgent extends Agent {
  public readonly toolRegistry: ToolRegistry;
  public readonly maxSteps: number;
  public readonly promptTemplate: string;
  public currentHistory: string[] = [];

  public constructor(options: ReActAgentOptions) {
    super(options.name, options.llm, options.systemPrompt, options.config);
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.maxSteps = options.maxSteps ?? 5;
    this.promptTemplate = options.customPrompt ?? DEFAULT_REACT_PROMPT;
  }

  /** 注册当前教学工具或可展开工具组。 */
  public addTool(tool: Tool | ExpandableTool, autoExpand = true): void {
    this.toolRegistry.register(tool, autoExpand);
  }

  /** 按上游的 Thought/Action/Observation 循环处理任务。 */
  public override async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    this.currentHistory = [];
    let currentStep = 0;

    while (currentStep < this.maxSteps) {
      currentStep += 1;
      const prompt = this.renderPrompt(input);
      const responseText = await this.llm.invoke([{ role: 'user', content: prompt }], options);
      if (!responseText) break;

      const [, action] = parseReActOutput(responseText);
      if (!action) break;

      if (action.startsWith('Finish')) {
        const finalAnswer = parseReActActionInput(action);
        this.addMessage(new Message(input, 'user'));
        this.addMessage(new Message(finalAnswer, 'assistant'));
        return finalAnswer;
      }

      const [toolName, toolInput] = parseReActAction(action);
      if (!toolName || toolInput === undefined) {
        this.currentHistory.push('Observation: 无效的Action格式，请检查。');
        continue;
      }

      const observation = await this.toolRegistry.executeTool(toolName, toolInput);
      this.currentHistory.push(`Action: ${action}`);
      this.currentHistory.push(`Observation: ${observation.text}`);
    }

    const finalAnswer = '抱歉，我无法在限定步数内完成这个任务。';
    this.addMessage(new Message(input, 'user'));
    this.addMessage(new Message(finalAnswer, 'assistant'));
    return finalAnswer;
  }

  private renderPrompt(question: string): string {
    return this.promptTemplate
      .replaceAll('{tools}', this.toolRegistry.getToolsDescription())
      .replaceAll('{question}', question)
      .replaceAll('{history}', this.currentHistory.join('\n'));
  }
}
