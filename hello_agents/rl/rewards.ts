/**
 * RL 训练奖励函数（对齐上游 `rl/rewards.py`）。
 *
 * 纯数据处理逻辑，具备确定性对照测试：
 * 答案提取、数值归一化、容差比较、长度惩罚、步骤奖励与批量评估。
 */

/** 奖励函数签名（对齐上游 `Callable`：入参 completions + kwargs）。 */
export type RewardFunction = (completions: string[], kwargs?: Record<string, unknown>) => number[];

const ANSWER_PATTERNS: RegExp[] = [
  /Final Answer:\s*([^\n]+)/i,
  /####\s*([^\n]+)/i,
  /答案是?\s*[:：]?\s*([^\n]+)/i,
  /Therefore,?\s*(?:the answer is)?\s*([^\n]+)/i
];

export class MathRewardFunction {
  /** 数值比较的容差。 */
  public readonly tolerance: number;
  public readonly name: string;

  public constructor(tolerance = 1e-4) {
    this.tolerance = tolerance;
    this.name = 'MathRewardFunction';
  }

  /** 从文本中提取答案（对齐上游 `extract_answer`）。 */
  public extractAnswer(text: string): string | null {
    for (const pattern of ANSWER_PATTERNS) {
      const match = pattern.exec(text);
      if (match?.[1] !== undefined && match[1] !== '') {
        return match[1].trim();
      }
    }
    const lines = text.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      const numbers = line.match(/-?\d+\.?\d*/g);
      if (numbers && numbers.length > 0) {
        return numbers[numbers.length - 1] ?? null;
      }
    }
    return null;
  }

  /** 标准化答案为数值（对齐上游 `normalize_answer`）。 */
  public normalizeAnswer(answer: string | null): number | null {
    if (answer === null) return null;
    const cleaned = answer.trim().replace(/,/g, '').replace(/\$/g, '').replace(/%/g, '');
    const numbers = cleaned.match(/-?\d+\.?\d*/g);
    if (!numbers || numbers.length === 0) return null;
    const parsed = Number(numbers[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** 比较预测与真实答案（对齐上游 `compare_answers`）。 */
  public compareAnswers(pred: string, truth: string): boolean {
    const predNum = this.normalizeAnswer(pred);
    const truthNum = this.normalizeAnswer(truth);
    if (predNum === null || truthNum === null) {
      return pred.trim().toLowerCase() === truth.trim().toLowerCase();
    }
    return Math.abs(predNum - truthNum) < this.tolerance;
  }

  /** 计算奖励（1.0 正确 / 0.0 错误；缺失 ground_truth 报错）。 */
  public call(completions: string[], kwargs?: Record<string, unknown>): number[] {
    const groundTruths = kwargs?.ground_truth;
    if (!Array.isArray(groundTruths)) {
      throw new Error('ground_truth必须在数据集中提供');
    }
    const rewards: number[] = [];
    for (let i = 0; i < completions.length; i += 1) {
      const completion = completions[i] ?? '';
      const truth = groundTruths[i];
      const predAnswer = this.extractAnswer(completion);
      rewards.push(
        predAnswer !== null && typeof truth === 'string' && this.compareAnswers(predAnswer, truth)
          ? 1.0
          : 0.0
      );
    }
    return rewards;
  }
}

/** 创建准确性奖励函数（对齐上游 `create_accuracy_reward`）。 */
export function createAccuracyReward(tolerance = 1e-4): RewardFunction {
  const fn = new MathRewardFunction(tolerance);
  return (completions: string[], kwargs?: Record<string, unknown>) => fn.call(completions, kwargs);
}

/** 创建带长度惩罚的奖励函数（对齐上游 `create_length_penalty_reward`）。 */
export function createLengthPenaltyReward(
  baseRewardFn: RewardFunction,
  maxLength = 1024,
  penaltyWeight = 0.1
): RewardFunction {
  return (completions: string[], kwargs?: Record<string, unknown>): number[] => {
    const baseRewards = baseRewardFn(completions, kwargs);
    const finalRewards: number[] = [];
    for (let i = 0; i < baseRewards.length; i += 1) {
      let reward = baseRewards[i] ?? 0;
      const length = completions[i]?.length ?? 0;
      if (length > maxLength) {
        const penalty = (penaltyWeight * (length - maxLength)) / maxLength;
        reward = Math.max(0.0, reward - penalty);
      }
      finalRewards.push(reward);
    }
    return finalRewards;
  };
}

/** 创建带步骤奖励的函数（鼓励详细推理；对齐上游 `create_step_reward`）。 */
export function createStepReward(baseRewardFn: RewardFunction, stepBonus = 0.1): RewardFunction {
  return (completions: string[], kwargs?: Record<string, unknown>): number[] => {
    const baseRewards = baseRewardFn(completions, kwargs);
    const finalRewards: number[] = [];
    for (let i = 0; i < baseRewards.length; i += 1) {
      const base = baseRewards[i] ?? 0;
      // 对齐上游 count('\n')：无换行不奖励
      const numSteps = (completions[i]?.match(/\n/g) ?? []).length;
      const stepReward = Math.min(stepBonus * numSteps, 0.5);
      finalRewards.push(base + stepReward);
    }
    return finalRewards;
  };
}

/** 评估奖励函数性能（对齐上游 `evaluate_rewards`）。 */
export function evaluateRewards(
  completions: string[],
  groundTruths: string[],
  rewardFn: RewardFunction
): {
  mean_reward: number;
  max_reward: number;
  min_reward: number;
  accuracy: number;
  num_samples: number;
} {
  const rewards = rewardFn(completions, { ground_truth: groundTruths });
  if (rewards.length === 0) {
    return { mean_reward: 0, max_reward: 0, min_reward: 0, accuracy: 0, num_samples: 0 };
  }
  return {
    mean_reward: rewards.reduce((a, b) => a + b, 0) / rewards.length,
    max_reward: Math.max(...rewards),
    min_reward: Math.min(...rewards),
    accuracy: rewards.filter((r) => r > 0.5).length / rewards.length,
    num_samples: rewards.length
  };
}
