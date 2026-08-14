import { z } from 'zod';

import { ToolError } from '../core/errors.js';
import { parseOrThrow } from '../core/errors.js';
import type { ToolErrorCode } from './errors.js';

export const ToolStatus = Object.freeze({
  SUCCESS: 'success',
  PARTIAL: 'partial',
  ERROR: 'error'
} as const);
export type ToolStatus = (typeof ToolStatus)[keyof typeof ToolStatus];

const recordSchema = z.record(z.string(), z.unknown());
const errorInfoSchema = z.object({ code: z.string(), message: z.string() }).strict();
export const toolResponseSchema = z
  .object({
    status: z.enum(['success', 'partial', 'error']).default(ToolStatus.SUCCESS),
    text: z.string().default(''),
    data: recordSchema.default({}),
    error: errorInfoSchema.optional(),
    stats: recordSchema.optional(),
    context: recordSchema.optional()
  })
  .strict();

export type ToolErrorInfo = z.output<typeof errorInfoSchema>;
export type ToolResponseJSON = z.output<typeof toolResponseSchema>;

function nonEmpty(
  record: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return record && Object.keys(record).length > 0 ? record : undefined;
}

/** A serializable, protocol-compatible tool result. */
export class ToolResponse {
  public readonly status: ToolStatus;
  public readonly text: string;
  public readonly data: Record<string, unknown>;
  public readonly errorInfo: ToolErrorInfo | undefined;
  public readonly stats: Record<string, unknown> | undefined;
  public readonly context: Record<string, unknown> | undefined;

  public constructor(value: ToolResponseJSON) {
    const parsed = parseOrThrow(toolResponseSchema, value, 'ToolResponse', ToolError);
    this.status = parsed.status;
    this.text = parsed.text;
    this.data = parsed.data;
    this.errorInfo = parsed.error;
    this.stats = parsed.stats;
    this.context = parsed.context;
  }

  public toJSON(): ToolResponseJSON {
    return {
      status: this.status,
      text: this.text,
      data: this.data,
      ...(this.errorInfo === undefined ? {} : { error: this.errorInfo }),
      ...(nonEmpty(this.stats) === undefined ? {} : { stats: this.stats }),
      ...(nonEmpty(this.context) === undefined ? {} : { context: this.context })
    };
  }

  public toString(): string {
    return this.text;
  }

  public static fromJSON(input: string): ToolResponse {
    let value: unknown;
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new ToolError('Invalid ToolResponse JSON', error);
    }
    return new ToolResponse(parseOrThrow(toolResponseSchema, value, 'ToolResponse', ToolError));
  }

  public static fromObject(input: unknown): ToolResponse {
    return new ToolResponse(parseOrThrow(toolResponseSchema, input, 'ToolResponse', ToolError));
  }

  public static success(
    text: string,
    data: Record<string, unknown> = {},
    stats?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): ToolResponse {
    return new ToolResponse({
      status: ToolStatus.SUCCESS,
      text,
      data,
      ...(stats ? { stats } : {}),
      ...(context ? { context } : {})
    });
  }

  public static partial(
    text: string,
    data: Record<string, unknown> = {},
    stats?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): ToolResponse {
    return new ToolResponse({
      status: ToolStatus.PARTIAL,
      text,
      data,
      ...(stats ? { stats } : {}),
      ...(context ? { context } : {})
    });
  }

  public static error(
    code: ToolErrorCode | string,
    message: string,
    stats?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): ToolResponse {
    return new ToolResponse({
      status: ToolStatus.ERROR,
      text: message,
      data: {},
      error: { code, message },
      ...(stats ? { stats } : {}),
      ...(context ? { context } : {})
    });
  }
}
