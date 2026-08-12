export interface TokenCounterOptions {
  readonly tokenize?: (text: string) => number;
}

export interface TokenCounterStats {
  readonly cache_hits: number;
  readonly cache_misses: number;
  readonly entries: number;
}

/** Cached token counter; callers may inject a model-specific tokenizer. */
export class TokenCounter {
  private readonly tokenize: (text: string) => number;
  private readonly cache = new Map<string, number>();
  private hits = 0;
  private misses = 0;

  public constructor(options: TokenCounterOptions = {}) {
    this.tokenize = options.tokenize ?? ((text) => Math.floor([...text].length / 4));
  }

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

  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  public getStats(): TokenCounterStats {
    return { cache_hits: this.hits, cache_misses: this.misses, entries: this.cache.size };
  }
}
