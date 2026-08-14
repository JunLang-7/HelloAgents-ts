import { z } from 'zod';

import { ToolError } from '../core/errors.js';
import { parseOrThrow } from '../core/errors.js';
import type { ToolErrorCode } from './errors.js';

/** 工具响应协议中的标准成功和错误状态。 */
export const ToolStatus = Object.freeze({
  SUCCESS: 'success',
  PARTIAL: 'partial',
  ERROR: 'error'
} as const);
/** 工具响应状态值。 */
export type ToolStatus = (typeof ToolStatus)[keyof typeof ToolStatus];

const recordSchema = z.record(z.string(), z.unknown());
const errorInfoSchema = z.object({ code: z.string(), message: z.string() }).strict();
/** 校验序列化的工具响应协议。 */
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

/** 失败工具响应携带的结构化错误载荷。 */
export type ToolErrorInfo = z.output<typeof errorInfoSchema>;
/** JSON 兼容的工具响应格式。 */
export type ToolResponseJSON = z.output<typeof toolResponseSchema>;

function nonEmpty(
  record: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return record && Object.keys(record).length > 0 ? record : undefined;
}

/**
 * 工具响应数据对象。
 *
 * 标准化的工具响应格式，包含：
 * - status：执行状态（success/partial/error）
 * - text：给 LLM 阅读的格式化文本
 * - data：结构化数据载荷
 * - errorInfo：错误信息（仅 status=error 时）
 * - stats：运行统计（时间、token 等）
 * - context：上下文信息（参数、环境等）
 */
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

  /** 将响应序列化，用于工具消息、日志或持久化。 */
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

  /**
   * 从 JSON 字符串创建并校验 ToolResponse。
   *
   * @param input JSON 字符串。
   * @returns 校验后的工具响应对象。
   */
  public static fromJSON(input: string): ToolResponse {
    let value: unknown;
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new ToolError('Invalid ToolResponse JSON', error);
    }
    return new ToolResponse(parseOrThrow(toolResponseSchema, value, 'ToolResponse', ToolError));
  }

  /**
   * 将 JSON 兼容对象校验为 ToolResponse。
   *
   * @param input JSON 兼容对象。
   * @returns 校验后的工具响应对象。
   */
  public static fromObject(input: unknown): ToolResponse {
    return new ToolResponse(parseOrThrow(toolResponseSchema, input, 'ToolResponse', ToolError));
  }

  /**
   * 快速创建成功响应，可附带统计和上下文信息。
   *
   * @param text 给 LLM 阅读的文本。
   * @param data 结构化数据。
   * @param stats 运行统计。
   * @param context 上下文信息。
   * @returns 成功状态的工具响应。
   */
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

  /**
   * 快速创建部分成功响应，并说明部分成功的原因。
   *
   * @param text 给 LLM 阅读的文本，应说明部分成功的原因。
   * @param data 结构化数据。
   * @param stats 运行统计。
   * @param context 上下文信息。
   * @returns 部分成功状态的工具响应。
   */
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

  /**
   * 使用标准错误码快速创建失败响应。
   *
   * @param code 标准错误码。
   * @param message 错误消息。
   * @param stats 运行统计。
   * @param context 上下文信息。
   * @returns 错误状态的工具响应。
   */
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
