import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { AgentError, parseOrThrow } from '../core/errors.js';

const tracePayloadSchema = z.record(z.string(), z.unknown());
/** Validates a durable trace event written to JSONL and HTML outputs. */
export const traceEventSchema = z
  .object({
    ts: z.string().datetime({ offset: true }),
    session_id: z.string().min(1),
    step: z.number().int().nonnegative().nullable(),
    event: z.string().min(1),
    payload: tracePayloadSchema
  })
  .strict();
/** Serialized trace event. */
export type TraceEvent = z.output<typeof traceEventSchema>;

/** Aggregate metrics calculated from events logged in a trace session. */
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
  /** Directory where JSONL and HTML trace files are created. */
  readonly outputDir?: string;
  /** Redacts common credential values and local paths from logged payloads. */
  readonly sanitize?: boolean;
  /** Preserves raw provider responses when sanitization is enabled. */
  readonly includeRawResponse?: boolean;
  /** Optional stable session ID; a unique ID is generated otherwise. */
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

/** Dual JSONL/HTML audit trace that uses only Node/Bun-compatible async I/O. */
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

  /** Creates JSONL/HTML files and returns a logger for one trace session. */
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

  /** Appends a sanitized event to memory and the session JSONL file. */
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

  /** Flushes pending writes, renders the HTML report, and returns aggregate statistics. */
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

  /** Computes aggregate statistics from in-memory events without writing files. */
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

/** Creates common lifecycle-to-trace adapters bound to a logger. */
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

/** Runs an async operation and finalizes its trace whether it succeeds or fails. */
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
