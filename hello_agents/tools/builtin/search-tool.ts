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
export interface SearchToolOptions {
  readonly backend?: SearchBackend;
  readonly tavilyKey?: string;
  readonly serpapiKey?: string;
  readonly perplexityKey?: string;
  /** Network access is disabled unless explicitly enabled. */
  readonly allowNetwork?: boolean;
  readonly tavilySearch?: (
    query: string,
    maxResults: number
  ) => Promise<SearchPayload> | SearchPayload;
  readonly serpapiSearch?: (
    query: string,
    maxResults: number
  ) => Promise<SearchPayload> | SearchPayload;
  readonly duckduckgoSearch?: (
    query: string,
    maxResults: number
  ) => Promise<SearchPayload> | SearchPayload;
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

function emptyPayload(backend: string, notice: string): SearchPayload {
  return { results: [], backend, answer: null, notices: [notice] };
}
/** 多后端网页搜索工具；网络后端必须通过 `allowNetwork` 或 mock 显式启用。 */
export class SearchTool extends Tool<typeof inputSchema> {
  public static readonly inputSchema = inputSchema;
  private readonly options: SearchToolOptions;
  public readonly backend: SearchBackend;

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
  }

  protected async run(input: z.output<typeof inputSchema>): Promise<ToolResponse> {
    const query = (input.input ?? input.query ?? '').trim();
    if (!query) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '错误：搜索查询不能为空');
    const backend = SUPPORTED_BACKENDS.includes((input.backend ?? this.backend) as SearchBackend)
      ? ((input.backend ?? this.backend) as SearchBackend)
      : 'hybrid';
    const mode = (input.mode ?? input.return_mode ?? 'text').toLowerCase();
    const maxResults = input.max_results ?? DEFAULT_MAX_RESULTS;
    try {
      const payload = await this.search(query, backend, maxResults);
      const data: Record<string, unknown> = {
        results: payload.results,
        backend: payload.backend,
        answer: payload.answer,
        notices: payload.notices
      };
      if (mode === 'structured' || mode === 'json' || mode === 'dict') {
        return ToolResponse.success(JSON.stringify(payload), data);
      }
      return ToolResponse.success(this.formatText(query, payload), data);
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.API_ERROR,
        `搜索失败: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { query, backend }
      );
    }
  }

  private async search(
    query: string,
    backend: SearchBackend,
    maxResults: number
  ): Promise<SearchPayload> {
    const options = this.options;
    if (backend === 'tavily' && options.tavilySearch)
      return options.tavilySearch(query, maxResults);
    if (backend === 'serpapi' && options.serpapiSearch)
      return options.serpapiSearch(query, maxResults);
    if (backend === 'duckduckgo' && options.duckduckgoSearch)
      return options.duckduckgoSearch(query, maxResults);
    if (backend === 'hybrid' || backend === 'advanced') {
      if (options.tavilySearch) return options.tavilySearch(query, maxResults);
      if (options.serpapiSearch) return options.serpapiSearch(query, maxResults);
      if (options.duckduckgoSearch) return options.duckduckgoSearch(query, maxResults);
    }
    if (!options.allowNetwork) {
      return emptyPayload(backend, '网络搜索未启用；请显式设置 allowNetwork 或提供 mock backend。');
    }
    throw new Error(`${backend} 后端需要可选网络客户端；请提供显式 backend adapter`);
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
    if (payload.notices.length) {
      lines.push(
        '⚠️ 注意事项：',
        ...payload.notices.filter(Boolean).map((notice) => `- ${notice}`)
      );
    }
    return lines.join('\n');
  }
}

export const search = async (query: string, backend: SearchBackend = 'hybrid') =>
  new SearchTool({ backend }).execute({ input: query, backend });
export const searchTavily = (query: string) => search(query, 'tavily');
export const searchSerpapi = (query: string) => search(query, 'serpapi');
export const searchHybrid = (query: string) => search(query, 'hybrid');
