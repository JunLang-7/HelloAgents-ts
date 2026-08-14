export interface TokenCounterOptions {
  /** 模型专用 tokenizer；默认使用轻量的字符估算。 */
  readonly tokenize?: (text: string) => number;
}

/** `TokenCounter.getStats` 返回的缓存命中和大小统计。 */
export interface TokenCounterStats {
  readonly cache_hits: number;
  readonly cache_misses: number;
  readonly entries: number;
}

/** 带缓存的 token 计数器；调用方可以注入模型专用 tokenizer。 */
export class TokenCounter {
  private readonly tokenize: (text: string) => number;
  private readonly cache = new Map<string, number>();
  private hits = 0;
  private misses = 0;

  public constructor(options: TokenCounterOptions = {}) {
    this.tokenize = options.tokenize ?? ((text) => Math.floor([...text].length / 4));
  }

  /** 统计 token，并缓存相同文本的结果。 */
  public count(text: string): number {
    const cached = this.cache.get(text);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }
    this.misses += 1;
    const count = this.tokenize(text);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new TypeError('Tokenizer must return a non-negative integer');
    this.cache.set(text, count);
    return count;
  }

  /** 清空缓存计数并重置命中/未命中统计。 */
  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** 返回缓存统计，供监控或测试使用。 */
  public getStats(): TokenCounterStats {
    return { cache_hits: this.hits, cache_misses: this.misses, entries: this.cache.size };
  }
}
