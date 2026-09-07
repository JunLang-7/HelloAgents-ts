import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_MAX_RESULTS = 5;
export const SUPPORTED_RETURN_MODES = ['text', 'structured', 'json', 'dict'] as const;
export const SUPPORTED_BACKENDS = [
  'hybrid',
  'advanced',
  'tavily',
  'serpapi',
  'duckduckgo',
  'searxng',
  'perplexity'
] as const;
export type SearchBackend = (typeof SUPPORTED_BACKENDS)[number];
export type SearchResult = { title: string; url: string; content: string; raw_content?: string };
export interface SearchPayload {
  results: SearchResult[];
  backend: string;
  answer: string | null;
  notices: string[];
}
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}
export type SearchFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<FetchResponse>;
export interface SearchToolOptions {
  readonly backend?: SearchBackend;
  readonly tavilyKey?: string;
  readonly serpapiKey?: string;
  readonly perplexityKey?: string;
  readonly searxngUrl?: string;
  /** Explicitly opt into network transport. It is disabled by default. */
  readonly allowNetwork?: boolean;
  /** Injectable transport for deterministic tests and controlled deployments. */
  readonly fetch?: SearchFetch;
  /** Injectable environment; defaults to process.env. */
  readonly env?: Record<string, string | undefined>;
}

const inputSchema = z
  .object({
    input: z.string().optional(),
    query: z.string().optional(),
    backend: z.string().optional(),
    mode: z.string().optional(),
    return_mode: z.string().optional(),
    fetch_full_page: z.boolean().optional(),
    max_results: z.number().int().positive().optional(),
    max_tokens_per_source: z.number().int().positive().optional(),
    loop_count: z.number().int().nonnegative().optional()
  })
  .strict();

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function limit(text: string, tokens: number): string {
  const max = tokens * CHARS_PER_TOKEN;
  return text.length <= max ? text : `${text.slice(0, max)}... [truncated]`;
}
function result(title: string, url: string, content: string, raw?: string): SearchResult {
  return raw === undefined
    ? { title: title || url, url, content }
    : { title: title || url, url, content, raw_content: raw };
}
function emptyPayload(backend: string, notice: string): SearchPayload {
  return { results: [], backend, answer: null, notices: [notice] };
}

/** Opt-in HTTP implementations of the upstream search backends. */
export class SearchTool extends Tool<typeof inputSchema> {
  public static readonly inputSchema = inputSchema;
  private readonly options: SearchToolOptions;
  public readonly backend: SearchBackend;
  private readonly tavilyKey: string | undefined;
  private readonly serpapiKey: string | undefined;
  private readonly perplexityKey: string | undefined;

  public constructor(options: SearchToolOptions = {}) {
    super({
      name: 'search',
      description:
        '智能网页搜索引擎，支持 Tavily、SerpApi、DuckDuckGo、SearXNG、Perplexity 等后端，可返回结构化或文本化的搜索结果。',
      inputSchema,
      parameters: [{ name: 'input', type: 'string', description: '搜索查询关键词', required: true }]
    });
    this.options = options;
    this.backend = options.backend ?? 'hybrid';
    const env = options.env ?? process.env;
    this.tavilyKey = options.tavilyKey ?? env.TAVILY_API_KEY;
    this.serpapiKey = options.serpapiKey ?? env.SERPAPI_API_KEY;
    this.perplexityKey = options.perplexityKey ?? env.PERPLEXITY_API_KEY;
  }

