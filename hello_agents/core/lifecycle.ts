import { z } from 'zod';
import { AgentError, parseOrThrow } from './errors.js';
/** Lifecycle event names emitted by agents and streaming helpers. */
export const eventTypeSchema = z.enum([
  'agent_start',
  'agent_finish',
  'agent_error',
  'step_start',
  'step_finish',
  'llm_start',
  'llm_chunk',
  'llm_finish',
  'tool_call',
  'tool_result',
  'tool_error',
  'thinking',
  'reflection',
  'plan'
]);
/** Lifecycle event name. */
export type EventType = z.infer<typeof eventTypeSchema>;
export const agentEventSchema = z
  .object({
    type: eventTypeSchema,
    timestamp: z.number().finite(),
    agent_name: z.string(),
    data: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
/** Serialized lifecycle event shape. */
export type AgentEventJSON = z.output<typeof agentEventSchema>;
/** Async callback invoked for a lifecycle event. */
export type LifecycleHook = (event: AgentEvent) => Promise<void>;
/** Immutable lifecycle event with JSON serialization helpers. */
export class AgentEvent {
  /** Wraps a validated serialized event. */
  public constructor(private readonly value: AgentEventJSON) {}
  /** Creates a timestamped event for an agent. */
  public static create(type: EventType, agentName: string, data: Record<string, unknown> = {}) {
    return new AgentEvent({ type, agent_name: agentName, timestamp: Date.now() / 1000, data });
  }
  /** Parses and validates a serialized event. */
  public static fromJSON(input: unknown) {
    return new AgentEvent(parseOrThrow(agentEventSchema, input, 'AgentEvent', AgentError));
  }
  get type() {
    return this.value.type;
  }
  get agentName() {
    return this.value.agent_name;
  }
  get timestamp() {
    return this.value.timestamp;
  }
  get data() {
    return this.value.data;
  }
  /** Serializes the event using snake_case fields. */
  public toJSON() {
    return this.value;
  }
  public toString() {
    return `[${this.type}] ${this.agentName} @ ${this.timestamp.toFixed(2)}: ${JSON.stringify(this.data)}`;
  }
}
/** Mutable per-run counters and metadata shared by execution hooks. */
export class ExecutionContext {
  private currentStep = 0;
  private totalTokens = 0;
  private readonly metadata: Record<string, unknown> = {};
  public constructor(private readonly inputText: string) {}
  /** Advances the current execution step. */
  public incrementStep() {
    this.currentStep += 1;
  }
  /** Adds token usage to the cumulative counter. */
  public addTokens(tokens: number) {
    this.totalTokens += tokens;
  }
  /** Stores arbitrary run metadata under a key. */
  public setMetadata(key: string, value: unknown) {
    this.metadata[key] = value;
  }
  /** Reads run metadata, returning the fallback when absent. */
  public getMetadata<T = unknown>(key: string, defaultValue?: T): unknown | T {
    return this.metadata[key] ?? defaultValue;
  }
  /** Returns the Python-compatible serialized execution state. */
  public toJSON() {
    return {
      input_text: this.inputText,
      current_step: this.currentStep,
      total_tokens: this.totalTokens,
      metadata: { ...this.metadata }
    };
  }
}
