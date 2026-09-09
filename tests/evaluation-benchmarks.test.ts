/**
 * #76 评测模块测试：BFCL / GAIA / 数据生成评测。
 *
 * 验收① 本地 fixture 验证指标与导出格式（AST 匹配、答案标准化、LLM Judge 打分、
 *        Win Rate 采样与 JSONL/JSON 导出）；
 * 验收② 外部数据 opt-in：GAIA 远程 gated 数据集与 AIME 真题下载均明确不可用，
 *        不进入默认测试网络路径，也不以 mock 冒充完成；
 * 验收③ 空数据 / 格式错误 / 部分失败有明确结果（空数据集返回空汇总，坏行跳过，
 *        LLM 响应解析失败回退默认分）；
 * 验收④ 工具可从 ToolRegistry 调用（BFCLEvaluationTool / GAIAEvaluationTool /
 *        LLMJudgeTool / WinRateTool）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BFCLDataset,
  BFCLEvaluator,
  BFCLIntegration,
  BFCLMetrics,
  astStringsMatch,
  extractFunctionCalls,
  parseBfclVersion,
  parseCallExpression,
  semverGte,
  stringSimilarity,
  type BfclResultSample
} from '../hello_agents/evaluation/benchmarks/bfcl/index.js';
import {
  GAIADataset,
  GAIAEvaluator,
  standardizeGaiaItem,
  checkExactMatch,
  checkPartialMatch,
  extractGaiaAnswer,
  normalizeGaiaAnswer
} from '../hello_agents/evaluation/benchmarks/gaia/index.js';
import {
  AIDataset,
  LLMJudgeEvaluator,
  WinRateEvaluator,
  parseComparisonResponse,
  parseJudgeResponse
} from '../hello_agents/evaluation/benchmarks/data-generation/index.js';
import {
  BFCLEvaluationTool,
  GAIAEvaluationTool,
  LLMJudgeTool,
  WinRateTool
} from '../hello_agents/tools/builtin/evaluation-tools.js';
import { ToolRegistry } from '../hello_agents/tools/index.js';

/* -------------------------------------------------------------------------- */
/* 测试夹具：临时数据目录                                                       */
/* -------------------------------------------------------------------------- */

let fixtureRoot: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'helloagents-eval-'));
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(join(process.cwd(), 'evaluation_results'), { recursive: true, force: true });
  rmSync(join(process.cwd(), 'evaluation_reports'), { recursive: true, force: true });
});

