import { afterEach, describe, expect, test } from 'bun:test';

import {
  _resetEmbedderForTesting,
  createEmbeddingModel,
  createEmbeddingModelWithFallback,
  DashScopeEmbedding,
  EmbeddingModel,
  getDimension,
  getTextEmbedder,
  refreshEmbedder,
  TFIDFEmbedding,
  toTextEmbedder
} from '../hello_agents/memory/embedding.js';
import {
  LocalTransformerEmbedding,
  SentenceTransformerEmbedding,
  HuggingFaceEmbedding
} from '../hello_agents/memory/rag/index.js';

afterEach(() => {
  _resetEmbedderForTesting();
});

describe('TFIDFEmbedding', () => {
  test('fit builds a deterministic vocabulary and dimension', () => {
    const model = new TFIDFEmbedding(1000);
    expect(model.dimension).toBe(1000); // 上游 fit 前 dimension = max_features
    model.fit(['hello world hello', 'hello agents', 'world of agents']);
    expect(model.isFitted).toBe(true);
    expect(model.dimension).toBeGreaterThan(0);
    expect(model.dimension).toBeLessThanOrEqual(1000);
  });

  test('encode returns a unit-L2-normalized dense vector for single text', () => {
    const model = new TFIDFEmbedding(1000);
    model.fit(['hello world hello', 'hello agents', 'world of agents']);
    const vec = model.encode('hello world') as number[];
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBe(model.dimension);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  test('encode supports a batch and drops English stop words', () => {
    const model = new TFIDFEmbedding(1000);
    model.fit(['the quick brown fox', 'quick fox jumps', 'lazy dog sleeps']);
    const vecs = model.encode(['the fox', 'quick jumps']) as number[][];
    expect(vecs.length).toBe(2);
    for (const v of vecs) expect(v.length).toBe(model.dimension);
    // 'the' 是停用词：包含 'the' 的文本与不含它的同义文本应产生相同向量（仅 'fox' 生效）
    const withStop = model.encode('the fox') as number[];
    const withoutStop = model.encode('fox') as number[];
    expect(withStop).toEqual(withoutStop);
  });

  test('encode before fit throws a descriptive error', () => {
    const model = new TFIDFEmbedding();
    expect(() => model.encode('hello')).toThrow('TF-IDF模型未训练，请先调用fit()方法');
  });

  test('max_features caps the vocabulary by document frequency', () => {
    const model = new TFIDFEmbedding(2);
    model.fit(['alpha alpha alpha beta beta gamma', 'alpha beta gamma', 'alpha']);
    expect(model.dimension).toBeLessThanOrEqual(2);
    expect(model.dimension).toBeGreaterThan(0);
  });

  test('satisfies the synchronous TextEmbedder port via toTextEmbedder', () => {
    const model = new TFIDFEmbedding(64);
    model.fit(['alpha beta', 'beta gamma']);
    const embedder = toTextEmbedder(model);
    const vec = embedder.encode('alpha');
    expect(vec.length).toBe(model.dimension);
    expect(embedder.dimension).toBe(model.dimension);
  });
});

describe('EmbeddingModel factory', () => {
  test('createEmbeddingModel selects each supported type', () => {
    expect(createEmbeddingModel('tfidf')).toBeInstanceOf(TFIDFEmbedding);
    expect(createEmbeddingModel('local')).toBeInstanceOf(LocalTransformerEmbedding);
    expect(createEmbeddingModel('sentence_transformer')).toBeInstanceOf(LocalTransformerEmbedding);
    expect(createEmbeddingModel('huggingface')).toBeInstanceOf(LocalTransformerEmbedding);
    // 提供 base_url 时 DashScope 走 REST 模式（构造成功）
    expect(
      createEmbeddingModel('dashscope', { base_url: 'http://localhost:8000/v1' })
    ).toBeInstanceOf(DashScopeEmbedding);
    // 未知类型明确报错
    expect(() => createEmbeddingModel('unknown')).toThrow('不支持的模型类型');
  });

  test('DashScope without base_url fails loudly (no silent SDK fallback)', () => {
    expect(() => new DashScopeEmbedding('text-embedding-v3')).toThrow(
      'TS 无 dashscope SDK，不支持 SDK 模式'
    );
  });

  test('toTextEmbedder rejects async backends', () => {
    const local = new LocalTransformerEmbedding();
    expect(() => toTextEmbedder(local)).toThrow('不能注入同步 TextEmbedder 端口');
  });

  test('createEmbeddingModelWithFallback falls back through dashscope -> local -> tfidf', async () => {
    // dashscope 无 base_url 构造失败；local 未安装后端初始化失败；最终落到 tfidf
    const model = await createEmbeddingModelWithFallback('dashscope');
    expect(model).toBeInstanceOf(TFIDFEmbedding);
  });

  test('fallback with unavailable preferred type still returns a model', async () => {
    const model = await createEmbeddingModelWithFallback('tfidf');
    expect(model).toBeInstanceOf(TFIDFEmbedding);
  });
});

describe('embedding provider singleton', () => {
  test('getTextEmbedder caches a single instance', async () => {
    const a = await getTextEmbedder();
    const b = await getTextEmbedder();
    expect(a).toBe(b);
  });

  test('getDimension returns the embedder dimension and falls back to default', async () => {
    // 无 EMBED_MODEL_TYPE 时默认 dashscope → 无 base_url → 降级 tfidf → dimension 为 max_features
    const dim = await getDimension(384);
    expect(dim).toBeGreaterThan(0);
  });

  test('refreshEmbedder rebuilds the singleton', async () => {
    const first = await getTextEmbedder();
    const second = await refreshEmbedder();
    expect(first).not.toBe(second);
    expect(await getTextEmbedder()).toBe(second);
  });

  test('EMBED_MODEL_TYPE=tfidf builds a TF-IDF embedder', async () => {
    process.env.EMBED_MODEL_TYPE = 'tfidf';
    delete process.env.EMBED_MODEL_NAME;
    const model = await getTextEmbedder();
    expect(model).toBeInstanceOf(TFIDFEmbedding);
    delete process.env.EMBED_MODEL_TYPE;
  });
});

describe('rag compat aliases', () => {
  test('SentenceTransformerEmbedding and HuggingFaceEmbedding alias LocalTransformerEmbedding', () => {
    expect(SentenceTransformerEmbedding).toBe(LocalTransformerEmbedding);
    expect(HuggingFaceEmbedding).toBe(LocalTransformerEmbedding);
    expect(new SentenceTransformerEmbedding()).toBeInstanceOf(EmbeddingModel);
  });
});
