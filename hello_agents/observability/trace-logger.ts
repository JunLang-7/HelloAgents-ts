import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { AgentError, parseOrThrow } from '../core/errors.js';

const tracePayloadSchema = z.record(z.string(), z.unknown());
/** 校验写入 JSONL 和 HTML 输出的持久 Trace 事件。 */
export const traceEventSchema = z
  .object({
    ts: z.string().datetime({ offset: true }),
    session_id: z.string().min(1),
    step: z.number().int().nonnegative().nullable(),
    event: z.string().min(1),
    payload: tracePayloadSchema
  })
  .strict();
/** 序列化的 Trace 事件。 */
export type TraceEvent = z.output<typeof traceEventSchema>;

/** 根据一个 Trace 会话中记录的事件计算出的聚合统计。 */
export interface TraceStats {
  readonly total_steps: number;
  readonly total_tokens: number;
  readonly total_cost: number;
  readonly tool_calls: Readonly<Record<string, number>>;
  readonly errors: readonly {
    readonly step: number | null;
    readonly type: unknown;
    readonly message: unknown;
  }[];
  readonly duration_seconds: number;
  readonly model_calls: number;
}

export interface TraceLoggerOptions {
  /** 创建 JSONL 和 HTML Trace 文件的目录。 */
  readonly outputDir?: string;
  /** 从记录的载荷中脱敏常见凭证值和本地路径。 */
  readonly sanitize?: boolean;
  /** 启用脱敏时是否保留原始提供商响应。 */
  readonly includeRawResponse?: boolean;
  /** 可选的稳定会话 ID；未提供时自动生成唯一 ID。 */
  readonly sessionId?: string;
}

function sessionId(): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `s-${stamp}-${randomBytes(2).toString('hex')}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function timestampMillis(value: string): number | undefined {
  const result = Date.parse(value);
  return Number.isNaN(result) ? undefined : result;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isSecretKey(key: string): boolean {
  return /(?:api[_-]?key|authorization|token|secret|password)/i.test(key);
}

function isRawResponseKey(key: string): boolean {
  return /(?:raw[_-]?response|raw_response)/i.test(key);
}

function redactString(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9_-]+/gi, 'Bearer ***')
    .replace(/(\/Users\/|\/home\/|C:\\Users\\)[^/\\]+/g, '$1***');
}

function sanitize(value: unknown, includeRawResponse: boolean, key?: string): unknown {
  if (key !== undefined && isSecretKey(key)) return '[REDACTED]';
  if (key !== undefined && isRawResponseKey(key) && !includeRawResponse) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, includeRawResponse));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, includeRawResponse, childKey)
      ])
    );
  }
  return value;
}

function htmlHeader(id: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Trace: ${escapeHtml(id)}</title><style>body{font-family:ui-monospace,monospace;background:#121417;color:#eceff4;padding:24px}.panel,.event{background:#1b2028;border:1px solid #2f3743;border-radius:8px;padding:16px;margin-bottom:12px}.event{white-space:pre-wrap;word-break:break-word}pre{margin:0}</style></head><body><div class="panel"><h1>Trace Session</h1><div>session_id: ${escapeHtml(id)}</div></div><div class="panel"><h2>Events</h2>`;
}

/**
 * 双格式 Trace Logger。
 *
 * 特性：
 * - JSONL 流式写入（实时追加）
 * - HTML 人类可读报告（包含统计面板）
 * - 敏感信息自动脱敏
 *
 * 输出 JSONL 和 HTML，使用 Node/Bun 兼容的异步 I/O。
 */
