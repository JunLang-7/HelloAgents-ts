import type { AgentEvent, EventType } from './lifecycle.js';

/** Bounded event buffer. Backpressure policy matches Python V1: drop oldest. */
export class StreamBuffer {
  private events: AgentEvent[] = [];

  public constructor(private readonly maxBufferSize = 100) {
    if (!Number.isSafeInteger(maxBufferSize) || maxBufferSize < 1) {
      throw new TypeError('maxBufferSize must be a positive integer');
    }
  }

  /** Adds an event, dropping the oldest event when the bound is exceeded. */
  public add(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxBufferSize) this.events.shift();
  }
  /** Returns a snapshot that callers may mutate without changing the buffer. */
  public getAll(): readonly AgentEvent[] {
    return [...this.events];
  }
  /** Removes all buffered events. */
  public clear(): void {
    this.events = [];
  }
  /** Returns buffered events matching a lifecycle type. */
  public filterByType(type: EventType): readonly AgentEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}

function include(event: AgentEvent, types: readonly EventType[] | undefined): boolean {
  return types === undefined || types.includes(event.type);
}

/** Converts an event stream to Server-Sent Events records. */
export async function* streamToSse(
  source: AsyncIterable<AgentEvent>,
  includeTypes?: readonly EventType[]
): AsyncIterable<string> {
  for await (const event of source) {
    if (!include(event, includeTypes)) continue;
    yield `event: ${event.type}\ndata: ${JSON.stringify(event.toJSON())}\n\n`;
  }
}

/** Converts an event stream to newline-delimited JSON records. */
export async function* streamToJsonLines(
  source: AsyncIterable<AgentEvent>,
  includeTypes?: readonly EventType[]
): AsyncIterable<string> {
  for await (const event of source) {
    if (include(event, includeTypes)) yield `${JSON.stringify(event.toJSON())}\n`;
  }
}
