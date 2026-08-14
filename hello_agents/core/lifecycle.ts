import { z } from 'zod';
import { AgentError, parseOrThrow } from './errors.js';
/** Agent 和流式辅助函数发送的生命周期事件名称。 */
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
/** 生命周期事件名称。 */
export type EventType = z.infer<typeof eventTypeSchema>;
export const agentEventSchema = z
  .object({
    type: eventTypeSchema,
    timestamp: z.number().finite(),
    agent_name: z.string(),
    data: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
/** 序列化的生命周期事件格式。 */
export type AgentEventJSON = z.output<typeof agentEventSchema>;
/** 处理生命周期事件的异步回调。 */
export type LifecycleHook = (event: AgentEvent) => Promise<void>;
/** 生命周期事件，提供 JSON 序列化辅助方法。 */
export class AgentEvent {
  /** 包装已校验的序列化事件。 */
  public constructor(private readonly value: AgentEventJSON) {}
  /**
   * 为 Agent 创建带时间戳的事件。
   *
   * @param type 事件类型。
   * @param agentName Agent 名称。
   * @param data 事件数据。
   * @returns 新创建的 AgentEvent 实例。
   */
  public static create(type: EventType, agentName: string, data: Record<string, unknown> = {}) {
    return new AgentEvent({ type, agent_name: agentName, timestamp: Date.now() / 1000, data });
  }
  /**
   * 解析并校验序列化事件。
   *
   * @param input 序列化事件数据。
   * @returns 校验后的 AgentEvent 实例。
   */
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
  /** 使用 snake_case 字段序列化事件。 */
  public toJSON() {
    return this.value;
  }
  public toString() {
    return `[${this.type}] ${this.agentName} @ ${this.timestamp.toFixed(2)}: ${JSON.stringify(this.data)}`;
  }
}
/** 单次运行共享的可变计数器和元数据。 */
export class ExecutionContext {
  private currentStep = 0;
  private totalTokens = 0;
  private readonly metadata: Record<string, unknown> = {};
  public constructor(private readonly inputText: string) {}
  /** 增加当前执行步骤。 */
  public incrementStep() {
    this.currentStep += 1;
  }
  /** 将 token 使用量加入累计计数。 */
  public addTokens(tokens: number) {
    this.totalTokens += tokens;
  }
  /**
   * 按键保存任意运行元数据。
   *
   * @param key 元数据键。
   * @param value 元数据值。
   */
  public setMetadata(key: string, value: unknown) {
    this.metadata[key] = value;
  }
  /**
   * 读取运行元数据；不存在时返回默认值。
   *
   * @param key 元数据键。
   * @param defaultValue 不存在时返回的默认值。
   * @returns 元数据值或默认值。
   */
  public getMetadata<T = unknown>(key: string, defaultValue?: T): unknown | T {
    return this.metadata[key] ?? defaultValue;
  }
  /** 返回 Python 兼容的序列化执行状态。 */
  public toJSON() {
    return {
      input_text: this.inputText,
      current_step: this.currentStep,
      total_tokens: this.totalTokens,
      metadata: { ...this.metadata }
    };
  }
}
