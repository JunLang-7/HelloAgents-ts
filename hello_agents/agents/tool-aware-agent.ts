import type { LLMInvokeOptions } from '../core/llm.js';
import { Message } from '../core/message.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ToolStatus } from '../tools/response.js';
import type { ParsedToolCall, SimpleAgentOptions } from './simple-agent.js';
import { SimpleAgent } from './simple-agent.js';

export interface ToolCallInfo {
  readonly agentName: string;
  readonly toolName: string;
  readonly rawParameters: string;
  readonly parsedParameters: Record<string, unknown>;
  readonly result: string;
}

export interface ToolAwareSimpleAgentOptions extends SimpleAgentOptions {
  readonly toolCallListener?: (call: ToolCallInfo) => void;
}

/** SimpleAgent with nested-marker parsing, parameter cleanup, and call observation. */
export class ToolAwareSimpleAgent extends SimpleAgent {
  private readonly toolCallListener: ((call: ToolCallInfo) => void) | undefined;

  public constructor(options: ToolAwareSimpleAgentOptions) {
    super(options);
    this.toolCallListener = options.toolCallListener;
  }

  protected override parseToolCalls(text: string): ParsedToolCall[] {
    const calls: ParsedToolCall[] = [];
    const marker = '[TOOL_CALL:';
    let start = 0;
    while (start < text.length) {
      const begin = text.indexOf(marker, start);
      if (begin < 0) break;
      const nameStart = begin + marker.length;
      const colon = text.indexOf(':', nameStart);
      if (colon < 0) break;
      const end = ToolAwareSimpleAgent.findToolCallEnd(text, begin);
      if (end < 0) break;
      calls.push({
        toolName: text.slice(nameStart, colon).trim(),
        parameters: text.slice(colon + 1, end).trim(),
        original: text.slice(begin, end + 1)
      });
      start = end + 1;
    }
    return calls;
  }

