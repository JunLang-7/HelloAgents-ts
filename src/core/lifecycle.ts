import { z } from 'zod';
import { AgentError, parseOrThrow } from './errors.js';
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
export type EventType = z.infer<typeof eventTypeSchema>;
export const agentEventSchema = z
  .object({
    type: eventTypeSchema,
    timestamp: z.number().finite(),
    agent_name: z.string(),
    data: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type AgentEventJSON = z.output<typeof agentEventSchema>;
export type LifecycleHook = (event: AgentEvent) => Promise<void>;
export class AgentEvent {
  public constructor(private readonly value: AgentEventJSON) {}
  public static create(type: EventType, agentName: string, data: Record<string, unknown> = {}) {
    return new AgentEvent({ type, agent_name: agentName, timestamp: Date.now() / 1000, data });
  }
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
  public toJSON() {
    return this.value;
  }
  public toString() {
    return `[${this.type}] ${this.agentName} @ ${this.timestamp.toFixed(2)}: ${JSON.stringify(this.data)}`;
  }
}
export class ExecutionContext {
  private currentStep = 0;
  private totalTokens = 0;
  private readonly metadata: Record<string, unknown> = {};
  public constructor(private readonly inputText: string) {}
  public incrementStep() {
    this.currentStep += 1;
  }
  public addTokens(tokens: number) {
    this.totalTokens += tokens;
  }
  public setMetadata(key: string, value: unknown) {
    this.metadata[key] = value;
  }
  public getMetadata<T = unknown>(key: string, defaultValue?: T): unknown | T {
    return this.metadata[key] ?? defaultValue;
  }
  public toJSON() {
    return {
      input_text: this.inputText,
      current_step: this.currentStep,
      total_tokens: this.totalTokens,
      metadata: { ...this.metadata }
    };
  }
}
