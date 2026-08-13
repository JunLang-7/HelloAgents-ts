import type { AdapterConfig, AdapterRequest, AdapterToolRequest, BaseLLMAdapter } from './base.js';
import { LLMError } from '../core/errors.js';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type Usage = Record<string, number>;

export function endpoint(baseUrl: string, pathname: string): string {
  return new URL(pathname.replace(/^\//, ''), `${baseUrl.replace(/\/?$/, '/')}`).toString();
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function responseJson(response: Response, provider: string): Promise<unknown> {
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new LLMError(`${provider} returned invalid JSON`);
  }
  if (!response.ok)
    throw new LLMError(`${provider} request failed with HTTP ${response.status}`, body);
  return body;
}

export async function* sseEvents(response: Response, provider: string): AsyncIterable<unknown> {
  if (!response.body) throw new LLMError(`${provider} returned an empty stream`);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        throw new LLMError(`${provider} stream contained invalid JSON`);
      }
    }
  }
}

export abstract class FetchAdapter implements BaseLLMAdapter {
  public lastStats: unknown;

  public constructor(
    public readonly config: AdapterConfig,
    protected readonly fetchImpl: FetchLike = fetch
  ) {}

  protected async post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal })
      });
    } catch (error) {
      throw new LLMError('Provider network request failed', error);
    }
  }

  public abstract invoke(request: AdapterRequest): Promise<unknown>;
  public abstract stream(request: AdapterRequest): AsyncIterable<unknown>;
  public abstract invokeWithTools(request: AdapterToolRequest): Promise<unknown>;
}
