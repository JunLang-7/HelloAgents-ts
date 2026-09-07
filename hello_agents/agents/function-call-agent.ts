import type { LLMMessage, ToolChoice } from '../adapters/base.js';
import { Message } from '../core/message.js';
import type { LLMInvokeOptions } from '../core/llm.js';
import type { ExpandableTool, Tool } from '../tools/tool.js';
import type { SimpleAgentOptions } from './simple-agent.js';
import { SimpleAgent } from './simple-agent.js';

export interface FunctionCallAgentOptions extends SimpleAgentOptions {
  /** OpenAI-compatible choice sent when the model may call a function. */
  readonly defaultToolChoice?: ToolChoice;
}

export interface FunctionCallRunOptions extends LLMInvokeOptions {
  readonly maxToolIterations?: number;
  readonly toolChoice?: ToolChoice;
}

function parseArguments(argumentsText: string): Record<string, unknown> {
  if (!argumentsText) return {};
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * OpenAI-native function calling variant of SimpleAgent.
 *
 * The provider adapter owns wire-format translation; this agent only builds the
 * teaching Tool schemas and maintains the assistant/tool message loop.
 */
export class FunctionCallAgent extends SimpleAgent {
  public readonly defaultToolChoice: ToolChoice;

  public constructor(options: FunctionCallAgentOptions) {
    super(options);
    this.defaultToolChoice = options.defaultToolChoice ?? 'auto';
  }

  public override async run(input: string, options: FunctionCallRunOptions = {}): Promise<string> {
    const { maxToolIterations, toolChoice, ...llmOptions } = options;
    const messages = this.buildFunctionMessages(input);
    // SAFETY: Tool schemas are JSON records by the ToolRegistry serialization contract.
    const schemas = (this.toolRegistry?.toOpenAISchemas() ?? []) as unknown as Record<
      string,
      unknown
    >[];
    if (!this.enableToolCalling || schemas.length === 0) {
      const response = await this.llm.invoke(messages, llmOptions);
      this.addMessage(new Message(input, 'user'));
      this.addMessage(new Message(response, 'assistant'));
      return response;
    }

    const limit = maxToolIterations ?? this.maxToolIterations;
    const choice = toolChoice ?? this.defaultToolChoice;
    let finalResponse = '';
    let iteration = 0;
    while (iteration < limit) {
      const response = await this.llm.invokeWithTools(messages, schemas, choice, llmOptions);
      if (response.toolCalls.length === 0) {
        finalResponse = response.content ?? '';
        messages.push({ role: 'assistant', content: finalResponse });
        break;
      }

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
        const result = await this.executeNativeToolCall(call.name, parseArguments(call.arguments));
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: result
        });
      }
      iteration += 1;
    }

    if (iteration >= limit && !finalResponse) {
      const response = await this.llm.invokeWithTools(messages, schemas, 'none', llmOptions);
      finalResponse = response.content ?? '';
      messages.push({ role: 'assistant', content: finalResponse });
    }
    this.addMessage(new Message(input, 'user'));
    this.addMessage(new Message(finalResponse, 'assistant'));
    return finalResponse;
  }

  /** Upstream function-call streaming is a one-item fallback to `run`. */
  public override async *stream(input: string, options?: LLMInvokeOptions): AsyncIterable<string> {
    yield await this.run(input, options);
  }

  /** Convenience signature retained for callers that add a tool after construction. */
  public override addTool(tool: Tool | ExpandableTool, autoExpand = true): void {
    super.addTool(tool, autoExpand);
  }

  private buildFunctionMessages(input: string): LLMMessage[] {
    const basePrompt = this.systemPrompt ?? '你是一个可靠的AI助理，能够在需要时调用工具完成任务。';
    const description = this.enableToolCalling
      ? this.toolRegistry?.getToolsDescription()
      : undefined;
    const prompt =
      !description || description === '暂无可用工具'
        ? basePrompt
        : `${basePrompt}\n\n## 可用工具\n当你判断需要外部信息或执行动作时，可以直接通过函数调用使用以下工具：\n${description}\n\n请主动决定是否调用工具，合理利用多次调用来获得完备答案。`;
    return [
      { role: 'system', content: prompt },
      ...this.getHistory().map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: input }
    ];
  }

  private async executeNativeToolCall(
    name: string,
    argumentsObject: Record<string, unknown>
  ): Promise<string> {
    if (!this.toolRegistry) return '❌ 错误：未配置工具注册表';
    const tool = this.toolRegistry.getTool(name);
    if (!tool) return `❌ 错误：未找到工具 '${name}'`;
    try {
      const typed = this.convertParameterTypes(name, argumentsObject);
      return (await this.toolRegistry.execute(name, typed)).text;
    } catch (error) {
      return `❌ 工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
