import type { LLMMessage } from '../adapters/base.js';
import { Agent } from '../core/agent.js';
import type { Config } from '../core/config.js';
import { AgentEvent } from '../core/lifecycle.js';
import type { LifecycleHook } from '../core/lifecycle.js';
import { Message } from '../core/message.js';
import type { HelloAgentsLLM, LLMInvokeOptions } from '../core/llm.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolResponse } from '../tools/response.js';
import { ToolStatus } from '../tools/response.js';
import type { ExpandableTool, Tool } from '../tools/tool.js';
import type { TraceLogger } from '../observability/trace-logger.js';

export interface SimpleAgentOptions {
  readonly name: string;
  readonly llm: HelloAgentsLLM;
  readonly systemPrompt?: string;
  readonly config?: Config;
  readonly toolRegistry?: ToolRegistry;
  readonly enableToolCalling?: boolean;
  readonly maxToolIterations?: number;
  /** Existing 1.x tracing support retained for the current TypeScript API. */
  readonly traceLogger?: TraceLogger;
}

export interface AgentLifecycleOptions {
  readonly onStart?: LifecycleHook;
  readonly onFinish?: LifecycleHook;
  readonly onError?: LifecycleHook;
  readonly hookTimeoutMs?: number;
}
export interface AgentInvocationOptions extends LLMInvokeOptions {
  readonly lifecycle?: AgentLifecycleOptions;
}

export interface ParsedToolCall {
  readonly toolName: string;
  readonly parameters: string;
  readonly original: string;
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
 * Text-marker tool calling agent from the teaching upstream.
 *
 * Models call tools by emitting `[TOOL_CALL:name:parameters]`; tool feedback is
 * supplied as the next user message. Native provider function calling belongs to
 * `FunctionCallAgent`.
 */
export class SimpleAgent extends Agent {
  public readonly maxToolIterations: number;
  protected toolRegistry: ToolRegistry | undefined;
  protected enableToolCalling: boolean;
  private readonly traceLogger: TraceLogger | undefined;

  public constructor(options: SimpleAgentOptions) {
    super(options.name, options.llm, options.systemPrompt, options.config);
    this.toolRegistry = options.toolRegistry;
    this.enableToolCalling =
      (options.enableToolCalling ?? true) && options.toolRegistry !== undefined;
    this.maxToolIterations = options.maxToolIterations ?? 3;
    this.traceLogger = options.traceLogger;
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
    // Upstream semantics: a registry (even an empty one) keeps tool calling enabled.
    return this.enableToolCalling && this.toolRegistry !== undefined;
  }

  /** Upstream's enhanced marker-calling prompt, including its default prompt. */
  protected getEnhancedSystemPrompt(): string {
    const basePrompt = this.systemPrompt ?? '你是一个有用的AI助手。';
    if (!this.enableToolCalling || !this.toolRegistry) return basePrompt;
    const toolsDescription = this.toolRegistry.getToolsDescription();
    if (!toolsDescription || toolsDescription === '暂无可用工具') return basePrompt;

    return `${basePrompt}\n\n## 可用工具\n你可以使用以下工具来帮助回答问题：\n${toolsDescription}\n\n## 工具调用格式\n当需要使用工具时，请使用以下格式：\n\`[TOOL_CALL:{tool_name}:{parameters}]\`\n\n### 参数格式说明\n1. **多个参数**：使用 \`key=value\` 格式，用逗号分隔\n   示例：\`[TOOL_CALL:calculator_multiply:a=12,b=8]\`\n   示例：\`[TOOL_CALL:filesystem_read_file:path=README.md]\`\n\n2. **单个参数**：直接使用 \`key=value\`\n   示例：\`[TOOL_CALL:search:query=Python编程]\`\n\n3. **简单查询**：可以直接传入文本\n   示例：\`[TOOL_CALL:search:Python编程]\`\n\n### 重要提示\n- 参数名必须与工具定义的参数名完全匹配\n- 数字参数直接写数字，不需要引号：\`a=12\` 而不是 \`a="12"\`\n- 文件路径等字符串参数直接写：\`path=README.md\`\n- 工具调用结果会自动插入到对话中，然后你可以基于结果继续回答\n`;
  }

  protected parseToolCalls(text: string): ParsedToolCall[] {
    const pattern = /\[TOOL_CALL:([^:]+):([^\]]+)\]/g;
    return [...text.matchAll(pattern)].map((match) => ({
      toolName: match[1]?.trim() ?? '',
      parameters: match[2]?.trim() ?? '',
      original: match[0]
    }));
  }

