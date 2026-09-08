/**
 * 统一嵌入模块（上游 `memory/embedding.py` 的教学版移植）。
 *
 * 提供统一的文本嵌入接口与多实现：
 * - `LocalTransformerEmbedding`：本地 Transformer（优先 transformers.js 特征提取）。
 * - `DashScopeEmbedding`：阿里云 DashScope / OpenAI 兼容 REST 嵌入。
 * - `TFIDFEmbedding`：TF-IDF 兜底（自实现，对齐 sklearn 的默认算法语义）。
 *
 * 暴露 `getTextEmbedder()` / `getDimension()` / `refreshEmbedder()` 供各记忆类型统一使用。
 *
 * 环境变量（与上游一致）：
 * - `EMBED_MODEL_TYPE`: "dashscope" | "local" | "tfidf"（默认 dashscope）
 * - `EMBED_MODEL_NAME`: 模型名称（dashscope 默认 text-embedding-v3；local 默认
 *   sentence-transformers/all-MiniLM-L6-v2）
 * - `EMBED_API_KEY`: Embedding API Key（统一命名）
 * - `EMBED_BASE_URL`: Embedding Base URL（统一命名，可选；DashScope REST 模式必需）
 *
 * 已登记差异（docs/upstream-differences.md）：
 * - DIFF-009：上游 `_build_embedder` 把 `model_name` 传给不接受该参数的
 *   `TFIDFEmbedding`，导致 TF-IDF fallback 静默失败；TS 按目标实现过滤 kwargs，不
 *   复刻该 bug。
 * - DIFF-018：上游 DashScope SDK 模式在 TS 无对应 SDK，仅支持 REST（OpenAI 兼容）
 *   模式；无 `base_url` 时明确报错而非静默退化。
 * - DIFF-019：本地 Transformer 后端由 sentence-transformers 换成 transformers.js
 *   （`@huggingface/transformers`），行为（特征提取 + mean pooling）保持一致。
 */

import type { TextEmbedder } from './ports.js';

/**
 * 嵌入模型基类（上游 `EmbeddingModel`）。
 *
 * 差异说明（DIFF-020）：上游 Python 为同步阻塞调用；TS 的 DashScope/Local
 * 后端依赖异步运行时，因此 `encode` 返回联合类型（同步值或 Promise）。
 * TF-IDF 保持同步，可经 `toTextEmbedder` 注入记忆类型的同步端口。
 */
export abstract class EmbeddingModel {
  /** 编码文本；单文本返回一维向量，多文本返回二维向量。 */
  public abstract encode(
    texts: string | string[]
  ): number[] | number[][] | Promise<number[] | number[][]>;

  /** 声明的嵌入维度（未探测完成时为 0）。 */
  public abstract readonly dimension: number;
}

/** 判断模型是否同步可编码（TF-IDF 等离线实现）。 */
export function isSynchronouslyEncodable(model: EmbeddingModel): boolean {
  // 同步实现的 encode 不会返回 Promise；用构造类型判断更稳。
  return model instanceof TFIDFEmbedding;
}

/**
 * `EmbeddingModel` → 记忆类型同步 `TextEmbedder` 端口桥接。
 * 仅接受同步可编码的模型（如 TF-IDF）；异步模型请先 await 结果后再注入。
 */
export function toTextEmbedder(model: EmbeddingModel): TextEmbedder {
  if (!isSynchronouslyEncodable(model)) {
    throw new Error(
      `模型 ${model.constructor.name} 的 encode 为异步，不能注入同步 TextEmbedder 端口；` +
        '请使用 TFIDFEmbedding 或自行 await 编码结果。'
    );
  }
  return { encode: (text: string) => model.encode(text) as number[], dimension: model.dimension };
}

// ---------------------------------------------------------------------------
// TF-IDF（自实现，对齐 sklearn TfidfVectorizer 默认语义）
// ---------------------------------------------------------------------------

/**
 * sklearn 英文停用词表（`TfidfVectorizer(stop_words='english')`）。
 * 上游 fixture 生成器用真实 sklearn 构造 TF-IDF；此处内嵌同一词表，保证
 * 教学版自实现与上游词表语义一致。
 */
const ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'ain',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'aren',
  "aren't",
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'couldn',
  "couldn't",
  'd',
  'did',
  'didn',
  "didn't",
  'do',
  'does',
  'doesn',
  "doesn't",
  'doing',
  'don',
  "don't",
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'hadn',
  "hadn't",
  'has',
  'hasn',
  "hasn't",
  'have',
  'haven',
  "haven't",
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'isn',
  "isn't",
  'it',
  "it's",
  'its',
  'itself',
  'just',
  'll',
  'm',
  'ma',
  'me',
  'mightn',
  "mightn't",
  'more',
  'most',
  "mustn't",
  'mustn',
  'my',
  'myself',
  'needn',
  "needn't",
  'no',
  'nor',
  'not',
  'now',
  'o',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  're',
  's',
  'same',
  'shan',
  "shan't",
  'she',
  "she's",
  'should',
  "should've",
  'shouldn',
  "shouldn't",
  'so',
  'some',
  'such',
  't',
  'than',
  'that',
  "that'll",
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  've',
  'very',
  'was',
  'wasn',
  "wasn't",
  'we',
  'were',
  'weren',
  "weren't",
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'won',
  "won't",
  'wouldn',
  "wouldn't",
  'y',
  'you',
  "you'd",
  "you'll",
  "you're",
  "you've",
  'your',
  'yours',
  'yourself',
  'yourselves'
]);

/** sklearn 默认 token 正则：`(?u)\b\w\w+\b`（unicode 词边界，至少 2 个字符）。 */
function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\w][\w]+/gu);
  return matches ?? [];
}