function writeFixture(rel: string, content: string): string {
  const full = join(fixtureRoot, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

function makeBfclDataDir(): string {
  // 测试数据 + possible_answer ground truth（v4 dict 格式）。
  writeFixture(
    'bfcl/BFCL_v4_simple_python.json',
    [
      JSON.stringify({
        id: 'qa-1',
        question: '北京现在天气如何？',
        function: [{ name: 'get_current_weather', description: '获取天气' }]
      })
    ].join('\n')
  );
  writeFixture(
    'bfcl/possible_answer/BFCL_v4_simple_python.json',
    [
      JSON.stringify({
        id: 'qa-1',
        ground_truth: [{ get_current_weather: { city: ['北京'] } }]
      })
    ].join('\n')
  );
  return join(fixtureRoot, 'bfcl');
}

const fakeAgent = {
  name: 'FixtureAgent',
  async run(task: string): Promise<string> {
    if (task.includes('get_current_weather'))
      return '[{"name":"get_current_weather","arguments":{"city":"北京"}}]';
    return 'The final answer is 42';
  }
};

/* -------------------------------------------------------------------------- */
/* BFCL：AST 解析 / 归一化 / 相似度                                             */
/* -------------------------------------------------------------------------- */

describe('BFCL metrics 与 AST 匹配', () => {
  test('parseCallExpression 解析具名参数并归一化字面量', () => {
    const parsed = parseCallExpression('get_current_weather(city="北京", unit="celsius")');
    expect(parsed).toEqual({
      name: 'get_current_weather',
      args: [
        ['city', '北京'],
        ['unit', 'celsius']
      ]
    });
  });

  test('parseCallExpression 处理嵌套结构与数字/布尔字面量', () => {
    const parsed = parseCallExpression('search_users(name="Alice", limit=10, active=True)');
    expect(parsed?.args).toEqual([
      ['name', 'Alice'],
      ['limit', 10],
      ['active', true]
    ]);
    expect(parseCallExpression('not a call')).toBeNull();
  });

  test('normalizeLiteral 对齐 Python 字面量', () => {
    expect(stringSimilarity('hello world', 'hello world')).toBe(1.0);
    expect(stringSimilarity('hello world', 'hello there')).toBe(1 / 3);
    expect(stringSimilarity('', 'x')).toBe(0.0);
  });

  test('astStringsMatch 等价结构为 true，参数不同为 false', () => {
    expect(
      astStringsMatch('get_current_weather(city="北京")', 'get_current_weather(city="北京")')
    ).toBe(true);
    expect(
      astStringsMatch('get_current_weather(city="北京")', 'get_current_weather(city="上海")')
    ).toBe(false);
  });

  test('extractFunctionCalls 从文本中提取调用', () => {
    const calls = extractFunctionCalls(
      '[{"name":"get_current_weather","arguments":{"city":"北京"}}]'
    );
    expect(calls.length).toBe(1);
    expect(calls[0]).toHaveProperty('name', 'get_current_weather');
  });
});

/* -------------------------------------------------------------------------- */
/* BFCL：数据集 / 评估器 / 导出                                                 */
/* -------------------------------------------------------------------------- */

describe('BFCL dataset 与 evaluator（本地 fixture）', () => {
  test('坏 JSONL 行被跳过并计数，空数据目录返回空数组', () => {
    const broken = join(fixtureRoot, 'bfcl-broken');
    mkdirSync(join(broken, 'possible_answer'), { recursive: true });
    writeFileSync(join(broken, 'BFCL_v4_simple_python.json'), '{"id":"ok"}\nnot-json\n\n', 'utf8');
    const dataset = new BFCLDataset({ dataDir: broken, category: 'simple_python' });
    dataset.load();
    expect(dataset.data.length).toBe(1);
  });

  test('v4 dict ground truth 命中：整体准确率 1.0 且导出 JSONL', async () => {
    const dataDir = makeBfclDataDir();
    const dataset = new BFCLDataset({ dataDir, category: 'simple_python' });
    const evaluator = new BFCLEvaluator({ dataset });
    const results = await evaluator.evaluate(fakeAgent, 5);
    expect(results.benchmark).toBe('BFCL');
    expect(results.total_samples).toBe(1);
    expect(results.correct_samples).toBe(1);
    expect(results.overall_accuracy).toBe(1.0);

    // 指标对象输出。
    const metrics = new BFCLMetrics();
    const computed = metrics.computeMetrics(
      results.detailed_results as unknown as BfclResultSample[]
    );
    expect(computed.total_samples).toBe(1);
    expect(computed.accuracy).toBe(1.0);

    // 导出 BFCL 官方格式 JSONL。
    const exportFile = join(fixtureRoot, 'bfcl_result.jsonl');
    evaluator.exportToBfclFormat(results, exportFile);
    expect(existsSync(exportFile)).toBe(true);
    const lines = readFileSync(exportFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    // BFCL 官方导出格式：每样本一行 {id, result, inference_log}。
    expect(first).toHaveProperty('id', 'qa-1');
    expect(first.result).toContain('get_current_weather');
  });

  test('多调用匹配必须一对一，重复预测不能替代缺失调用', () => {
    const evaluator = new BFCLEvaluator();
    const predicted = [
      { name: 'weather', arguments: { city: '北京' } },
      { name: 'weather', arguments: { city: '北京' } }
    ];
    const v4Expected = [{ weather: { city: ['北京'] } }, { calendar: { date: ['今天'] } }];
    const stringExpected = ['weather(city="北京")', 'calendar(date="今天")'];

    expect(evaluator.evaluateBfclV4Format(predicted, v4Expected)).toEqual([false, 0.5]);
    expect(evaluator.evaluateStringFormat(predicted, stringExpected)).toEqual([false, 0.5]);
  });

  test('空数据集返回空汇总而非抛错', async () => {
    const emptyDir = join(fixtureRoot, 'bfcl-empty');
    mkdirSync(join(emptyDir, 'possible_answer'), { recursive: true });
    const evaluator = new BFCLEvaluator({ dataset: new BFCLDataset({ dataDir: emptyDir }) });
    const results = await evaluator.evaluate(fakeAgent);
    expect(results.total_samples).toBe(0);
    expect(results.overall_accuracy).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* BFCL：版本校验（真实命令验证的证据基础）                                     */
/* -------------------------------------------------------------------------- */

describe('BFCLIntegration 版本校验', () => {
  test('parseBfclVersion 与 semverGte 判定支持边界', () => {
    expect(parseBfclVersion('bfcl --version\n0.4.1')).toBe('0.4.1');
    expect(parseBfclVersion('no version here')).toBeNull();
    expect(semverGte('0.4.0', '0.4.0')).toBe(true);
    expect(semverGte('0.4.1', '0.4.0')).toBe(true);
    expect(semverGte('0.3.9', '0.4.0')).toBe(false);
  });

  test('isVersionSupported：真实命令缺失时明确不可用（不 mock）', () => {
    const integration = new BFCLIntegration({
      projectRoot: fixtureRoot,
      bin: 'definitely-not-a-real-bfcl-bin'
    });
    expect(integration.getVersion()).toBeNull();
    expect(integration.isVersionSupported()).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* GAIA：答案标准化 / 提取 / 匹配                                               */
/* -------------------------------------------------------------------------- */

describe('GAIA 答案标准化与匹配', () => {
  test('normalizeGaiaAnswer 去冠词/货币符号/千分位/末尾标点', () => {
    expect(normalizeGaiaAnswer('The answer is $1234.56.')).toBe('answer is 1234.56');
    expect(normalizeGaiaAnswer('A dog')).toBe('dog');
  });

  test('含逗号列表先标准化后排序', () => {
    expect(normalizeGaiaAnswer('banana, apple, cherry')).toBe('apple,banana,cherry');
  });

  test('extractGaiaAnswer 提取 FINAL ANSWER', () => {
    expect(extractGaiaAnswer('...thinking...\nFINAL ANSWER: 42\n')).toBe('42');
    expect(extractGaiaAnswer('No marker here')).toBe('No marker here');
  });

  test('checkExactMatch / checkPartialMatch', () => {
    expect(checkExactMatch('The answer is 42', 'answer is 42')).toBe(true);
    expect(checkExactMatch('42', '43')).toBe(false);
    expect(checkPartialMatch('The answer is 42', '42')).toBe(true);
    expect(checkPartialMatch('The capital is Paris', 'Paris')).toBe(true);
  });
});

describe('GAIA dataset 与 evaluator（本地 fixture + 远程 opt-in）', () => {
  test('本地 JSON 目录加载并按 level 过滤', () => {
    const localDir = join(fixtureRoot, 'gaia-local');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, 'gaia_validation.json'),
      JSON.stringify([
        { task_id: 'g1', Question: 'What is 1+1?', Level: 1, 'Final answer': '2' },
        { task_id: 'g2', Question: 'Hard?', Level: 3, 'Final answer': '7' }
      ]),
      'utf8'
    );
    const dataset = new GAIADataset({ localDataDir: localDir });
    const items = dataset.load();
    expect(items.length).toBe(2);
    const lvl1 = new GAIADataset({ localDataDir: localDir, level: 1 }).load();
    expect(lvl1.length).toBe(1);
  });

  test('远程 gated 数据集明确不可用（返回空并指引本地加载）', async () => {
    const dataset = new GAIADataset({ datasetName: 'gaia-benchmark/GAIA' });
    const items = dataset.load();
    expect(items.length).toBe(0);
    const evaluator = new GAIAEvaluator({ dataset });
    const results = await evaluator.evaluate(fakeAgent);
    expect(results.total_samples).toBe(0);
    expect(results.exact_match_rate).toBe(0);
  });

  test('真实 GAIA 形态：Level 为字符串仍正确归一化并过滤', () => {
    const localDir = join(fixtureRoot, 'gaia-real');
    mkdirSync(localDir, { recursive: true });
    // 官方 metadata.parquet 的 Level 是字符串 '1'/'2'/'3'
    writeFileSync(
      join(localDir, 'gaia_validation.json'),
      JSON.stringify([
        { task_id: 'r1', Question: 'Q1', Level: '2', 'Final answer': 'a' },
        { task_id: 'r2', Question: 'Q2', Level: '3', 'Final answer': 'b' },
        { task_id: 'r3', Question: 'Q3', Level: '1', 'Final answer': 'c' }
      ]),
      'utf8'
    );
    const items = new GAIADataset({ localDataDir: localDir }).load();
    expect(items.map((i) => i.level).sort()).toEqual([1, 2, 3]);
    const lvl2 = new GAIADataset({ localDataDir: localDir, level: 2 }).load();
    expect(lvl2.length).toBe(1);
    expect(lvl2[0]?.task_id).toBe('r1');
    // 非法 level 回退 1（对齐上游默认）
    const bad = standardizeGaiaItem({ task_id: 'x', Level: 'abc' });
    expect(bad.level).toBe(1);
  });

  test('snake_case 元数据和工具列表不会被空的 Title Case 回退覆盖', () => {
    const item = standardizeGaiaItem({
      task_id: 'snake',
      annotator_metadata: { source: 'local' },
      tools: ['python', 'browser']
    });
    expect(item.annotator_metadata).toEqual({ source: 'local' });
    expect(item.tools).toEqual(['python', 'browser']);
  });

  test('本地 fixture 评估命中精确匹配并导出官方格式', async () => {
    const localDir = join(fixtureRoot, 'gaia-local');
    const evaluator = new GAIAEvaluator({ dataset: new GAIADataset({ localDataDir: localDir }) });
    const results = await evaluator.evaluate(fakeAgent, 5);
    expect(results.total_samples).toBe(2);
    const exportFile = join(fixtureRoot, 'gaia_result.jsonl');
    evaluator.exportToGaiaFormat(results, exportFile, true);
    const lines = readFileSync(exportFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 数据生成：AIDataset（real opt-in 抛错）                                      */
/* -------------------------------------------------------------------------- */

describe('AIDataset', () => {
  test('generated 数据集从本地 JSON 加载', () => {
    const dataPath = writeFixture(
      'gen-problems.json',
      JSON.stringify([
        { id: 'p1', problem: '1+1?', answer: '2', difficulty: 1 },
        { id: 'p2', problem: '2+2?', answer: '4', difficulty: 1 }
      ])
    );
    const dataset = new AIDataset({ datasetType: 'generated', dataPath });
    const problems = dataset.load();
    expect(problems.length).toBe(2);
    expect(problems[0]?.problem).toBe('1+1?');
  });

  test('真实 AIME 形态：answer 为数字时归一化为字符串', () => {
    // math-ai/aime25 test.jsonl 的行：{ id, problem, answer: number }
    const dataPath = writeFixture(
      'aime25-real.json',
      JSON.stringify([
        { id: '0', problem: 'Find 5+2.', answer: 7 },
        { id: '1', problem: 'Compute 3*4.', answer: 12 }
      ])
    );
    const dataset = new AIDataset({ datasetType: 'generated', dataPath });
    const problems = dataset.load();
    expect(problems.length).toBe(2);
    expect(problems[0]?.problem_id).toBe('0');
    expect(problems[0]?.answer).toBe('7');
    expect(problems[1]?.answer).toBe('12');
  });

  test('real 数据集（AIME 下载）明确抛错并指引本地文件', () => {
    const dataset = new AIDataset({ datasetType: 'real', year: 2025 });
    expect(() => dataset.load()).toThrow(/huggingface_hub|本地文件/);
  });
});

/* -------------------------------------------------------------------------- */
/* LLM Judge                                                                   */
/* -------------------------------------------------------------------------- */

describe('LLMJudgeEvaluator', () => {
  const fakeJudge = {
    invoke(_messages: readonly unknown[]): string {
      void _messages;
      return JSON.stringify({ correctness: 5, clarity: 4, difficulty_match: 3, completeness: 5 });
    }
  };

  test('parseJudgeResponse 缺维度默认 3 分，坏响应回退全 3', () => {
    expect(parseJudgeResponse('{"correctness": 5}')).toEqual({
      correctness: 5,
      clarity: 3,
      difficulty_match: 3,
      completeness: 3
    });
    expect(parseJudgeResponse('not json at all')).toEqual({
      correctness: 3,
      clarity: 3,
      difficulty_match: 3,
      completeness: 3
    });
  });

  test('evaluateBatch 聚合均值 / pass / excellent 阈值', async () => {
    const evaluator = new LLMJudgeEvaluator({ llm: fakeJudge, judgeModel: 'fixture' });
    const problems = [{ id: 'p1', problem: 'q1', answer: 'a1' }];
    const results = await evaluator.evaluateBatch(problems);
    expect(results.results.length).toBe(1);
    expect(results.results[0]!.total_score).toBe(4.25);
    expect(results.metrics.average_total_score).toBe(4.25);
    expect(results.metrics.pass_rate).toBe(1);
    expect(results.metrics.excellent_rate).toBe(0);
    const exportFile = join(fixtureRoot, 'llm_judge_result.json');
    evaluator.exportResults(results, exportFile);
    expect(JSON.parse(readFileSync(exportFile, 'utf8'))).toHaveProperty('results');
  });

  test('空数据集返回全零指标', async () => {
    const evaluator = new LLMJudgeEvaluator({ llm: fakeJudge, judgeModel: 'fixture' });
    const results = await evaluator.evaluateBatch([]);
    expect(results.results.length).toBe(0);
    expect(results.metrics.average_total_score).toBe(0);
    expect(results.metrics.pass_rate).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Win Rate                                                                    */
/* -------------------------------------------------------------------------- */

describe('WinRateEvaluator', () => {
  const fakeJudge = {
    invoke(_messages: readonly unknown[]): string {
      void _messages;
      return JSON.stringify({ winner: 'Problem A', reason: 'more complete' });
    }
  };

  test('parseComparisonResponse 修复 LaTeX 反斜杠转义', () => {
    const [winner, reason] = parseComparisonResponse(
      '{"winner":"Problem A","reason":"uses \\d{1}{2}"}',
      'Problem A',
      'Problem B'
    );
    expect(winner).toBe('Problem A');
    expect(reason).toBe('uses \\d{1}{2}');
  });

  test('固定 rng 使采样可复现并映射胜者', async () => {
    const evaluator = new WinRateEvaluator({ llm: fakeJudge, judgeModel: 'fixture', rng: () => 0 });
    const generated = [{ id: 'g1', problem: 'q?', answer: 'a' }];
    const reference = [{ id: 'r1', problem: 'q?', answer: 'b' }];
    const results = await evaluator.evaluateWinRate(generated, reference, 1);
    expect(results.comparisons.length).toBe(1);
    expect(results.comparisons[0]!.actual_order).toEqual({ A: 'Generated', B: 'Reference' });
    expect(
      results.metrics.win_rate + results.metrics.loss_rate + results.metrics.tie_rate
    ).toBeCloseTo(1, 5);
    const exportFile = join(fixtureRoot, 'win_rate_result.json');
    evaluator.exportResults(results, exportFile);
    expect(JSON.parse(readFileSync(exportFile, 'utf8'))).toHaveProperty('comparisons');
  });

  test('不同 rng 种子产生不同采样', async () => {
    const problems = Array.from({ length: 10 }, (_, i) => ({
      problem_id: `g${i}`,
      problem: `q${i}?`,
      answer: 'a'
    }));
    const reference = Array.from({ length: 10 }, (_, i) => ({
      problem_id: `r${i}`,
      problem: `q${i}?`,
      answer: 'b'
    }));
    const a = new WinRateEvaluator({ llm: fakeJudge, judgeModel: 'f', rng: () => 0 });
    const b = new WinRateEvaluator({ llm: fakeJudge, judgeModel: 'f', rng: () => 0.99 });
    const ra = await a.evaluateWinRate(problems, reference, 3);
    const rb = await b.evaluateWinRate(problems, reference, 3);
    expect(ra.comparisons.map((c) => c.problem_a_id)).not.toEqual(
      rb.comparisons.map((c) => c.problem_a_id)
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 工具：ToolRegistry 调用                                                      */
/* -------------------------------------------------------------------------- */

describe('Evaluation 工具（ToolRegistry 可调用）', () => {
  test('BFCLEvaluationTool：数据目录缺失时返回明确错误结果', async () => {
    const tool = new BFCLEvaluationTool({
      agent: fakeAgent,
      bfclDataDir: join(fixtureRoot, 'no-such-bfcl-data')
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const response = await registry.execute('bfcl_evaluation', { category: 'simple_python' });
    expect(response.text).toContain('BFCL数据目录不存在');
  });

  test('BFCLEvaluationTool：本地 fixture 评估成功并返回指标', async () => {
    const tool = new BFCLEvaluationTool({
      agent: fakeAgent,
      bfclDataDir: makeBfclDataDir(),
      projectRoot: fixtureRoot,
      bin: 'bfcl'
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const response = await registry.execute('bfcl_evaluation', {
      category: 'simple_python',
      run_official_eval: false
    });
    expect(response.status).toBe('success');
    expect(response.text).toContain('总体准确率');
  });

  test('BFCLEvaluationTool：官方 CLI 不可用时返回 partial 而非 success', async () => {
    const tool = new BFCLEvaluationTool({
      agent: fakeAgent,
      bfclDataDir: makeBfclDataDir(),
      projectRoot: fixtureRoot,
      bin: 'definitely-missing-bfcl-binary'
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const response = await registry.execute('bfcl_evaluation', { category: 'simple_python' });
    expect(response.status).toBe('partial');
    expect(response.text).toContain('官方评估未执行');
  });

  test('GAIAEvaluationTool 可从注册表调用', async () => {
    const localDir = join(fixtureRoot, 'gaia-local');
    if (!existsSync(localDir)) {
      mkdirSync(localDir, { recursive: true });
      writeFileSync(
        join(localDir, 'gaia_validation.json'),
        JSON.stringify([
          { task_id: 'g1', Question: 'What is 1+1?', Level: 1, 'Final answer': '2' }
        ]),
        'utf8'
      );
    }
    const tool = new GAIAEvaluationTool({ agent: fakeAgent, localDataPath: localDir });
    const registry = new ToolRegistry();
    registry.register(tool);
    const response = await registry.execute('gaia_evaluation', { level: 1, max_samples: 1 });
    expect(response.text).toContain('精确匹配率');
  });

  test('LLMJudgeTool 与 WinRateTool 可从注册表调用', async () => {
    const genPath = writeFixture(
      'gen-problems.json',
      JSON.stringify([{ id: 'p1', problem: '1+1?', answer: '2' }])
    );
    const llm = {
      invoke(_messages: readonly unknown[]): string {
        void _messages;
        return JSON.stringify({ correctness: 5, clarity: 4, difficulty_match: 3, completeness: 5 });
      }
    };
    const registry = new ToolRegistry();
    registry.register(new LLMJudgeTool({ llm }));
    const judgeResponse = await registry.execute('llm_judge_evaluation', {
      generated_data_path: genPath,
      output_dir: join(fixtureRoot, 'out', 'judge')
    });
    expect(judgeResponse.text).toContain('平均总分');

    registry.register(
      new WinRateTool({ llm: { invoke: () => '{"winner":"Problem A"}' }, rng: () => 0 })
    );
    const winResponse = await registry.execute('win_rate_evaluation', {
      generated_data_path: genPath,
      reference_data_path: genPath,
      output_dir: join(fixtureRoot, 'out', 'winrate')
    });
    expect(winResponse.text).toContain('胜率');
  });
});
