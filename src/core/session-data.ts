import { z } from 'zod';
import { parseOrThrow } from './errors.js';
import { Message, messageSchema } from './message.js';
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
export type SessionDataJSON = z.output<typeof sessionDataSchema>;
export class SessionData {
  public constructor(private readonly value: SessionDataJSON) {}
  get sessionId() {
    return this.value.session_id;
  }
  get history() {
    return this.value.history.map((message) => Message.fromJSON(message));
  }
  public toJSON() {
    return this.value;
  }
}
export const parseSessionData = (input: unknown) =>
  new SessionData(parseOrThrow(sessionDataSchema, input, 'SessionData'));
