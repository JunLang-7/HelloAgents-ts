import { z } from 'zod';
import { parseOrThrow } from './errors.js';

export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool', 'summary']);
export type MessageRole = z.infer<typeof messageRoleSchema>;
const pythonIsoDateTimeSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), 'Expected an ISO 8601 datetime');
export const messageSchema = z
  .object({
    role: messageRoleSchema,
    content: z.string(),
    timestamp: pythonIsoDateTimeSchema.nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).nullable().default({})
  })
  .strict();
export type MessageJSON = z.output<typeof messageSchema>;

export class Message {
  public readonly timestamp: Date | null;
  public readonly metadata: Record<string, unknown> | null;
  private readonly wireTimestamp: string | null;
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
  public static fromJSON(input: unknown): Message {
    const value = parseOrThrow(messageSchema, input, 'Message');
    return new Message(value.content, value.role, {
      timestamp: value.timestamp === null ? null : new Date(value.timestamp),
      metadata: value.metadata,
      wireTimestamp: value.timestamp
    });
  }
  public toJSON(): MessageJSON {
    return {
      role: this.role,
      content: this.content,
      timestamp: this.wireTimestamp ?? this.timestamp?.toISOString() ?? null,
      metadata: this.metadata
    };
  }
  public toText(): string {
    return `[${this.role}] ${this.content}`;
  }
  public toString(): string {
    return this.toText();
  }
}
