/**
 * Chapter 11 — RL datasets, reward functions and the training backend.
 *
 * 本章展示 v0.2.0 中可真实使用的 RL 能力边界：
 *  - GSM8K 数据集的本地加载与 SFT/RL 格式化（确定性、可离线复现）；
 *  - 数学奖励函数（Final Answer / #### / 数字容差 / 长度惩罚 / 步骤奖励）的
 *    确定性对照；
 *  - 训练后端通过 TrainingBackend adapter 显式桥接 Python/TRL：后端缺失时
 *    返回安装指导（BACKEND_UNAVAILABLE），绝不伪装训练完成。
 *
 * 真实训练需要本机 Python 环境（trl/torch/transformers/datasets），见
 * getInstallationGuide() 的输出。本示例在无后端时展示的是可观测的边界行为。
 */
import { heading } from './_shared.js';
import { formatForRl, formatForSft, splitGsm8kAnswer } from '../hello_agents/rl/datasets.js';
import {
  MathRewardFunction,
  createAccuracyReward,
  createLengthPenaltyReward,
  createStepReward,
  evaluateRewards
} from '../hello_agents/rl/rewards.js';
import {
  TRL_AVAILABLE,
  formatTrainingTime,
  getDeviceInfo,
  getInstallationGuide,
  probeTrainingBackend
} from '../hello_agents/rl/utils.js';
import { RLTrainingTool, trainWithSft } from '../hello_agents/tools/builtin/rl-training-tool.js';

const sampleAnswers = [
  'Let me add: 1+1=2\nFinal Answer: 2',
  'Multiply 2 by 3: 6\n#### 6',
  'I am not sure about this one.'
];

async function main(): Promise<void> {
  heading('Chapter 11 — RL datasets / rewards / training backend');

  // 1. 答案解析与确定性奖励对照
  const reward = new MathRewardFunction();
  const rewards = evaluateRewards(
    sampleAnswers,
    ['2', '6', '2'],
    createStepReward(createAccuracyReward(), 0.05)
  );
  console.log('per-sample rewards:', reward.call(sampleAnswers, { ground_truth: ['2', '6', '2'] }));
  console.log('evaluateRewards:', JSON.stringify(rewards, null, 2));

  const accuracy = createAccuracyReward();
  const withLengthPenalty = createLengthPenaltyReward(accuracy, 64, 0.02);
  console.log(
    'length-penalty rewards:',
    withLengthPenalty(sampleAnswers, { ground_truth: ['2', '6', '2'] })
  );

  // 2. 本地数据集与模板格式化（确定性，不依赖网络）
  const { reasoning, finalAnswer } = splitGsm8kAnswer('Step by step.\n#### 7');
  console.log('splitGsm8kAnswer:', { reasoning, finalAnswer });
  console.log(
    'formatForSft:',
    JSON.stringify(formatForSft('What is 3+4?', 'Add.\n#### 7'), null, 2)
  );
  console.log('formatForRl:', JSON.stringify(formatForRl('What is 3+4?', 'Add.\n#### 7'), null, 2));

  // 3. 后端探测：展示真实能力边界（不 mock）
  const probe = probeTrainingBackend('python3');
  console.log('TRL_AVAILABLE:', TRL_AVAILABLE);
  console.log('backend probe:', JSON.stringify(probe, null, 2));
  console.log('device info:', JSON.stringify(getDeviceInfo(), null, 2));
  console.log('estimated time format:', formatTrainingTime(7325));

  if (!probe.available) {
    console.log('\n[安装指导] 本机缺少 Python 训练后端：\n' + getInstallationGuide());
  } else {
    console.log('\nPython 训练后端可用，可直接执行 train_with_sft / train_with_grpo。');
  }

  // 4. 工具层：缺后端时返回 BACKEND_UNAVAILABLE（绝不伪装完成）
  const tool = new RLTrainingTool({ dataDir: './examples/data/gsm8k' });
  const createReward = await tool.execute({ action: 'create_reward', reward_type: 'step' });
  console.log('create_reward:', JSON.stringify(createReward.toJSON(), null, 2));

  const evalRes = await tool.execute({
    action: 'evaluate',
    model_name: 'Qwen/Qwen3-0.6B',
    max_samples: 2,
    generateCompletions: (prompts: string[]) => prompts.map(() => 'Final Answer: 2')
  });
  console.log('evaluate:', JSON.stringify(evalRes.toJSON(), null, 2));

  // 便捷函数走同一公共入口；无后端时给出安装指引而非假成功
  const trainRes = await trainWithSft({
    dataDir: './examples/data/gsm8k',
    maxSamples: 2,
    numEpochs: 1
  });
  console.log('trainWithSft:', JSON.stringify(trainRes.toJSON(), null, 2));
  if (trainRes.status === 'error') {
    console.log('→ 按上述安装指导准备 Python 环境后重试即可，数据与奖励逻辑已在本包内确定性复刻。');
  }
}

void main();