  protected override async executeToolCall(toolName: string, parameters: string): Promise<string> {
    // Upstream returns before notifying the listener when no registry/tool exists.
    if (!this.toolRegistry) return '❌ 错误：未配置工具注册表';
    if (!this.toolRegistry.getTool(toolName)) return `❌ 错误：未找到工具 '${toolName}'`;
    let parsed: Record<string, unknown> = {};
    let result: string;
    try {
      parsed = ToolAwareSimpleAgent.sanitizeParameters(
        this.parseToolParameters(toolName, parameters)
      );
      const response = await this.toolRegistry.execute(toolName, parsed);
      result =
        response.status === ToolStatus.ERROR
          ? this.describeToolFailure(response)
          : `🔧 工具 ${toolName} 执行结果：\n${response.text}`;
    } catch (error) {
      parsed = {};
      result = `❌ 工具调用失败：${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      this.toolCallListener?.({
        agentName: this.name,
        toolName,
        rawParameters: parameters,
        parsedParameters: parsed,
        result
      });
    } catch {
      // Listener failures must never change an agent answer.
    }
    return result;
  }

  /** Streaming variant filters marker text while executing calls between turns. */
  public override async *stream(input: string, options?: LLMInvokeOptions): AsyncIterable<string> {
    const messages = this.buildMessages(input, true);
    const emitted: string[] = [];
    let finalResponse = '';
    let iteration = 0;
    while (iteration < this.maxToolIterations) {
      let residual = '';
      const segments: string[] = [];
      const markerCalls: string[] = [];
      for await (const chunk of this.llm.stream(messages, options)) {
        residual += chunk;
        const processed = ToolAwareSimpleAgent.consumeStreamResidual(residual, false);
        residual = processed.residual;
        markerCalls.push(...processed.calls);
        for (const segment of processed.segments) {
          segments.push(segment);
          emitted.push(segment);
          yield segment;
        }
      }
      const processed = ToolAwareSimpleAgent.consumeStreamResidual(residual, true);
      markerCalls.push(...processed.calls);
      for (const segment of processed.segments) {
        segments.push(segment);
        emitted.push(segment);
        yield segment;
      }

      const calls = markerCalls.flatMap((marker) => this.parseToolCalls(marker));
      if (calls.length === 0) {
        finalResponse = segments.join('');
        break;
      }
      messages.push({ role: 'assistant', content: segments.join('') });
      const results: string[] = [];
      for (const call of calls)
        results.push(await this.executeToolCall(call.toolName, call.parameters));
      messages.push({
        role: 'user',
        content: `工具执行结果：\n${results.join('\n\n')}\n\n请基于这些结果给出完整的回答。`
      });
      iteration += 1;
    }
    if (iteration >= this.maxToolIterations && !finalResponse) {
      finalResponse = await this.llm.invoke(messages, options);
      emitted.push(finalResponse);
      yield finalResponse;
    }
    this.addMessage(new Message(input, 'user'));
    this.addMessage(new Message(finalResponse || emitted.join(''), 'assistant'));
  }

  public static attachRegistry(
    agent: ToolAwareSimpleAgent,
    registry: ToolRegistry | undefined
  ): void {
    if (!registry) return;
    agent.toolRegistry = registry;
    agent.enableToolCalling = true;
  }

  public static sanitizeParameters(parameters: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      // Model-supplied records must never carry prototype-tampering keys.
      if (SimpleAgent.isUnsafeKey(key)) continue;
      if (typeof value !== 'string') {
        sanitized[key] = value;
        continue;
      }
      const normalized = ToolAwareSimpleAgent.normalizeString(value);
      if (key === 'task_id') {
        const numeric = SimpleAgent.parseNumeric(normalized, true);
        if (numeric !== undefined) {
          sanitized[key] = numeric;
          continue;
        }
      }
      if (key === 'tags') {
        const sequence = ToolAwareSimpleAgent.coerceSequence(normalized);
        if (Array.isArray(sequence)) {
          sanitized[key] = sequence;
          continue;
        }
        if (normalized) {
          sanitized[key] = normalized
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
          continue;
        }
        // An empty normalized tags value falls through and stays empty (upstream).
      }
      sanitized[key] = normalized;
    }
    return sanitized;
  }

  private static findToolCallEnd(text: string, start: number): number {
    const colon = text.indexOf(':', start + '[TOOL_CALL:'.length);
    if (colon < 0) return -1;
    let depth = 0;
    let quote = '';
    for (let index = colon + 1; index < text.length; index += 1) {
      const character = text[index];
      if ((character === '"' || character === "'") && text[index - 1] !== '\\') {
        quote = quote === character ? '' : quote || character;
      } else if (!quote && character === '[') depth += 1;
      else if (!quote && character === ']') {
        if (depth === 0) return index;
        depth -= 1;
      }
    }
    return -1;
  }

  private static consumeStreamResidual(
    residual: string,
    finalPass: boolean
  ): { residual: string; segments: string[]; calls: string[] } {
    const marker = '[TOOL_CALL:';
    const segments: string[] = [];
    const calls: string[] = [];
    let remaining = residual;
    while (remaining) {
      const start = remaining.indexOf(marker);
      if (start < 0) {
        const safeLength = finalPass
          ? remaining.length
          : Math.max(0, remaining.length - marker.length + 1);
        if (safeLength) segments.push(remaining.slice(0, safeLength));
        remaining = remaining.slice(safeLength);
        break;
      }
      if (start > 0) {
        segments.push(remaining.slice(0, start));
        remaining = remaining.slice(start);
        continue;
      }
      const end = ToolAwareSimpleAgent.findToolCallEnd(remaining, 0);
      if (end < 0) break;
      calls.push(remaining.slice(0, end + 1));
      remaining = remaining.slice(end + 1);
    }
    return { residual: remaining, segments, calls };
  }

  private static normalizeString(value: string): string {
    let normalized = value.trim();
    const occurrences = (character: string): number =>
      [...normalized].filter((item) => item === character).length;
    const first = normalized[0] ?? '';
    const last = normalized.at(-1) ?? '';
    if (normalized && ['"', "'"].includes(first) && occurrences(first) === 1)
      normalized = normalized.slice(1);
    if (normalized && ['"', "'"].includes(last) && occurrences(last) === 1)
      normalized = normalized.slice(0, -1);
    const leading = normalized[0] ?? '';
    if (normalized && ['"', "'"].includes(leading) && normalized.at(-1) === leading)
      normalized = normalized.slice(1, -1);
    if (
      normalized &&
      ['[', '('].includes(normalized[0] ?? '') &&
      ![']', ')'].includes(normalized.at(-1) ?? '')
    )
      normalized += normalized[0] === '[' ? ']' : ')';
    return normalized.trim();
  }

  private static coerceSequence(value: string): unknown[] | undefined {
    if (!value) return undefined;
    const candidates = [
      value,
      value.startsWith('[') && !value.endsWith(']') ? `${value}]` : undefined,
      value.startsWith('(') && !value.endsWith(')') ? `${value})` : undefined
    ].filter((candidate): candidate is string => candidate !== undefined);
    for (const candidate of candidates) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Python's ast.literal_eval accepts single quotes; emulate the common list form only.
        if (/^\[.*\]$/.test(candidate)) {
          const items = candidate
            .slice(1, -1)
            .split(',')
            .map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
          if (items.every(Boolean)) return items;
        }
      }
    }
    return undefined;
  }
}