  protected async run(input: z.output<typeof inputSchema>): Promise<ToolResponse> {
    const query = (input.input ?? input.query ?? '').trim();
    if (!query) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：搜索查询不能为空');
    const requested = (input.backend ?? this.backend).toLowerCase();
    const backend = SUPPORTED_BACKENDS.includes(requested as SearchBackend)
      ? (requested as SearchBackend)
      : 'hybrid';
    const mode = (input.mode ?? input.return_mode ?? 'text').toLowerCase();
    try {
      const payload = await this.search(
        query,
        backend,
        input.max_results ?? DEFAULT_MAX_RESULTS,
        input.fetch_full_page ?? false,
        input.max_tokens_per_source ?? 2000,
        input.loop_count ?? 0
      );
      const data: Record<string, unknown> = {
        results: payload.results,
        backend: payload.backend,
        answer: payload.answer,
        notices: payload.notices
      };
      return ToolResponse.success(
        ['structured', 'json', 'dict'].includes(mode)
          ? JSON.stringify(payload)
          : this.formatText(query, payload),
        data
      );
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.API_ERROR,
        `搜索失败: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { query, backend }
      );
    }
  }

  private transport(): SearchFetch | undefined {
    if (!this.options.allowNetwork) return undefined;
    if (this.options.fetch) return this.options.fetch;
    return typeof globalThis.fetch === 'function'
      ? (url, init) => globalThis.fetch(url, init)
      : undefined;
  }
  private async request(
    backend: string,
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ): Promise<Record<string, unknown>> {
    const fetch = this.transport();
    if (!fetch)
      throw new Error(
        `${backend} 网络搜索未启用；请显式设置 allowNetwork 并提供 fetch transport。`
      );
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${backend} 请求失败 (HTTP ${response.status})`);
    return record(await response.json());
  }
  private async search(
    query: string,
    backend: SearchBackend,
    max: number,
    full: boolean,
    tokens: number,
    loop: number
  ): Promise<SearchPayload> {
    if (!this.options.allowNetwork)
      return emptyPayload(
        backend,
        '网络搜索未启用；请显式设置 allowNetwork 并提供 fetch transport。'
      );
    switch (backend) {
      case 'tavily':
        return this.tavily(query, max, full, tokens);
      case 'serpapi':
        return this.serpapi(query, max, full, tokens);
      case 'duckduckgo':
        return this.duckduckgo(query, max, full, tokens);
      case 'searxng':
        return this.searxng(query, max, full, tokens);
      case 'perplexity':
        return this.perplexity(query, max, full, tokens, loop);
      case 'advanced':
      case 'hybrid':
        return this.advanced(query, max, full, tokens);
    }
  }
  private async tavily(
    query: string,
    max: number,
    full: boolean,
    tokens: number
  ): Promise<SearchPayload> {
    if (!this.tavilyKey) throw new Error('TAVILY_API_KEY 未配置，无法使用 Tavily 搜索');
    const payload = await this.request('tavily', 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: this.tavilyKey,
        query,
        max_results: max,
        include_raw_content: full
      })
    });
    const results = (Array.isArray(payload.results) ? payload.results : [])
      .slice(0, max)
      .map((entry) => {
        const item = record(entry);
        const content = string(item.content);
        const raw = full ? limit(string(item.raw_content) || content, tokens) : undefined;
        return result(string(item.title), string(item.url), content, raw);
      });
    return { results, backend: 'tavily', answer: string(payload.answer) || null, notices: [] };
  }
  private async serpapi(
    query: string,
    max: number,
    full: boolean,
    tokens: number
  ): Promise<SearchPayload> {
    if (!this.serpapiKey) throw new Error('SERPAPI_API_KEY 未配置，无法使用 SerpApi 搜索');
    const url = new URL('https://serpapi.com/search.json');
    url.search = new URLSearchParams({
      engine: 'google',
      q: query,
      api_key: this.serpapiKey,
      gl: 'cn',
      hl: 'zh-cn',
      num: String(max)
    }).toString();
    const payload = await this.request('serpapi', url.toString());
    const box = record(payload.answer_box);
    const results = (Array.isArray(payload.organic_results) ? payload.organic_results : [])
      .slice(0, max)
      .map((entry) => {
        const item = record(entry);
        const content = string(item.snippet);
        return result(
          string(item.title),
          string(item.link),
          content,
          full ? limit(content, tokens) : undefined
        );
      });
    return {
      results,
      backend: 'serpapi',
      answer: string(box.answer) || string(box.snippet) || null,
      notices: []
    };
  }
  private async duckduckgo(
    query: string,
    max: number,
    full: boolean,
    tokens: number
  ): Promise<SearchPayload> {
    const url = new URL('https://api.duckduckgo.com/');
    url.search = new URLSearchParams({ q: query, format: 'json', no_html: '1' }).toString();
    const payload = await this.request('duckduckgo', url.toString());
    const entries = [
      record(payload.AbstractURL).url
        ? { FirstURL: payload.AbstractURL, Text: payload.AbstractText }
        : undefined,
      ...(Array.isArray(payload.RelatedTopics) ? payload.RelatedTopics : [])
    ].filter(Boolean);
    const flattened = entries.flatMap((entry) => {
      const item = record(entry);
      return Array.isArray(item.Topics) ? item.Topics : [item];
    });
    const results = flattened
      .slice(0, max)
      .map((entry) => {
        const item = record(entry);
        const content = string(item.Text);
        const url = string(item.FirstURL);
        return result(
          content.split(' - ')[0] || url,
          url,
          content,
          full ? limit(content, tokens) : undefined
        );
      })
      .filter((entry) => entry.url);
    return {
      results,
      backend: 'duckduckgo',
      answer: string(payload.AbstractText) || null,
      notices: []
    };
  }
  private async searxng(
    query: string,
    max: number,
    full: boolean,
    tokens: number
  ): Promise<SearchPayload> {
    const host = (
      this.options.searxngUrl ??
      (this.options.env ?? process.env).SEARXNG_URL ??
      'http://localhost:8888'
    ).replace(/\/$/, '');
    const url = new URL(`${host}/search`);
    url.search = new URLSearchParams({
      q: query,
      format: 'json',
      language: 'zh-CN',
      safesearch: '1',
      categories: 'general'
    }).toString();
    const payload = await this.request('searxng', url.toString());
    const results = (Array.isArray(payload.results) ? payload.results : [])
      .slice(0, max)
      .map((entry) => {
        const item = record(entry);
        const content = string(item.content) || string(item.snippet);
        return result(
          string(item.title),
          string(item.url) || string(item.link),
          content,
          full ? limit(content, tokens) : undefined
        );
      })
      .filter((entry) => entry.url);
    return { results, backend: 'searxng', answer: null, notices: [] };
  }
  private async perplexity(
    query: string,
    max: number,
    full: boolean,
    tokens: number,
    loop: number
  ): Promise<SearchPayload> {
    if (!this.perplexityKey) throw new Error('PERPLEXITY_API_KEY 未配置，无法使用 Perplexity 搜索');
    const payload = await this.request('perplexity', 'https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        Authorization: `Bearer ${this.perplexityKey}`
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [
          {
            role: 'system',
            content: 'Search the web and provide factual information with sources.'
          },
          { role: 'user', content: query }
        ]
      })
    });
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const content = string(record(record(choices[0]).message).content);
    const citations = Array.isArray(payload.citations)
      ? payload.citations.filter((url): url is string => typeof url === 'string')
      : ['https://perplexity.ai'];
    return {
      results: citations
        .slice(0, max)
        .map((url, index) =>
          result(
            `Perplexity Source ${loop + 1}-${index + 1}`,
            url,
            index === 0 ? content : 'See main Perplexity response above.',
            full && index === 0 ? limit(content, tokens) : undefined
          )
        ),
      backend: 'perplexity',
      answer: content || null,
      notices: []
    };
  }
  private async advanced(
    query: string,
    max: number,
    full: boolean,
    tokens: number
  ): Promise<SearchPayload> {
    const notices: string[] = [];
    for (const backend of ['tavily', 'serpapi', 'duckduckgo'] as const) {
      try {
        const payload =
          backend === 'tavily'
            ? await this.tavily(query, max, full, tokens)
            : backend === 'serpapi'
              ? await this.serpapi(query, max, full, tokens)
              : await this.duckduckgo(query, max, full, tokens);
        if (payload.results.length)
          return { ...payload, notices: [...notices, ...payload.notices] };
        notices.push(`⚠️ ${backend} 未返回有效结果`);
      } catch (error) {
        notices.push(
          `⚠️ ${backend} 搜索失败：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return { ...emptyPayload('advanced', ''), notices };
  }
  private formatText(query: string, payload: SearchPayload): string {
    const lines = [`🔍 搜索关键词：${query}`, `🧭 使用搜索源：${payload.backend}`];
    if (payload.answer) lines.push(`💡 直接答案：${payload.answer}`);
    if (payload.results.length) {
      lines.push('', '📚 参考来源：');
      payload.results.forEach((item, index) => {
        lines.push(`[${index + 1}] ${item.title || item.url}`);
        if (item.content) lines.push(`    ${item.content}`);
        if (item.url) lines.push(`    来源: ${item.url}`);
        lines.push('');
      });
    } else lines.push('❌ 未找到相关搜索结果。');
    if (payload.notices.filter(Boolean).length)
      lines.push(
        '⚠️ 注意事项：',
        ...payload.notices.filter(Boolean).map((notice) => `- ${notice}`)
      );
    return lines.join('\n');
  }
}

/** String-only helpers mirror upstream direct calls; structured ToolResponse stays inside Tool.execute. */
export const search = async (query: string, backend: SearchBackend = 'hybrid'): Promise<string> =>
  (await new SearchTool({ backend }).execute({ input: query, backend })).text;
export const searchTavily = (query: string): Promise<string> => search(query, 'tavily');
export const searchSerpapi = (query: string): Promise<string> => search(query, 'serpapi');
export const searchHybrid = (query: string): Promise<string> => search(query, 'hybrid');
export const search_tavily = searchTavily;
export const search_serpapi = searchSerpapi;
export const search_hybrid = searchHybrid;
