import type { AgentEvent, EventType } from './lifecycle.js';

/**
 * 流式输出缓冲区。
 *
 * 用于收集和管理流式事件，支持事件缓冲、背压控制和事件过滤。
 * 背压策略与 Python V1 一致：超过最大缓冲区大小时丢弃旧事件。
 */
export class StreamBuffer {
  private events: AgentEvent[] = [];

  public constructor(private readonly maxBufferSize = 100) {
    if (!Number.isSafeInteger(maxBufferSize) || maxBufferSize < 1) {
      throw new TypeError('maxBufferSize must be a positive integer');
    }
  }

  /** 添加事件；超过最大缓冲区大小时丢弃最旧事件。 */
  public add(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxBufferSize) this.events.shift();
  }
  /** 获取所有事件的副本，调用方修改副本不会影响缓冲区。 */
  public getAll(): readonly AgentEvent[] {
    return [...this.events];
  }
  /** 清空缓冲区。 */
  public clear(): void {
    this.events = [];
  }
  /** 按类型过滤缓冲区中的事件。 */
  public filterByType(type: EventType): readonly AgentEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}

function include(event: AgentEvent, types: readonly EventType[] | undefined): boolean {
  return types === undefined || types.includes(event.type);
}

/**
 * 将事件流转换为 SSE 格式。
 *
 * @param source 生命周期事件流。
 * @param includeTypes 要包含的事件类型；不传表示全部。
 * @yields SSE 格式的字符串。
 */
export async function* streamToSse(
  source: AsyncIterable<AgentEvent>,
  includeTypes?: readonly EventType[]
): AsyncIterable<string> {
  for await (const event of source) {
    if (!include(event, includeTypes)) continue;
    yield `event: ${event.type}\ndata: ${JSON.stringify(event.toJSON())}\n\n`;
  }
}

/**
 * 将事件流转换为 JSON Lines 格式。
 *
 * @param source 生命周期事件流。
 * @param includeTypes 要包含的事件类型；不传表示全部。
 * @yields JSON Lines 格式的字符串。
 */
export async function* streamToJsonLines(
  source: AsyncIterable<AgentEvent>,
  includeTypes?: readonly EventType[]
): AsyncIterable<string> {
  for await (const event of source) {
    if (include(event, includeTypes)) yield `${JSON.stringify(event.toJSON())}\n`;
  }
}
