import type { LLMMessage } from '../adapters/base.js';
import { Message } from '../core/message.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ExpandableTool, Tool } from '../tools/tool.js';

export interface SimpleAgentOptions {
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly systemPrompt?: string;
  readonly toolRegistry?: ToolRegistry;
  readonly enableToolCalling?: boolean;
  readonly maxToolIterations?: number;
}

/** Python V1 SimpleAgent: direct conversation or a bounded function-calling loop. */
export class SimpleAgent {
  public readonly name: string;
  public readonly llm: HelloAgentsLLM;
  public readonly systemPrompt: string | undefined;
  public readonly maxToolIterations: number;
  private toolRegistry: ToolRegistry | undefined;
  private enableToolCalling: boolean;
  private history: Message[] = [];

  public constructor(options: SimpleAgentOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt;
    this.toolRegistry = options.toolRegistry;
    this.enableToolCalling = (options.enableToolCalling ?? true) && this.toolRegistry !== undefined;
    this.maxToolIterations = options.maxToolIterations ?? 3;
  }

  public getHistory(): readonly Message[] {
    return [...this.history];
  }
  public clearHistory(): void {
    this.history = [];
  }

  public addTool(tool: Tool | ExpandableTool, autoExpand = true): void {
    this.toolRegistry ??= new ToolRegistry();
    this.toolRegistry.register(tool, autoExpand);
    this.enableToolCalling = true;
  }
  public removeTool(name: string): boolean {
    return this.toolRegistry?.unregister(name) ?? false;
  }
  public listTools(): string[] {
    return this.toolRegistry?.list() ?? [];
  }
  public hasTools(): boolean {
    return this.enableToolCalling && (this.toolRegistry?.list().length ?? 0) > 0;
  }

  public async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    const messages = this.buildMessages(input);
    const answer =
      !this.hasTools() || !this.toolRegistry
        ? (await this.llm.invoke(messages, options)).content
        : await this.runWithTools(messages, options);
    this.history.push(new Message(input, 'user'), new Message(answer, 'assistant'));
    return answer;
  }

  public async *stream(input: string, options?: LLMInvokeOptions): AsyncIterable<string> {
    const messages = this.buildMessages(input);
    let complete = '';
    for await (const chunk of this.llm.stream(messages, options)) {
      complete += chunk;
      yield chunk;
    }
    this.history.push(new Message(input, 'user'), new Message(complete, 'assistant'));
  }

  private buildMessages(input: string): LLMMessage[] {
    return [
      ...(this.systemPrompt === undefined
        ? []
        : [{ role: 'system' as const, content: this.systemPrompt }]),
      ...this.history.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user' as const, content: input }
    ];
  }

  private async runWithTools(
    messages: LLMMessage[],
    options: LLMInvokeOptions | undefined
  ): Promise<string> {
    const registry = this.toolRegistry;
    if (!registry) throw new Error('Tool registry is required for tool calling');
    const schemas = registry.toOpenAISchemas() as unknown as Record<string, unknown>[];
    for (let iteration = 0; iteration < this.maxToolIterations; iteration += 1) {
      const response = await this.llm.invokeWithTools(messages, schemas, 'auto', options);
      if (response.toolCalls.length === 0) return response.content ?? '抱歉，我无法回答这个问题。';
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
        const result = await registry.execute(call.name, call.arguments);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
      }
    }
    return (await this.llm.invoke(messages, options)).content;
  }
}
