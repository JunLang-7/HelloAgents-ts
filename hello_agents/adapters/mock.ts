import type { AdapterRequest, AdapterToolRequest, BaseLLMAdapter } from './base.js';

export interface MockAdapterHandlers {
  readonly invoke?: (request: AdapterRequest) => unknown | Promise<unknown>;
  readonly stream?: (request: AdapterRequest) => AsyncIterable<unknown>;
  readonly invokeWithTools?: (request: AdapterToolRequest) => unknown | Promise<unknown>;
}

export class MockAdapter implements BaseLLMAdapter {
  public readonly requests: AdapterRequest[] = [];
  public readonly toolRequests: AdapterToolRequest[] = [];
  public lastStats: unknown;

  public constructor(private readonly handlers: MockAdapterHandlers = {}) {}

  public async invoke(request: AdapterRequest): Promise<unknown> {
    this.requests.push(request);
    return (
      this.handlers.invoke?.(request) ?? {
        content: '',
        model: 'mock-model',
        usage: {},
        latency_ms: 0
      }
    );
  }

  public async *stream(request: AdapterRequest): AsyncIterable<unknown> {
    this.requests.push(request);
    if (this.handlers.stream) {
      yield* this.handlers.stream(request);
    }
  }

  public async invokeWithTools(request: AdapterToolRequest): Promise<unknown> {
    this.toolRequests.push(request);
    return (
      this.handlers.invokeWithTools?.(request) ?? {
        content: null,
        tool_calls: [],
        model: 'mock-model',
        usage: {},
        latency_ms: 0
      }
    );
  }
}
