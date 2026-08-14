import { z } from 'zod';
import { parseOrThrow } from './errors.js';

/** Roles accepted by the conversation and tool protocols. */
export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool', 'summary']);
/** Conversation role identifier. */
export type MessageRole = z.infer<typeof messageRoleSchema>;
const pythonIsoDateTimeSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), 'Expected an ISO 8601 datetime');
/** Validates the snake_case serialized message representation. */
export const messageSchema = z
  .object({
    role: messageRoleSchema,
    content: z.string(),
    timestamp: pythonIsoDateTimeSchema.nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).nullable().default({})
  })
  .strict();
/** JSON-compatible message shape used by sessions and lifecycle payloads. */
export type MessageJSON = z.output<typeof messageSchema>;

/** Immutable conversation message with Python-compatible serialization. */
export class Message {
  public readonly timestamp: Date | null;
  public readonly metadata: Record<string, unknown> | null;
  private readonly wireTimestamp: string | null;
  /** Creates a message; timestamps default to the current time. */
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
  /** Parses a serialized message and preserves its original wire timestamp. */
  public static fromJSON(input: unknown): Message {
    const value = parseOrThrow(messageSchema, input, 'Message');
    return new Message(value.content, value.role, {
      timestamp: value.timestamp === null ? null : new Date(value.timestamp),
      metadata: value.metadata,
      wireTimestamp: value.timestamp
    });
  }
  /** Serializes the message using snake_case field names. */
  public toJSON(): MessageJSON {
    return {
      role: this.role,
      content: this.content,
      timestamp: this.wireTimestamp ?? this.timestamp?.toISOString() ?? null,
      metadata: this.metadata
    };
  }
  /** Formats the message as `[role] content` for prompts and summaries. */
  public toText(): string {
    return `[${this.role}] ${this.content}`;
  }
  public toString(): string {
    return this.toText();
  }
}