  protected parseToolParameters(toolName: string, parameters: string): Record<string, unknown> {
    const text = parameters.trim();
    if (text.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
          return this.convertParameterTypes(toolName, parsed as Record<string, unknown>);
      } catch {
        // Fall through to the upstream key=value parser.
      }
    }

    const values: Record<string, unknown> = {};
    if (text.includes('=')) {
      for (const pair of text.split(',')) {
        const separator = pair.indexOf('=');
        if (separator < 0) continue;
        values[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
      }
      return this.inferAction(toolName, this.convertParameterTypes(toolName, values));
    }
    return this.inferSimpleParameters(toolName, parameters);
  }

  protected convertParameterTypes(
    toolName: string,
    parameters: Record<string, unknown>
  ): Record<string, unknown> {
    const tool = this.toolRegistry?.getTool(toolName);
    if (!tool) return parameters;
    const types = new Map(
      tool.getParameters().map((parameter) => [parameter.name, parameter.type])
    );
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      // Model-supplied records must never carry prototype-tampering keys.
      if (SimpleAgent.isUnsafeKey(key)) continue;
      const type = types.get(key)?.toLowerCase();
      try {
        if (
          (type === 'number' || type === 'float' || type === 'integer' || type === 'int') &&
          typeof value === 'string'
        ) {
          const numeric = SimpleAgent.parseNumeric(value, type === 'integer' || type === 'int');
          converted[key] = numeric ?? value;
        } else if ((type === 'boolean' || type === 'bool') && typeof value === 'string') {
          converted[key] = ['true', '1', 'yes'].includes(value.toLowerCase());
        } else if (type === 'boolean' || type === 'bool') {
          converted[key] = Boolean(value);
        } else {
          converted[key] = value;
        }
      } catch {
        converted[key] = value;
      }
    }
    return converted;
  }

  /** Python-style numeric coercion: unparseable or fractional values stay original. */
  protected static parseNumeric(value: string, integer: boolean): number | undefined {
    const normalized = value.trim();
    if (normalized === '') return undefined;
    if (integer && !/^[+-]?\d+$/.test(normalized)) return undefined;
    const parsed = Number(normalized);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  /** Keys that must never be copied from hostile model JSON into tool records. */
  protected static isUnsafeKey(key: string): boolean {
    return key === '__proto__' || key === 'constructor' || key === 'prototype';
  }

  protected inferAction(
    toolName: string,
    parameters: Record<string, unknown>
  ): Record<string, unknown> {
    if ('action' in parameters) return parameters;
    if (toolName === 'memory') {
      if ('recall' in parameters) {
        parameters.action = 'search';
        parameters.query = parameters.recall;
        delete parameters.recall;
      } else if ('store' in parameters) {
        parameters.action = 'add';
        parameters.content = parameters.store;
        delete parameters.store;
      } else if ('query' in parameters) parameters.action = 'search';
      else if ('content' in parameters) parameters.action = 'add';
    } else if (toolName === 'rag') {
      if ('search' in parameters) {
        parameters.action = 'search';
        parameters.query = parameters.search;
        delete parameters.search;
      } else if ('query' in parameters) parameters.action = 'search';
      else if ('text' in parameters) parameters.action = 'add_text';
    }
    return parameters;
  }

  protected inferSimpleParameters(toolName: string, parameters: string): Record<string, unknown> {
    if (toolName === 'memory' || toolName === 'rag') return { action: 'search', query: parameters };
    return { input: parameters };
  }

  protected async executeToolCall(toolName: string, parameters: string): Promise<string> {
    if (!this.toolRegistry) return '❌ 错误：未配置工具注册表';
    try {
      if (!this.toolRegistry.getTool(toolName)) return `❌ 错误：未找到工具 '${toolName}'`;
      const result = await this.toolRegistry.execute(
        toolName,
        this.parseToolParameters(toolName, parameters)
      );
      return result.status === ToolStatus.ERROR
        ? this.describeToolFailure(result)
        : `🔧 工具 ${toolName} 执行结果：\n${result.text}`;
    } catch (error) {
      return `❌ 工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Upstream failure framing: only error-status registry responses are failures. */
  protected describeToolFailure(response: ToolResponse): string {
    const reason = response.errorInfo?.message ?? response.text;
    return `❌ 工具调用失败：${reason}`;
  }

  public override async run(input: string, options?: LLMInvokeOptions): Promise<string> {
    const messages = this.buildMessages(input, true);
    await this.traceLogger?.logEvent('session_start', {
      agent_name: this.name,
      agent_type: 'SimpleAgent'
    });
    await this.traceLogger?.logEvent('message_written', { role: 'user', content: input });
    try {
      let answer: string;
      if (!this.enableToolCalling) {
        answer = await this.runDirect(messages, options);
      } else {
        answer = await this.runMarkerLoop(messages, options);
      }
      this.addMessage(new Message(input, 'user'));
      this.addMessage(new Message(answer, 'assistant'));
      await this.traceLogger?.logEvent('session_end', { status: 'success', final_answer: answer });
      return answer;
    } catch (error) {
      await this.traceLogger?.logEvent('error', {
        message: error instanceof Error ? error.message : String(error)
      });
      await this.traceLogger?.logEvent('session_end', { status: 'error' });
      throw error;
    } finally {
      await this.traceLogger?.finalize();
    }
  }

  /** Plain streaming is intentionally direct, matching upstream SimpleAgent. */
  public async *stream(input: string, options?: LLMInvokeOptions): AsyncIterable<string> {
    const messages: LLMMessage[] = [
      ...(this.systemPrompt === undefined
        ? []
        : [{ role: 'system' as const, content: this.systemPrompt }]),
      ...this.getHistory().map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: input }
    ];
    let response = '';
    for await (const chunk of this.llm.stream(messages, options)) {
      response += chunk;
      yield chunk;
    }
    this.addMessage(new Message(input, 'user'));
    this.addMessage(new Message(response, 'assistant'));
  }

  public async arun(input: string, options: AgentInvocationOptions = {}): Promise<string> {
    const { lifecycle, ...llmOptions } = options;
    const timeout = lifecycle?.hookTimeoutMs ?? 5_000;
    await invokeHook(
      lifecycle?.onStart,
      AgentEvent.create('agent_start', this.name, { input_text: input }),
      timeout
    );
    try {
      const answer = await this.run(input, llmOptions);
      await invokeHook(
        lifecycle?.onFinish,
        AgentEvent.create('agent_finish', this.name, { result: answer }),
        timeout
      );
      return answer;
    } catch (error) {
      await invokeHook(
        lifecycle?.onError,
        AgentEvent.create('agent_error', this.name, { error: String(error) }),
        timeout
      );
      throw error;
    }
  }

  public async *arunStream(
    input: string,
    options: AgentInvocationOptions = {}
  ): AsyncIterable<AgentEvent> {
    const { lifecycle, ...llmOptions } = options;
    const timeout = lifecycle?.hookTimeoutMs ?? 5_000;
    const started = AgentEvent.create('agent_start', this.name, { input_text: input });
    yield started;
    await invokeHook(lifecycle?.onStart, started, timeout);
    try {
      for await (const chunk of this.stream(input, llmOptions))
        yield AgentEvent.create('llm_chunk', this.name, { chunk });
      const result = this.getHistory().at(-1)?.content ?? '';
      const finished = AgentEvent.create('agent_finish', this.name, { result });
      yield finished;
      await invokeHook(lifecycle?.onFinish, finished, timeout);
    } catch (error) {
      const failed = AgentEvent.create('agent_error', this.name, { error: String(error) });
      yield failed;
      await invokeHook(lifecycle?.onError, failed, timeout);
      throw error;
    }
  }

  protected buildMessages(input: string, enhanced: boolean): LLMMessage[] {
    return [
      {
        role: 'system',
        content: enhanced
          ? this.getEnhancedSystemPrompt()
          : (this.systemPrompt ?? '你是一个有用的AI助手。')
      },
      ...this.getHistory().map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: input }
    ];
  }

  private async runMarkerLoop(messages: LLMMessage[], options?: LLMInvokeOptions): Promise<string> {
    let iteration = 0;
    while (iteration < this.maxToolIterations) {
      const response = await this.runDirect(messages, options);
      const calls = this.parseToolCalls(response);
      if (calls.length === 0) return response;
      messages.push({ role: 'assistant', content: response });
      const results: string[] = [];
      for (const call of calls)
        results.push(await this.executeToolCall(call.toolName, call.parameters));
      messages.push({
        role: 'user',
        content: `工具执行结果：\n${results.join('\n\n')}\n\n请基于这些结果给出完整的回答。`
      });
      iteration += 1;
    }
    return this.runDirect(messages, options);
  }

  protected async runDirect(messages: LLMMessage[], options?: LLMInvokeOptions): Promise<string> {
    const response = await this.llm.invoke(messages, options);
    await this.traceLogger?.logEvent('model_output', { content: response, model: this.llm.model });
    return response;
  }
}