export class TraceLogger {
  public readonly outputDir: string;
  public readonly sanitize: boolean;
  public readonly includeRawResponse: boolean;
  public readonly sessionId: string;
  public readonly jsonlPath: string;
  public readonly htmlPath: string;
  private readonly events: TraceEvent[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private finalized = false;
  private finalizing: Promise<TraceStats> | undefined;

  private constructor(options: Required<TraceLoggerOptions>) {
    this.outputDir = options.outputDir;
    this.sanitize = options.sanitize;
    this.includeRawResponse = options.includeRawResponse;
    this.sessionId = options.sessionId;
    this.jsonlPath = join(options.outputDir, `trace-${this.sessionId}.jsonl`);
    this.htmlPath = join(options.outputDir, `trace-${this.sessionId}.html`);
  }

  /** 创建 JSONL/HTML 文件，并返回用于一个 Trace 会话的记录器。 */
  public static async create(options: TraceLoggerOptions = {}): Promise<TraceLogger> {
    const resolved: Required<TraceLoggerOptions> = {
      outputDir: options.outputDir ?? '.',
      sanitize: options.sanitize ?? true,
      includeRawResponse: options.includeRawResponse ?? false,
      sessionId: options.sessionId ?? sessionId()
    };
    await mkdir(resolved.outputDir, { recursive: true });
    const logger = new TraceLogger(resolved);
    await Promise.all([
      writeFile(logger.jsonlPath, '', 'utf8'),
      writeFile(logger.htmlPath, htmlHeader(logger.sessionId), 'utf8')
    ]);
    return logger;
  }

  /**
   * 将脱敏后的事件追加到内存和会话 JSONL 文件。
   *
   * @param event 事件名称。
   * @param payload 事件载荷。
   * @param step 可选的执行步骤。
   */
  public async logEvent(
    event: string,
    payload: Record<string, unknown> = {},
    step?: number
  ): Promise<void> {
    if (this.finalized || this.finalizing !== undefined) return;
    const candidate = {
      ts: new Date().toISOString(),
      session_id: this.sessionId,
      step: step ?? null,
      event,
      payload: this.sanitize ? sanitize(payload, this.includeRawResponse) : payload
    };
    const parsed = parseOrThrow(traceEventSchema, candidate, 'TraceEvent', AgentError);
    this.events.push(parsed);
    const line = `${JSON.stringify(parsed)}\n`;
    this.writeQueue = this.writeQueue.then(() => appendFile(this.jsonlPath, line, 'utf8'));
    await this.writeQueue;
  }

  /** 刷新待写入数据，生成 HTML 报告，并返回聚合统计。 */
  public async finalize(): Promise<TraceStats> {
    if (this.finalized) return this.computeStats();
    this.finalizing ??= this.finalizeInternal();
    return this.finalizing;
  }

  private async finalizeInternal(): Promise<TraceStats> {
    await this.writeQueue;
    const stats = this.computeStats();
    const events = this.events
      .map(
        (event) =>
          `<div class="event"><strong>${escapeHtml(event.event)}</strong><pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre></div>`
      )
      .join('');
    const footer = `<div class="panel"><h2>Stats</h2><pre>${escapeHtml(JSON.stringify(stats, null, 2))}</pre></div>${events}</div></body></html>`;
    await writeFile(this.htmlPath, `${htmlHeader(this.sessionId)}${footer}`, 'utf8');
    this.finalized = true;
    return stats;
  }

  /** 根据内存事件计算聚合统计，不写入文件。 */
  public computeStats(): TraceStats {
    let totalSteps = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let modelCalls = 0;
    const toolCalls: Record<string, number> = {};
    const errors: { step: number | null; type: unknown; message: unknown }[] = [];
    let start: number | undefined;
    let end: number | undefined;
    for (const trace of this.events) {
      if (trace.step !== null) totalSteps = Math.max(totalSteps, trace.step);
      const time = timestampMillis(trace.ts);
      if (trace.event === 'session_start') start = time;
      if (trace.event === 'session_end') end = time;
      if (trace.event === 'model_output') {
        modelCalls += 1;
        const usage = trace.payload.usage;
        if (usage !== null && typeof usage === 'object') {
          const fields = usage as Record<string, unknown>;
          totalTokens += numberValue(fields.total_tokens);
          totalCost += numberValue(fields.cost);
        }
      }
      if (trace.event === 'tool_call') {
        const name =
          typeof trace.payload.tool_name === 'string' ? trace.payload.tool_name : 'unknown';
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
      }
      if (trace.event === 'error') {
        errors.push({
          step: trace.step,
          type: trace.payload.error_type,
          message: trace.payload.message
        });
      }
    }
    return {
      total_steps: totalSteps,
      total_tokens: totalTokens,
      total_cost: totalCost,
      tool_calls: toolCalls,
      errors,
      duration_seconds:
        start === undefined || end === undefined ? 0 : Math.max(0, (end - start) / 1000),
      model_calls: modelCalls
    };
  }
}

/** 创建绑定到记录器的常用生命周期到 Trace 适配器。 */
export function createTraceHooks(logger: TraceLogger) {
  return {
    session: (payload: Record<string, unknown>, step?: number) =>
      logger.logEvent('session', payload, step),
    message: (payload: Record<string, unknown>, step?: number) =>
      logger.logEvent('message_written', payload, step),
    model: (payload: Record<string, unknown>, step?: number) =>
      logger.logEvent('model_output', payload, step),
    toolCall: (payload: Record<string, unknown>, step?: number) =>
      logger.logEvent('tool_call', payload, step),
    toolResult: (payload: Record<string, unknown>, step?: number) =>
      logger.logEvent('tool_result', payload, step),
    error: (payload: Record<string, unknown>, step?: number) =>
      logger.logEvent('error', payload, step)
  };
}

/** 运行异步操作；无论成功或失败都会 finalize Trace。 */
export async function withTraceFinalization<T>(
  logger: TraceLogger,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } finally {
    await logger.finalize();
  }
}
