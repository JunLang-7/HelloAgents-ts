import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolRegistry } from '../hello_agents/tools/index.js';
import {
  RLTrainingTool,
  evaluateModel,
  trainWithGrpo,
  trainWithSft
} from '../hello_agents/tools/builtin/rl-training-tool.js';
import type { TrainingBackend, TrainingResult } from '../hello_agents/rl/trainers.js';
import {
  GRPOTrainerWrapper,
  PPOTrainerWrapper,
  SFTTrainerWrapper
} from '../hello_agents/rl/trainers.js';
import {
  MathRewardFunction,
  createAccuracyReward,
  createLengthPenaltyReward,
  createStepReward,
  evaluateRewards
} from '../hello_agents/rl/rewards.js';
import {
  GSM8KDataset,
  createRlDataset,
  formatForRl,
  formatForSft,
  splitGsm8kAnswer
} from '../hello_agents/rl/datasets.js';
import {
  formatTrainingTime,
  getDeviceInfo,
  getInstallationGuide,
  probeTrainingBackend,
  resetTrainingBackendProbe,
  trainingConfig
} from '../hello_agents/rl/utils.js';

let fixtureRoot: string;

function writeFixture(name: string, content: string): string {
  const p = join(fixtureRoot, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

/** 可注入的 mock 训练后端（验证 adapter 边界，不冒充真实训练）。 */
class MockTrainingBackend implements TrainingBackend {
  public readonly kind = 'mock';
  public calls: TrainingResult[] = [];
  public constructor(private readonly result: TrainingResult) {}
  public available(): boolean {
    return true;
  }
  public train(request: Parameters<TrainingBackend['train']>[0]): TrainingResult {
    void request;
    this.calls.push(this.result);
    return this.result;
  }
}

const GSM8K_RAW = [
  { question: 'What is 1+1?', answer: 'Step 1: add.\n#### 2' },
  { question: 'What is 2*3?', answer: 'Multiply.\n#### 6' },
  { question: 'How many?', answer: 'Count.\n#### 10' }
];

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'helloagents-rl-'));
  writeFixture(
    'gsm8k_train.json',
    JSON.stringify([...GSM8K_RAW, { question: 'Bad one', answer: 42 }])
  );
  writeFixture(
    'gsm8k_test.json',
    JSON.stringify([
      { question: 'Test Q1', answer: 'T.\n#### 42' },
      { question: 'Test Q2', answer: 'U.\n#### 99' }
    ])
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  resetTrainingBackendProbe();
});

/* -------------------------------------------------------------------------- */
/* rewards：确定性对照测试（验收 1）                                            */
/* -------------------------------------------------------------------------- */

