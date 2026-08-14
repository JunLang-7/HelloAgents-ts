import { z } from 'zod';
import { parseOrThrow } from './errors.js';

/** 对话和工具协议接受的消息角色。 */
export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool', 'summary']);
/** 对话角色标识。 */
export type MessageRole = z.infer<typeof messageRoleSchema>;
const pythonIsoDateTimeSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), 'Expected an ISO 8601 datetime');
/** 校验 snake_case 序列化消息格式。 */
export const messageSchema = z
  .object({
    role: messageRoleSchema,
    content: z.string(),
    timestamp: pythonIsoDateTimeSchema.nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).nullable().default({})
  })
  .strict();
/** 会话和生命周期载荷使用的 JSON 兼容消息格式。 */
export type MessageJSON = z.output<typeof messageSchema>;

/** 支持 Python 兼容序列化的对话消息。 */
export class Message {
  public readonly timestamp: Date | null;
  public readonly metadata: Record<string, unknown> | null;
  private readonly wireTimestamp: string | null;
  /** 创建消息；时间戳默认为当前时间。 */
  public constructor(
    public readonly content: string,
    public readonly role: MessageRole,
    options: {
      timestamp?: Date | null;
      metadata?: Record<string, unknown> | null;
      wireTimestamp?: string | null;
    } = {}
  ) {
    this.timestamp = options.timestamp ?? new Date();
    this.metadata = options.metadata ?? {};
    this.wireTimestamp = options.wireTimestamp ?? null;
  }
  /** 解析序列化消息，并保留原始线格式时间戳。 */
  public static fromJSON(input: unknown): Message {
    const value = parseOrThrow(messageSchema, input, 'Message');
    return new Message(value.content, value.role, {
      timestamp: value.timestamp === null ? null : new Date(value.timestamp),
      metadata: value.metadata,
      wireTimestamp: value.timestamp
    });
  }
  /** 使用 snake_case 字段名序列化消息。 */
  public toJSON(): MessageJSON {
    return {
      role: this.role,
      content: this.content,
      timestamp: this.wireTimestamp ?? this.timestamp?.toISOString() ?? null,
      metadata: this.metadata
    };
  }
  /** 将消息格式化为 `[role] content`，用于上下文构建和摘要。 */
  public toText(): string {
    return `[${this.role}] ${this.content}`;
  }
  public toString(): string {
    return this.toText();
  }
}