/** 内积。 */
function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** 向量 L2 范数。 */
function l2Norm(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

/** TF-IDF 简易兜底（在无深度模型时保证可用；对齐 sklearn 默认算法语义）。 */
export class TFIDFEmbedding extends EmbeddingModel {
  public readonly max_features: number;
  private vocabulary: Map<string, number> | null = null;
  private idf: number[] = [];
  private _isFitted = false;
  private _dimension: number;

  public constructor(max_features = 1000) {
    super();
    this.max_features = max_features;
    // 上游 fit 前 dimension 为 max_features，fit 后覆盖为词表大小。
    this._dimension = max_features;
  }

  public get dimension(): number {
    return this._dimension;
  }

  public get isFitted(): boolean {
    return this._isFitted;
  }

  /** 训练词表与 IDF（上游 `fit`）。 */
  public fit(texts: string[]): void {
    // 统计文档频率（df）：出现某 token 的文档数。
    const df = new Map<string, number>();
    for (const text of texts) {
      const seen = new Set<string>();
      for (const token of tokenize(text)) {
        if (ENGLISH_STOP_WORDS.has(token)) continue;
        if (!seen.has(token)) {
          seen.add(token);
          df.set(token, (df.get(token) ?? 0) + 1);
        }
      }
    }
    // 取文档频率最高的前 max_features 个 token（sklearn max_features 语义；
    // 词频并列时按 token 字母序，保证确定性）。
    const ranked = [...df.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const selected = ranked.slice(0, this.max_features);
    this.vocabulary = new Map(selected.map(([token], i) => [token, i]));
    const n = texts.length;
    // smooth_idf=True：idf = ln((1+n)/(1+df)) + 1
    this.idf = selected.map(([, docFreq]) => Math.log((1 + n) / (1 + docFreq)) + 1);
    this._dimension = selected.length;
    this._isFitted = true;
  }

  /** 编码文本（上游 `encode`；未训练时抛错）。 */
  public encode(texts: string | string[]): number[] | number[][] {
    if (!this._isFitted || !this.vocabulary) {
      throw new Error('TF-IDF模型未训练，请先调用fit()方法');
    }
    const single = typeof texts === 'string';
    const inputs = single ? [texts as string] : (texts as string[]);

    const embeddings = inputs.map((text) => {
      // 词频向量
      const tf = new Array(this._dimension).fill(0);
      for (const token of tokenize(text)) {
        const index = this.vocabulary!.get(token);
        if (index !== undefined) tf[index] = (tf[index] ?? 0) + 1;
      }
      // tf × idf
      const vec = tf.map((value, i) => value * (this.idf[i] ?? 0));
      // norm='l2'：归一化到单位长度（零向量保持全零）
      const norm = l2Norm(vec);
      if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
      return vec;
    });

    return single ? (embeddings[0] ?? []) : embeddings;
  }
}

// ---------------------------------------------------------------------------
// Local Transformer（transformers.js）
// ---------------------------------------------------------------------------

/** 本地 Transformer 嵌入（优先 transformers.js，缺失时给出安装指引）。 */
export class LocalTransformerEmbedding extends EmbeddingModel {
  public readonly model_name: string;
  private _backend: 'hf' | null = null;
  private _pipeline: unknown = null;
  private _dimension: number | null = null;

  public constructor(model_name = 'sentence-transformers/all-MiniLM-L6-v2') {
    super();
    this.model_name = model_name;
  }

  /**
   * 加载 transformers.js 特征提取 pipeline（按需动态加载，无静态依赖）。
   * 与上游 `_load_backend` 的"加载失败即指引错误"语义一致。
   */
  private async loadBackend(): Promise<void> {
    if (this._backend !== null) return;
    try {
      // 按需加载的可选依赖（重依赖不进包依赖）；类型经运行时校验。
      const transformers = (await import('@huggingface/transformers' as string)) as {
        pipeline: (
          task: string,
          model: string,
          options?: Record<string, unknown>
        ) => Promise<unknown>;
      };
      const { pipeline } = transformers as {
        pipeline: (
          task: string,
          model: string,
          options?: Record<string, unknown>
        ) => Promise<unknown>;
      };
      const extractor = await pipeline('feature-extraction', this.model_name);
      this._pipeline = extractor;
      this._backend = 'hf';
      // 探测维度
      const vec = await this.encode('test_text');
      this._dimension = (vec as number[]).length;
    } catch (cause) {
      throw new Error(
        `未找到可用的本地嵌入后端（@huggingface/transformers），请安装: bun add @huggingface/transformers`,
        { cause }
      );
    }
  }

  /** 初始化并探测维度（供 fallback 判定候选可用性）。 */
  public async init(): Promise<void> {
    await this.loadBackend();
  }

  public async encode(texts: string | string[]): Promise<number[] | number[][]> {
    await this.loadBackend();
    const single = typeof texts === 'string';
    const inputs = single ? [texts as string] : (texts as string[]);
    const extractor = this._pipeline as (
      texts: string[],
      options?: Record<string, unknown>
    ) => Promise<unknown>;
    // pooling/normalize 是 feature-extraction 的调用时选项（transformers.js 文档）；
    // 传入后输出为 mean-pooled + L2 归一化向量。
    const output = (await extractor(inputs, { pooling: 'mean', normalize: true })) as {
      data: Float32Array | number[];
      dims: number[];
    };
    // mean pooling 后 shape 为 [hidden]（单条）或 [batch, hidden]；hidden 恒为最后一维
    const dims = output.dims;
    const hidden = dims.length > 0 ? (dims[dims.length - 1] ?? 0) : 0;
    const vecs: number[][] = [];
    for (let i = 0; i < inputs.length; i++) {
      const start = i * hidden;
      vecs.push(Array.from(output.data.slice(start, start + hidden)) as number[]);
    }
    const result: number[][] = vecs;
    return single ? (result[0] ?? []) : result;
  }

  public get dimension(): number {
    return this._dimension ?? 0;
  }
}

// ---------------------------------------------------------------------------
// DashScope（OpenAI 兼容 REST）
// ---------------------------------------------------------------------------

/** DashScope（通义千问）Embedding / OpenAI 兼容 REST 模式。 */
export class DashScopeEmbedding extends EmbeddingModel {
  public readonly model_name: string;
  public readonly api_key: string | undefined;
  public readonly base_url: string | undefined;
  private _dimension: number | null = null;

  public constructor(
    model_name = 'text-embedding-v3',
    api_key?: string | undefined,
    base_url?: string | undefined
  ) {
    super();
    this.model_name = model_name;
    this.api_key = api_key;
    this.base_url = base_url;
    // DIFF-018：上游在无 base_url 时回退 dashscope SDK；TS 无对应 SDK，
    // 必须显式提供 OpenAI 兼容 base_url，否则明确报错。
    if (!this.base_url) {
      throw new Error(
        'DashScopeEmbedding 需要 OpenAI 兼容的 base_url（REST 模式）。' +
          '请设置 EMBED_BASE_URL（如 https://dashscope.aliyuncs.com/compatible-mode/v1）' +
          '与 EMBED_API_KEY。TS 无 dashscope SDK，不支持 SDK 模式。'
      );
    }
  }

  /** 初始化时探测维度（上游构造器内 `encode("health_check")`）。 */
  public async init(): Promise<void> {
    const test = await this.encode('health_check');
    this._dimension = (test as number[]).length;
  }

  public async encode(texts: string | string[]): Promise<number[] | number[][]> {
    const single = typeof texts === 'string';
    const inputs = single ? [texts as string] : (texts as string[]);

    const url = `${this.base_url!.replace(/\/+$/, '')}/embeddings`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.api_key) headers.Authorization = `Bearer ${this.api_key}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.model_name, input: inputs }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Embedding REST 调用失败: ${resp.status} ${body}`);
    }
    const data = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
    const items = data.data ?? [];
    const vecs = items.map((item) => item.embedding ?? []);
    return single ? (vecs[0] ?? []) : vecs;
  }

  public get dimension(): number {
    return this._dimension ?? 0;
  }
}

// ---------------------------------------------------------------------------
// 工厂与回退
// ---------------------------------------------------------------------------

