import { z } from 'zod';
import { parseOrThrow } from './errors.js';
import { Message, messageSchema } from './message.js';
/** Validates the Python-compatible serialized session payload. */
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
/** JSON-compatible session content persisted by `SessionStore`. */
export type SessionDataJSON = z.output<typeof sessionDataSchema>;
/** Validated persisted session with convenient message reconstruction. */
export class SessionData {
  public constructor(private readonly value: SessionDataJSON) {}
  get sessionId() {
    return this.value.session_id;
  }
  get history() {
    return this.value.history.map((message) => Message.fromJSON(message));
  }
  /** Serializes the session using snake_case protocol fields. */
  public toJSON() {
    return this.value;
  }
}
/** Validates an unknown persisted payload and wraps it as session data. */
export const parseSessionData = (input: unknown) =>
  new SessionData(parseOrThrow(sessionDataSchema, input, 'SessionData'));
