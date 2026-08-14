import type { LLMMessage } from '../adapters/base.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { Message } from '../core/message.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ExpandableTool, Tool } from '../tools/tool.js';

const maxStepAnswer = '抱歉，我无法在限定步数内完成这个任务。';

export const DEFAULT_REACT_SYSTEM_PROMPT = `你是一个具备推理和行动能力的 AI 助手。

## 工作流程
你可以通过调用工具来完成任务：

1. **Thought 工具**：用于记录你的推理过程和分析
2. **业务工具**：用于获取信息或执行操作
3. **Finish 工具**：用于返回最终答案

## 重要提醒
- 主动使用 Thought 工具记录推理过程
- 可以多次调用工具获取信息
- 只有在确信有足够信息时才调用 Finish`;

export interface ReActAgentOptions {
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly toolRegistry?: ToolRegistry;
  readonly systemPrompt?: string;
  readonly maxSteps?: number;
}

export interface ReActSessionMetadata {
  readonly total_steps: number;
  readonly total_tokens: number;
}

const builtinSchemas: readonly Record<string, unknown>[] = [
  {
    type: 'function',
    function: {
      name: 'Thought',
      description: '分析问题，制定策略，记录推理过程。在需要思考时调用此工具。',
      parameters: {
        type: 'object',
        properties: { reasoning: { type: 'string', description: '你的推理过程和分析' } },
        required: ['reasoning']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'Finish',
      description: '当你有足够信息得出结论时，使用此工具返回最终答案。',
      parameters: {
        type: 'object',
        properties: { answer: { type: 'string', description: '最终答案' } },
        required: ['answer']
      }
    }
  }
];

function parseArguments(argumentsText: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(argumentsText);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Python V1 ReAct loop with native Function Calling rather than text parsing. */
export class ReActAgent {
  public readonly name: string;
  public readonly llm: HelloAgentsLLM;
  public readonly systemPrompt: string;
  public readonly maxSteps: number;
  public readonly toolRegistry: ToolRegistry;
  private history: Message[] = [];
  private metadata: ReActSessionMetadata = { total_steps: 0, total_tokens: 0 };

  public constructor(options: ReActAgentOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_REACT_SYSTEM_PROMPT;
    this.maxSteps = options.maxSteps ?? 5;
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
  }

  public get sessionMetadata(): ReActSessionMetadata {
    return this.metadata;
  }
  public getHistory(): readonly Message[] {
    return [...this.history];
  }
  public addTool(tool: Tool | ExpandableTool, autoExpand = true): void {
    this.toolRegistry.register(tool, autoExpand);
  }
  public removeTool(name: string): boolean {
    return this.toolRegistry.unregister(name);
  }
  public listTools(): string[] {
    return this.toolRegistry.list();
  }

  public async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    const messages: LLMMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: input }
    ];
    let totalTokens = 0;
    for (let step = 1; step <= this.maxSteps; step += 1) {
      const response = await this.llm.invokeWithTools(
        messages,
        [...builtinSchemas, ...this.toolRegistry.toOpenAISchemas()] as Record<string, unknown>[],
        'auto',
        options
      );
      totalTokens += response.usage.total_tokens ?? 0;
      this.metadata = { total_steps: step, total_tokens: totalTokens };
      if (response.toolCalls.length === 0)
        return this.complete(input, response.content ?? '抱歉，我无法回答这个问题。');

      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
      });
      const userCalls = response.toolCalls.filter(
        (call) => call.name !== 'Thought' && call.name !== 'Finish'
      );
      const userResults = new Map(
        await Promise.all(
          userCalls.map(
            async (call) =>
              [call.id, await this.toolRegistry.execute(call.name, call.arguments)] as const
          )
        )
      );
      for (const call of response.toolCalls) {
        if (call.name === 'Finish') {
          const answer = parseArguments(call.arguments).answer;
          return this.complete(input, typeof answer === 'string' ? answer : '');
        }
        if (call.name === 'Thought') {
          const reasoning = parseArguments(call.arguments).reasoning;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `推理: ${typeof reasoning === 'string' ? reasoning : ''}`
          });
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: userResults.get(call.id)?.text ?? `未找到名为 '${call.name}' 的工具`
          });
        }
      }
    }
    return this.complete(input, maxStepAnswer);
  }

  private complete(input: string, answer: string): string {
    this.history.push(new Message(input, 'user'), new Message(answer, 'assistant'));
    return answer;
  }
}
