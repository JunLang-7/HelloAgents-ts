import { z } from 'zod';
import { parseOrThrow } from './errors.js';
import { Message, messageSchema } from './message.js';
/** 校验 Python 兼容的序列化会话载荷。 */
export const sessionDataSchema = z
  .object({
    session_id: z.string().min(1),
    created_at: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), 'Expected an ISO 8601 datetime'),
    saved_at: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), 'Expected an ISO 8601 datetime'),
    agent_config: z.record(z.string(), z.unknown()),
    history: z.array(messageSchema),
    tool_schema_hash: z.string(),
    read_cache: z.record(z.string(), z.record(z.string(), z.unknown())),
    metadata: z.record(z.string(), z.unknown())
  })
  .strict();
/** `SessionStore` 持久化的 JSON 兼容会话格式。 */
export type SessionDataJSON = z.output<typeof sessionDataSchema>;
/** 校验后的持久化会话，提供消息重建能力。 */
export class SessionData {
  public constructor(private readonly value: SessionDataJSON) {}
  get sessionId() {
    return this.value.session_id;
  }
  get history() {
    return this.value.history.map((message) => Message.fromJSON(message));
  }
  /** 使用 snake_case 协议字段序列化会话。 */
  public toJSON() {
    return this.value;
  }
}
/** 校验未知持久化载荷并包装为会话数据。 */
export const parseSessionData = (input: unknown) =>
  new SessionData(parseOrThrow(sessionDataSchema, input, 'SessionData'));