/** 创建嵌入模型实例（上游 `create_embedding_model`）。 */
export function createEmbeddingModel(
  modelType: string,
  kwargs: {
    model_name?: string | undefined;
    api_key?: string | undefined;
    base_url?: string | undefined;
  } = {}
): EmbeddingModel {
  switch (modelType) {
    case 'local':
    case 'sentence_transformer':
    case 'huggingface':
      return new LocalTransformerEmbedding(kwargs.model_name);
    case 'dashscope':
      return new DashScopeEmbedding(kwargs.model_name, kwargs.api_key, kwargs.base_url);
    case 'tfidf':
      return new TFIDFEmbedding();
    default:
      throw new Error(`不支持的模型类型: ${modelType}`);
  }
}

/**
 * 带回退的创建：dashscope -> local -> tfidf（上游 `create_embedding_model_with_fallback`）。
 *
 * 上游为同步构造即加载；TS 的 DashScope/Local 为惰性异步后端，因此这里在
 * 构造后执行初始化探测（`init()`），初始化失败同样视为该候选不可用并继续降级，
 * 保证"显式回退可观察"（matrix 行 109）。
 */
export async function createEmbeddingModelWithFallback(
  preferredType: string,
  kwargs: {
    model_name?: string | undefined;
    api_key?: string | undefined;
    base_url?: string | undefined;
  } = {}
): Promise<EmbeddingModel> {
  let preferred = preferredType;
  if (preferred === 'sentence_transformer' || preferred === 'huggingface') {
    preferred = 'local';
  }
  const fallback = ['dashscope', 'local', 'tfidf'];
  if (fallback.includes(preferred)) {
    fallback.splice(fallback.indexOf(preferred), 1);
    fallback.unshift(preferred);
  }
  for (const type of fallback) {
    try {
      const model = createEmbeddingModel(type, kwargs);
      // 惰性后端在构造后探测维度；失败视为不可用，继续降级。
      const probe = model as EmbeddingModel & { init?: () => Promise<void> };
      if (typeof probe.init === 'function') {
        await probe.init();
      }
      return model;
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new Error('所有嵌入模型都不可用，请安装依赖或检查配置');
}

// ---------------------------------------------------------------------------
// Provider（单例）
// ---------------------------------------------------------------------------

let _embedder: EmbeddingModel | null = null;
let _embedderLock: Promise<void> | null = null;

/** 构建嵌入器（DIFF-009：kwargs 只传给接受该参数的目标实现；不再把 model_name 传给 TF-IDF 造成上游式静默失败）。 */
export function buildEmbedder(): {
  preferred: string;
  kwargs: { model_name?: string; api_key?: string; base_url?: string };
} {
  const preferred = (process.env.EMBED_MODEL_TYPE ?? 'dashscope').trim();
  const defaultModel =
    preferred === 'dashscope' ? 'text-embedding-v3' : 'sentence-transformers/all-MiniLM-L6-v2';
  const modelName = (process.env.EMBED_MODEL_NAME ?? defaultModel).trim();
  const kwargs: { model_name?: string; api_key?: string; base_url?: string } = {};
  if (modelName) kwargs.model_name = modelName;
  const apiKey = process.env.EMBED_API_KEY;
  if (apiKey) kwargs.api_key = apiKey;
  const baseUrl = process.env.EMBED_BASE_URL;
  if (baseUrl) kwargs.base_url = baseUrl;
  return { preferred, kwargs };
}

/** 获取全局共享的文本嵌入实例（单例；上游 `get_text_embedder`）。 */
export async function getTextEmbedder(): Promise<EmbeddingModel> {
  if (_embedder !== null) return _embedder;
  if (_embedderLock === null) {
    _embedderLock = (async () => {
      const { preferred, kwargs } = buildEmbedder();
      _embedder = await createEmbeddingModelWithFallback(preferred, kwargs);
    })().finally(() => {
      _embedderLock = null;
    });
  }
  await _embedderLock;
  return _embedder!;
}

/** 获取统一向量维度（失败回退默认值；上游 `get_dimension`）。 */
export async function getDimension(default_ = 384): Promise<number> {
  try {
    const embedder = await getTextEmbedder();
    const dim = embedder.dimension;
    return dim > 0 ? dim : default_;
  } catch {
    return default_;
  }
}

/** 强制重建嵌入实例（可用于动态切换环境变量；上游 `refresh_embedder`）。 */
export async function refreshEmbedder(): Promise<EmbeddingModel> {
  const { preferred, kwargs } = buildEmbedder();
  _embedder = await createEmbeddingModelWithFallback(preferred, kwargs);
  return _embedder;
}

/** 测试用：清空单例（非上游 API，仅供隔离测试）。 */
export function _resetEmbedderForTesting(): void {
  _embedder = null;
  _embedderLock = null;
}