describe('MathRewardFunction（确定性对照）', () => {
  test('extractAnswer 支持全部上游格式', () => {
    const fn = new MathRewardFunction();
    expect(fn.extractAnswer('Let me think.\nFinal Answer: 42')).toBe('42');
    expect(fn.extractAnswer('reasoning\n#### 7')).toBe('7');
    expect(fn.extractAnswer('答案是：13')).toBe('13');
    expect(fn.extractAnswer('Therefore, the answer is 99')).toBe('99');
    expect(fn.extractAnswer('no marker here\nfinal line 5')).toBe('5');
    expect(fn.extractAnswer('nothing numeric')).toBeNull();
  });

  test('normalizeAnswer 去除千分位/货币/百分号并取首个数字', () => {
    const fn = new MathRewardFunction();
    expect(fn.normalizeAnswer('1,234')).toBe(1234);
    expect(fn.normalizeAnswer('$42.5')).toBe(42.5);
    expect(fn.normalizeAnswer('75%')).toBe(75);
    expect(fn.normalizeAnswer('-3')).toBe(-3);
    expect(fn.normalizeAnswer('abc')).toBeNull();
  });

  test('compareAnswers 数值容差与字符串回退', () => {
    const fn = new MathRewardFunction(1e-4);
    expect(fn.compareAnswers('2.0', '2')).toBe(true);
    expect(fn.compareAnswers('2.0002', '2')).toBe(false);
    expect(fn.compareAnswers('apple', 'Apple')).toBe(true);
    expect(fn.compareAnswers('3', '2')).toBe(false);
  });

  test('call 返回 1.0/0.0 且缺 ground_truth 报错', () => {
    const fn = new MathRewardFunction();
    const rewards = fn.call(
      ['Step 1: 1+1=2\nFinal Answer: 2', 'I do not know', 'Final Answer: 5'],
      { ground_truth: ['2', '2', '2'] }
    );
    expect(rewards).toEqual([1, 0, 0]);
    expect(() => fn.call(['x'])).toThrow(/ground_truth/);
  });

  test('createLengthPenaltyReward 超长扣分且不跌破 0', () => {
    const base = createAccuracyReward();
    const fn = createLengthPenaltyReward(base, 20, 0.1);
    const short = 'Final Answer: 2';
    const long = 'Final Answer: 2' + 'x'.repeat(30);
    const [rShort, rLong] = fn([short, long], { ground_truth: ['2', '2'] });
    expect(rShort).toBe(1);
    expect(rLong).toBeGreaterThan(0);
    expect(rLong).toBeLessThan(1);
  });

  test('createStepReward 步骤奖励封顶 0.5', () => {
    const base = createAccuracyReward();
    const fn = createStepReward(base, 0.1);
    const completions = ['Final Answer: 2', 'a\nb\nc\nd\ne\nf\ng\nh\nFinal Answer: 2'];
    const rewards = fn(completions, { ground_truth: ['2', '2'] });
    // 对齐上游 count('\n')：无换行不奖励
    expect(rewards[0]).toBe(1);
    expect(rewards[1]).toBe(1.5);
  });

  test('evaluateRewards 统计汇总', () => {
    const result = evaluateRewards(
      ['Final Answer: 2', 'wrong', 'Final Answer: 6'],
      ['2', '2', '6'],
      createAccuracyReward()
    );
    expect(result.mean_reward).toBeCloseTo(2 / 3);
    expect(result.max_reward).toBe(1);
    expect(result.min_reward).toBe(0);
    expect(result.accuracy).toBeCloseTo(2 / 3);
    expect(result.num_samples).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* datasets：确定性对照测试（验收 1）                                            */
/* -------------------------------------------------------------------------- */

describe('RL datasets（确定性对照）', () => {
  test('splitGsm8kAnswer 提取推理与最终答案', () => {
    const { reasoning, finalAnswer } = splitGsm8kAnswer('Step by step.\n#### 42');
    expect(reasoning).toBe('Step by step.');
    expect(finalAnswer).toBe('42');
    expect(splitGsm8kAnswer('no marker').finalAnswer).toBe('');
  });

  test('formatForSft / formatForRl 模板对齐上游', () => {
    const sft = formatForSft('Q?', 'R\n#### 7');
    expect(sft.prompt).toBe("Question: Q?\n\nLet's solve this step by step:\n");
    expect(sft.completion).toBe('R\n\nFinal Answer: 7');
    expect(sft.text).toBe(sft.prompt + sft.completion);
    const rl = formatForRl('Q?', 'R\n#### 7');
    expect(rl.prompt).toContain('Question: Q?');
    expect(rl.ground_truth).toBe('7');
    expect(rl.full_answer).toBe('R\n#### 7');
  });

  test('formatForRl 支持 chatTemplate 注入（对齐 tokenizer）', () => {
    const rl = formatForRl(
      'Q?',
      '#### 7',
      (messages) => `<|im_start|>user\n${messages[0]!.content}<|im_end|>`
    );
    expect(rl.prompt).toContain('<|im_start|>user');
    expect(rl.prompt).toContain('Question: Q?');
  });

  test('GSM8KDataset 按 split 过滤文件（train 不混入 test）', () => {
    const train = new GSM8KDataset({ dataDir: fixtureRoot, split: 'train', format_type: 'sft' });
    const trainItems = train.getDataset();
    expect(trainItems.length).toBe(4); // GSM8K_RAW 3 条 + 数字 answer 的坏行（answer 置空仍入列）
    const test = new GSM8KDataset({ dataDir: fixtureRoot, split: 'test', format_type: 'sft' });
    const testItems = test.getDataset();
    expect(testItems.length).toBe(2);
    expect((testItems[0] as { prompt: string }).prompt).toContain('Test Q1');
    // 无匹配 split 报错并提示命名
    expect(() =>
      new GSM8KDataset({ dataDir: fixtureRoot, split: 'valid', format_type: 'sft' }).getDataset()
    ).toThrow(/valid/);
  });

  test('GSM8KDataset 本地 JSON 加载并应用 max_samples', () => {
    const dataset = new GSM8KDataset({ dataDir: fixtureRoot, max_samples: 2, format_type: 'sft' });
    const items = dataset.getDataset();
    expect(items.length).toBe(2);
    expect((items[0] as { prompt: string }).prompt).toContain('Question: What is 1+1?');
    // 数字 answer（坏行形态）不抛错
    const all = new GSM8KDataset({ dataDir: fixtureRoot }).getDataset();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  test('GSM8KDataset 远程下载明确报错并给指引（不 mock）', () => {
    const dataset = new GSM8KDataset();
    expect(() => dataset.getDataset()).toThrow(/openai\/gsm8k/);
  });

  test('createRlDataset RL 格式含 ground_truth', () => {
    const items = createRlDataset(10, 'train', { dataDir: fixtureRoot });
    const first = items[0] as { ground_truth: string };
    expect(first.ground_truth).toBe('2');
  });
});

/* -------------------------------------------------------------------------- */
/* utils + trainers：adapter 边界（验收 2/3）                                    */
/* -------------------------------------------------------------------------- */

describe('rl utils 与训练后端边界', () => {
  test('trainingConfig 默认值对齐上游', () => {
    const cfg = trainingConfig();
    expect(cfg.model_name).toBe('Qwen/Qwen3-0.6B');
    expect(cfg.num_train_epochs).toBe(3);
    expect(cfg.per_device_train_batch_size).toBe(4);
    expect(cfg.learning_rate).toBe(5e-5);
    expect(cfg.use_lora).toBe(true);
    expect(cfg.seed).toBe(42);
    expect(trainingConfig({ model_name: 'x' }).model_name).toBe('x');
  });

  test('formatTrainingTime 对齐上游', () => {
    expect(formatTrainingTime(30)).toBe('30s');
    expect(formatTrainingTime(125)).toBe('2m 5s');
    expect(formatTrainingTime(7325)).toBe('2h 2m 5s');
  });

  test('probeTrainingBackend 真实探测本机（不 mock）', () => {
    resetTrainingBackendProbe();
    const probe = probeTrainingBackend('python3');
    // 断言结构而非特定值：真实探测结果，CI 与本地都应稳定
    expect(typeof probe.available).toBe('boolean');
    expect(probe.python).toBe('python3');
    if (!probe.available) {
      expect(probe.reason).toBeTruthy();
    }
  });

  test('探测缓存按解释器分键，不同 python 不互相污染', () => {
    resetTrainingBackendProbe();
    const a = probeTrainingBackend('definitely-not-a-python');
    expect(a.available).toBe(false);
    // 再次探测真实 python3：不得复用刚才失败的缓存（对象不同）
    const b = probeTrainingBackend('python3');
    expect(b.python).toBe('python3');
    expect(b).not.toBe(a);
    // 同一解释器命中缓存（对象相同）
    const b2 = probeTrainingBackend('python3');
    expect(b2).toBe(b);
  });

  test('getDeviceInfo 无后端时返回 CUDA 不可用', () => {
    const info = getDeviceInfo();
    expect(typeof info.cuda_available).toBe('boolean');
    expect(info.cuda_device_count).toBe(0);
  });

  test('getInstallationGuide 包含 pip 命令', () => {
    const guide = getInstallationGuide();
    expect(guide).toContain('pip install trl');
    expect(guide).toContain('huggingface.co/docs/trl');
  });

  test('SFT/GRPO 训练器经注入 backend 执行（adapter 边界）', () => {
    const sftBackend = new MockTrainingBackend({
      status: 'success',
      algorithm: 'sft',
      model: 'mock-model',
      output_dir: '/tmp/out',
      num_epochs: 1,
      dataset_size: 2,
      backend: 'mock'
    });
    const sft = new SFTTrainerWrapper({
      config: { model_name: 'mock-model', output_dir: '/tmp/out' },
      dataset: [{ prompt: 'p', completion: 'c', text: 'pc' }],
      backend: sftBackend
    });
    const sftResult = sft.train();
    expect(sftResult.status).toBe('success');
    expect(sftResult.algorithm).toBe('sft');
    expect(sftBackend.calls.length).toBe(1);

    const grpoBackend = new MockTrainingBackend({
      status: 'success',
      algorithm: 'grpo',
      model: 'mock-model',
      output_dir: '/tmp/out',
      num_epochs: 1,
      dataset_size: 1,
      backend: 'mock'
    });
    const grpo = new GRPOTrainerWrapper({
      config: { model_name: 'mock-model', output_dir: '/tmp/out' },
      dataset: [{ prompt: 'p', ground_truth: '7', question: 'q', full_answer: 'a' }],
      rewardType: 'accuracy',
      backend: grpoBackend
    });
    const grpoResult = grpo.train();
    expect(grpoResult.status).toBe('success');
    expect(grpoResult.algorithm).toBe('grpo');
    expect(grpoBackend.calls.length).toBe(1);
  });

  test('训练器缺数据集报错；PPO 明确未实现', () => {
    const backend = new MockTrainingBackend({
      status: 'success',
      algorithm: 'sft',
      model: 'm',
      output_dir: '/tmp',
      num_epochs: 1,
      dataset_size: 0,
      backend: 'mock'
    });
    const sft = new SFTTrainerWrapper({ config: {}, dataset: [], backend });
    expect(() => sft.train()).toThrow(/数据集未设置/);
    const ppo = new PPOTrainerWrapper({ config: {}, dataset: [], backend });
    expect(() => ppo.train()).toThrow(/PPO训练器尚未实现/);
  });

  test('后端不可用时抛 TrainingBackendUnavailableError 并含安装指导', () => {
    // 用不可用后端模拟（真实探测；若本机恰好有 trl 则跳过真实断言路径）
    resetTrainingBackendProbe();
    const probe = probeTrainingBackend('python3');
    if (!probe.available) {
      const backend: TrainingBackend = {
        kind: 'unavailable',
        available: () => false,
        train: () => {
          throw new Error('should not reach');
        }
      };
      expect(() => new SFTTrainerWrapper({ config: {}, dataset: [], backend })).toThrow(
        /pip install trl/
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* RLTrainingTool：工具可调用 + 缺后端指引（验收 3/4）                           */
/* -------------------------------------------------------------------------- */

describe('RLTrainingTool（ToolRegistry 可调用）', () => {
  test('create_reward 三种类型返回成功', async () => {
    const tool = new RLTrainingTool();
    const accuracy = await tool.execute({ action: 'create_reward', reward_type: 'accuracy' });
    expect(accuracy.status).toBe('success');
    expect(accuracy.data?.reward_type).toBe('accuracy');
    const lengthPenalty = await tool.execute({
      action: 'create_reward',
      reward_type: 'length_penalty'
    });
    expect(lengthPenalty.status).toBe('success');
    const step = await tool.execute({ action: 'create_reward', reward_type: 'step' });
    expect(step.status).toBe('success');
  });

  test('load_dataset 缺本地数据目录时明确报错', async () => {
    const tool = new RLTrainingTool();
    const res = await tool.execute({ action: 'load_dataset', format: 'sft' });
    expect(res.status).toBe('error');
    expect(String(res.text)).toContain('data_dir');
  });

  test('load_dataset 从本地 fixture 加载并返回 sample_keys', async () => {
    const tool = new RLTrainingTool({ dataDir: fixtureRoot });
    const res = await tool.execute({ action: 'load_dataset', format: 'rl', max_samples: 3 });
    expect(res.status).toBe('success');
    expect(res.data?.dataset_size).toBe(3);
    expect(res.data?.sample_keys).toContain('ground_truth');
  });

  test('evaluate 注入 generateCompletions 验证纯逻辑（不 mock 后端）', async () => {
    const tool = new RLTrainingTool({
      dataDir: fixtureRoot,
      generateCompletions: (prompts) => prompts.map(() => 'Final Answer: 2')
    });
    const res = await tool.execute({ action: 'evaluate', model_name: 'mock', max_samples: 3 });
    expect(res.status).toBe('success');
    // 评估使用 test 集（42/99），注入答案均为 2 → 0 命中，不泄漏训练集
    expect(res.data?.num_samples).toBe(2);
    expect(String(res.data?.accuracy)).toBe('0.00%');
  });

  test('train 经 mock backend 成功（adapter 边界）', async () => {
    const backend = new MockTrainingBackend({
      status: 'success',
      algorithm: 'sft',
      model: 'mock',
      output_dir: './output',
      num_epochs: 1,
      dataset_size: 2,
      backend: 'mock'
    });
    const tool = new RLTrainingTool({ backend, dataDir: fixtureRoot });
    const res = await tool.execute({ action: 'train', algorithm: 'sft', max_samples: 2 });
    expect(res.status).toBe('success');
    expect(res.data?.algorithm).toBe('SFT');
  });

  test('train 缺数据目录明确报错（不 mock 成完成）', async () => {
    const backend = new MockTrainingBackend({
      status: 'success',
      algorithm: 'sft',
      model: 'm',
      output_dir: './output',
      num_epochs: 1,
      dataset_size: 0,
      backend: 'mock'
    });
    const tool = new RLTrainingTool({ backend });
    const res = await tool.execute({ action: 'train', algorithm: 'sft' });
    expect(res.status).toBe('error');
    expect(String(res.text)).toContain('data_dir');
  });

  test('可从 ToolRegistry 调用', async () => {
    const registry = new ToolRegistry();
    const tool = new RLTrainingTool({ dataDir: fixtureRoot });
    registry.register(tool);
    const found = registry.get('rl_training');
    expect(found).toBe(tool);
    const res = await tool.execute({ action: 'create_reward', reward_type: 'accuracy' });
    expect(res.status).toBe('success');
  });

  test('registerDataset 后可通过工具按名使用（自定义数据集生效）', async () => {
    const tool = new RLTrainingTool({ dataDir: fixtureRoot });
    // 注册已格式化样本（对齐上游 HuggingFace Dataset 语义：训练直接用）
    tool.registerDataset('my-math', [
      { prompt: 'Custom Q', ground_truth: '7', question: 'Custom Q', full_answer: 'C.\n#### 7' }
    ]);
    const res = await tool.execute({ action: 'load_dataset', dataset: 'my-math', format: 'rl' });
    expect(res.status).toBe('success');
    expect(res.data?.dataset_size).toBe(1);
    expect(res.data?.sample_keys).toContain('ground_truth');
    // 未注册的名字仍明确报错
    const missing = await tool.execute({ action: 'load_dataset', dataset: 'nope', format: 'sft' });
    expect(missing.status).toBe('error');
    expect(String(missing.text)).toContain('不支持的数据集');
  });

  test('registerRewardFunction 生效：evaluate 使用注册函数，GRPO train 诚实报错', async () => {
    const tool = new RLTrainingTool({
      dataDir: fixtureRoot,
      generateCompletions: (prompts: string[]) => prompts.map(() => 'Final Answer: 42')
    });
    // 注册固定 0.5 的函数：若被真正使用，accuracy=50%（默认 accuracy 会不同）
    tool.registerRewardFunction('strict-42', (completions) => completions.map(() => 0.5));
    const evalRes = await tool.execute({
      action: 'evaluate',
      model_name: 'mock',
      reward_function: 'strict-42',
      max_samples: 2
    });
    expect(evalRes.status).toBe('success');
    expect(String(evalRes.data?.accuracy)).toBe('50.00%');
    // create_reward 可引用注册名
    const createRes = await tool.execute({ action: 'create_reward', reward_type: 'strict-42' });
    expect(createRes.status).toBe('success');
    expect(createRes.data?.registered).toBe(true);
    // GRPO train 用自定义奖励 → 明确跨进程边界报错（不静默忽略）
    const backend = new MockTrainingBackend({
      status: 'success',
      algorithm: 'grpo',
      model: 'm',
      output_dir: './output',
      num_epochs: 1,
      dataset_size: 2,
      backend: 'mock'
    });
    const trainTool = new RLTrainingTool({ backend, dataDir: fixtureRoot });
    trainTool.registerRewardFunction('strict-42', (completions) => completions.map(() => 1));
    const trainRes = await trainTool.execute({
      action: 'train',
      algorithm: 'grpo',
      reward_type: 'strict-42',
      max_samples: 2
    });
    expect(trainRes.status).toBe('error');
    expect(trainRes.errorInfo?.code).toBe('CUSTOM_REWARD_BACKEND_BOUNDARY');
    // 未注册的 reward_type 也明确报错（不静默回退 accuracy）
    const unknownRes = await trainTool.execute({
      action: 'train',
      algorithm: 'grpo',
      reward_type: 'no-such-reward',
      max_samples: 2
    });
    expect(unknownRes.status).toBe('error');
    expect(unknownRes.errorInfo?.code).toBe('UNKNOWN_REWARD_FUNCTION');
  });

  test('便捷函数 trainWithSft / trainWithGrpo / evaluateModel', async () => {
    const sftRes = await trainWithSft({ dataDir: fixtureRoot, maxSamples: 2, numEpochs: 1 });
    // 默认 backend 为 Python 桥接：本机无 trl → BACKEND_UNAVAILABLE 指引
    expect(sftRes.status).toBe('error');
    expect(sftRes.errorInfo?.code).toBe('BACKEND_UNAVAILABLE');
    const grpoRes = await trainWithGrpo({ dataDir: fixtureRoot, maxSamples: 2 });
    expect(grpoRes.errorInfo?.code).toBe('BACKEND_UNAVAILABLE');
    const evalRes = await evaluateModel({
      dataDir: fixtureRoot,
      maxSamples: 2,
      generateCompletions: (prompts) => prompts.map(() => 'Final Answer: 42')
    });
    expect(evalRes.status).toBe('success');
    // test 集 2 条，注入答案 42 命中 1 条
    expect(evalRes.data?.num_samples).toBe(2);
    expect(String(evalRes.data?.accuracy)).toBe('50.00%');
  });
});
