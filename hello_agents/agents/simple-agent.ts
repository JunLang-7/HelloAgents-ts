import type { LLMMessage } from '../adapters/base.js';
import { AgentEvent } from '../core/lifecycle.js';
import type { LifecycleHook } from '../core/lifecycle.js';
import { Message } from '../core/message.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ExpandableTool, Tool } from '../tools/tool.js';
import type { TraceLogger } from '../observability/trace-logger.js';

export interface SimpleAgentOptions {
  /** Agent 名称，用于历史记录和生命周期事件。 */
  readonly name: string;
  /** 用于生成回答和工具调用的 LLM 客户端。 */
  readonly llm: HelloAgentsLLM;
  /** 每次调用前追加的可选系统提示词。 */
  readonly systemPrompt?: string;
  /** 初始工具注册表；未提供时不启用工具调用。 */
  readonly toolRegistry?: ToolRegistry;
  /** 注册表中存在工具时是否启用原生 Function Calling。 */
  readonly enableToolCalling?: boolean;
  /** 模型工具调用的最大轮数，超出后回退到直接响应。 */
  readonly maxToolIterations?: number;
  /** 可选的会话 Trace；每次运行都会 finalize，包括发生异常时。 */
  readonly traceLogger?: TraceLogger;
}

export interface AgentLifecycleOptions {
  /** 运行开始前调用的回调。 */
  readonly onStart?: LifecycleHook;
  /** 运行成功后调用的回调。 */
  readonly onFinish?: LifecycleHook;
  /** 运行失败时调用的回调。 */
  readonly onError?: LifecycleHook;
  /** 每个回调的最大等待时间；超时和回调异常会被忽略。 */
  readonly hookTimeoutMs?: number;
}
/** `arun` 和 `arunStream` 使用的 LLM 选项及可选生命周期回调。 */
export interface AgentInvocationOptions extends LLMInvokeOptions {
  readonly lifecycle?: AgentLifecycleOptions;
}

