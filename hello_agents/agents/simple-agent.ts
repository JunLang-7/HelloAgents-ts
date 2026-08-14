import type { LLMMessage } from '../adapters/base.js';
import { AgentEvent } from '../core/lifecycle.js';
import type { LifecycleHook } from '../core/lifecycle.js';
import { Message } from '../core/message.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ExpandableTool, Tool } from '../tools/tool.js';
import type { TraceLogger } from '../observability/trace-logger.js';

export interface SimpleAgentOptions {
  /** Stable agent name used in history and lifecycle events. */
  readonly name: string;
  /** LLM client used to produce answers and tool calls. */
  readonly llm: HelloAgentsLLM;
  /** Optional system instruction prepended to every invocation. */
  readonly systemPrompt?: string;
  /** Initial registry. Tool calling is disabled when no registry is available. */
  readonly toolRegistry?: ToolRegistry;
  /** Enables native function calling when a registry contains tools. */
  readonly enableToolCalling?: boolean;
  /** Maximum model tool-call rounds before falling back to a direct response. */
  readonly maxToolIterations?: number;
  /** Optional session trace; a run always finalizes it, including on errors. */
  readonly traceLogger?: TraceLogger;
}

export interface AgentLifecycleOptions {
  /** Callback invoked before a run begins. */
  readonly onStart?: LifecycleHook;
  /** Callback invoked after a successful run. */
  readonly onFinish?: LifecycleHook;
  /** Callback invoked when a run fails. */
  readonly onError?: LifecycleHook;
  /** Maximum wait for each callback; timed-out callback errors are ignored. */
  readonly hookTimeoutMs?: number;
}
/** LLM options plus optional lifecycle callbacks for `arun` and `arunStream`. */
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

/** Python V1 SimpleAgent: direct conversation or a bounded function-calling loop. */
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

  /** Returns a snapshot of messages retained by this agent. */
  public getHistory(): readonly Message[] {
    return [...this.history];
  }
  /** Clears messages retained by this agent. */
  public clearHistory(): void {
    this.history = [];
  }

  /** Adds a tool, creating an isolated registry when necessary. */
  public addTool(tool: Tool | ExpandableTool, autoExpand = true): void {
    this.toolRegistry ??= new ToolRegistry();
    this.toolRegistry.register(tool, autoExpand);
    this.enableToolCalling = true;
  }
  /** Removes a tool by name and returns whether it was registered. */
  public removeTool(name: string): boolean {
    return this.toolRegistry?.unregister(name) ?? false;
  }
  /** Lists available tool names. */
  public listTools(): string[] {
    return this.toolRegistry?.list() ?? [];
  }
  /** Reports whether this instance will use function calling. */
  public hasTools(): boolean {
    return this.enableToolCalling && (this.toolRegistry?.list().length ?? 0) > 0;
  }

  /** Runs one turn and appends the completed user/assistant exchange to history. */
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

  /** Streams one direct LLM turn and records the completed exchange after iteration. */
  public async *stream(input: string, options?: LLMInvokeOptions): AsyncIterable<string> {
    const messages = this.buildMessages(input);
    let complete = '';
    for await (const chunk of this.llm.stream(messages, options)) {
      complete += chunk;
      yield chunk;
    }
    this.history.push(new Message(input, 'user'), new Message(complete, 'assistant'));
  }

  /** Runs a turn while emitting bounded lifecycle callbacks. */
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

  /** Streams lifecycle events around a direct text stream. */
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
