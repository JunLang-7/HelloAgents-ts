/**
 * LocalTransformerEmbedding 回归测试（审阅修复 P1）：
 * - pooling/normalize 必须作为 extractor 调用的选项传入；
 * - mean pooling 后输出 shape 为 [hidden]（单条）或 [batch, hidden]（二维），
 *   hidden 取最后一维；dims[2] 不存在，旧实现会得到空向量。
 *
 * 用 mock.module 注入 fake pipeline（transformers.js 未安装时也可运行）。
 */
import { describe, expect, mock, test } from 'bun:test';

import { LocalTransformerEmbedding } from '../hello_agents/memory/embedding.js';

interface ExtractCall {
  inputs: unknown;
  options: Record<string, unknown> | undefined;
}

/** 记录每次 extractor 调用并返回 mean-pooled 张量（shape=[n, hidden]）。 */
function makeFakeExtractor() {
  const calls: ExtractCall[] = [];
  const extractor = async (
    inputs: unknown,
    options?: Record<string, unknown>
  ): Promise<{ data: Float32Array; dims: number[] }> => {
    calls.push({ inputs, options });
    const n = (inputs as string[]).length;
    const hidden = 3;
    const data = new Float32Array(n * hidden);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < hidden; j++) data[i * hidden + j] = i * 10 + j;
    }
    return { data, dims: [n, hidden] };
  };
  return { calls, extractor };
}

const fake = makeFakeExtractor();

// mock 工厂惰性执行：pipeline() 仅在测试运行时的动态 import 中被调用，
// 届时 fake 已就绪。
mock.module('@huggingface/transformers', () => ({
  pipeline: async () => fake.extractor
}));

describe('LocalTransformerEmbedding pooling/normalization regression', () => {
  test('passes pooling and normalize to the extractor call', async () => {
    const model = new LocalTransformerEmbedding();
    // loadBackend 探测维度会先调用一次；确认所有调用都带 pooling/normalize
    await model.encode('single');
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      expect(call.options).toMatchObject({ pooling: 'mean', normalize: true });
    }
  });

  test('single input slices [hidden] output correctly', async () => {
    const model = new LocalTransformerEmbedding();
    const vec = await model.encode('single');
    expect(Array.isArray(vec)).toBe(true);
    expect((vec as number[]).length).toBe(3);
    // 探测维度调用后，下一次 encode 返回真实切片
    expect(Array.from((vec as number[]).slice(0, 3))).toEqual([0, 1, 2]);
  });

  test('batch input slices [batch, hidden] output correctly', async () => {
    const model = new LocalTransformerEmbedding();
    const vecs = (await model.encode(['a', 'b'])) as number[][];
    expect(vecs.length).toBe(2);
    expect(vecs[0]).toEqual([0, 1, 2]);
    expect(vecs[1]).toEqual([10, 11, 12]);
  });
});