async function invokeHook(
  hook: LifecycleHook | undefined,
  event: AgentEvent,
  timeoutMs: number
): Promise<void> {
  if (!hook) return;
  await Promise.race([
    Promise.resolve(hook(event)).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

/**
 * 简单的对话 Agent，支持可选的工具调用。
 *
 * 特性：
 * - 纯对话模式（无工具）
 * - Function Calling 工具调用（可选）
 * - 自动多轮工具调用
 */
export class SimpleAgent {
  public readonly name: string;
  public readonly llm: HelloAgentsLLM;
  public readonly systemPrompt: string | undefined;
  public readonly maxToolIterations: number;
  private toolRegistry: ToolRegistry | undefined;
  private enableToolCalling: boolean;
  private readonly traceLogger: TraceLogger | undefined;
  private history: Message[] = [];

  public constructor(options: SimpleAgentOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.systemPrompt = options.systemPrompt;
    this.toolRegistry = options.toolRegistry;
    this.traceLogger = options.traceLogger;
    this.enableToolCalling = (options.enableToolCalling ?? true) && this.toolRegistry !== undefined;
    this.maxToolIterations = options.maxToolIterations ?? 3;
  }

  /** 获取当前 Agent 保留的所有历史消息。 */
  public getHistory(): readonly Message[] {
    return [...this.history];
  }
  /** 清空历史消息。 */
  public clearHistory(): void {
    this.history = [];
  }

  /** 添加工具；必要时创建独立的工具注册表。 */
  public addTool(tool: Tool | ExpandableTool, autoExpand = true): void {
    this.toolRegistry ??= new ToolRegistry();
    this.toolRegistry.register(tool, autoExpand);
    this.enableToolCalling = true;
  }
  /** 按名称移除工具，并返回工具是否已注册。 */
  public removeTool(name: string): boolean {
    return this.toolRegistry?.unregister(name) ?? false;
  }
  /** 列出所有可用工具。 */
  public listTools(): string[] {
    return this.toolRegistry?.list() ?? [];
  }
  /** 检查当前 Agent 是否有可用工具。 */
  public hasTools(): boolean {
    return this.enableToolCalling && (this.toolRegistry?.list().length ?? 0) > 0;
  }

  /**
   * 运行 SimpleAgent（基于 Function Calling）。
   *
   * @param input 用户输入。
   * @param options LLM 调用选项。
   * @returns 最终回复。
   */
  public async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    const messages = this.buildMessages(input);
    await this.traceLogger?.logEvent('session_start', {
      agent_name: this.name,
      agent_type: 'SimpleAgent'
    });
    await this.traceLogger?.logEvent('message_written', { role: 'user', content: input });
    try {
      const answer =
        !this.hasTools() || !this.toolRegistry
          ? await this.runDirect(messages, options)
          : await this.runWithTools(messages, options);
      this.history.push(new Message(input, 'user'), new Message(answer, 'assistant'));
      await this.traceLogger?.logEvent('session_end', { status: 'success', final_answer: answer });
      return answer;
    } catch (error) {
      await this.traceLogger?.logEvent('error', {
        error_type: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error)
      });
      await this.traceLogger?.logEvent('session_end', { status: 'error' });
      throw error;
    } finally {
      await this.traceLogger?.finalize();
    }
  }

  /**
   * 流式运行 Agent。
   *
   * @param input 用户输入。
   * @param options LLM 调用选项。
   * @yields Agent 响应片段。
   */
  public async *stream(input: string, options?: LLMInvokeOptions): AsyncIterable<string> {
    const messages = this.buildMessages(input);
    let complete = '';
    for await (const chunk of this.llm.stream(messages, options)) {
      complete += chunk;
      yield chunk;
    }
    this.history.push(new Message(input, 'user'), new Message(complete, 'assistant'));
  }

  /** 运行一轮对话，并触发生命周期回调。 */
  public async arun(input: string, options: AgentInvocationOptions = {}): Promise<string> {
    const { lifecycle, ...llmOptions } = options;
    const timeoutMs = lifecycle?.hookTimeoutMs ?? 5_000;
    await invokeHook(
      lifecycle?.onStart,
      AgentEvent.create('agent_start', this.name, { input_text: input }),
      timeoutMs
    );
    try {
      const answer = await this.run(input, llmOptions);
      await invokeHook(
        lifecycle?.onFinish,
        AgentEvent.create('agent_finish', this.name, { result: answer }),
        timeoutMs
      );
      return answer;
    } catch (error) {
      await invokeHook(
        lifecycle?.onError,
        AgentEvent.create('agent_error', this.name, {
          error: error instanceof Error ? error.message : String(error)
        }),
        timeoutMs
      );
      throw error;
    }
  }

  /**
   * SimpleAgent 真正的流式执行，实时返回 LLM 输出的每个文本块。
   *
   * @param input 用户输入。
   * @param options LLM 选项和生命周期回调。
   * @yields 流式生命周期事件。
   */
  public async *arunStream(
    input: string,
    options: AgentInvocationOptions = {}
  ): AsyncIterable<AgentEvent> {
    const { lifecycle, ...llmOptions } = options;
    const timeoutMs = lifecycle?.hookTimeoutMs ?? 5_000;
    const started = AgentEvent.create('agent_start', this.name, { input_text: input });
    yield started;
    await invokeHook(lifecycle?.onStart, started, timeoutMs);
    try {
      for await (const chunk of this.stream(input, llmOptions)) {
        yield AgentEvent.create('llm_chunk', this.name, { chunk });
      }
      const result = this.history.at(-1)?.content ?? '';
      const finished = AgentEvent.create('agent_finish', this.name, { result });
      yield finished;
      await invokeHook(lifecycle?.onFinish, finished, timeoutMs);
    } catch (error) {
      const failed = AgentEvent.create('agent_error', this.name, {
        error: error instanceof Error ? error.message : String(error)
      });
      yield failed;
      await invokeHook(lifecycle?.onError, failed, timeoutMs);
      throw error;
    }
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
      await this.traceLogger?.logEvent(
        'model_output',
        {
          content: response.content,
          model: response.model,
          usage: response.usage,
          latency_ms: response.latencyMs,
          tool_calls: response.toolCalls.length
        },
        iteration + 1
      );
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
        await this.traceLogger?.logEvent(
          'tool_call',
          { tool_name: call.name, arguments: call.arguments },
          iteration + 1
        );
        const result = await registry.execute(call.name, call.arguments);
        await this.traceLogger?.logEvent(
          'tool_result',
          { tool_name: call.name, result: result.toJSON() },
          iteration + 1
        );
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
      }
    }
    return this.runDirect(messages, options);
  }

  private async runDirect(
    messages: LLMMessage[],
    options: LLMInvokeOptions | undefined
  ): Promise<string> {
    const response = await this.llm.invoke(messages, options);
    await this.traceLogger?.logEvent('model_output', {
      content: response.content,
      model: response.model,
      usage: response.usage,
      latency_ms: response.latencyMs
    });
    return response.content;
  }
}
