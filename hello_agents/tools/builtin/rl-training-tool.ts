/**
 * RL 训练工具（对齐上游 `tools/builtin/rl_training_tool.py`）。
 *
 * 支持动作：train（sft/grpo）、load_dataset（sft/rl）、create_reward、
 * evaluate。训练经 `TrainingBackend` 边界执行（默认 Python 桥接，可注入
 * mock）；后端缺失时返回明确安装/配置指导，不伪装为已执行训练（DIFF-046）。
 */

import { z } from 'zod';

import { Tool } from '../tool.js';
import { ToolResponse } from '../response.js';
import {
  createAccuracyReward,
  createLengthPenaltyReward,
  createStepReward,
  evaluateRewards
} from '../../rl/rewards.js';
import { GSM8KDataset } from '../../rl/datasets.js';
import type { Gsm8kExample, RlExample } from '../../rl/datasets.js';
import {
  GRPOTrainerWrapper,
  PythonTrainingBackend,
  SFTTrainerWrapper,
  TrainingBackendUnavailableError
} from '../../rl/trainers.js';
import type { TrainingBackend, TrainingResult } from '../../rl/trainers.js';
import { getInstallationGuide, trainingConfig } from '../../rl/utils.js';
import type { RewardFunction } from '../../rl/rewards.js';

const rlInputSchema = z
  .object({
    action: z.enum(['train', 'load_dataset', 'create_reward', 'evaluate']).default('train'),
    algorithm: z.enum(['sft', 'grpo']).default('sft'),
    model_name: z.string().default('Qwen/Qwen2-0.5B-Instruct'),
    dataset: z.string().default('gsm8k'),
    format: z.enum(['sft', 'rl']).default('sft'),
    split: z.string().default('train'),
    reward_type: z.string().default('accuracy'),
    reward_function: z.string().optional(),
    max_samples: z.number().int().nonnegative().optional(),
    num_epochs: z.number().int().positive().default(3),
    output_dir: z.string().default('./output'),
    use_lora: z.boolean().default(true),
    batch_size: z.number().int().positive().default(4),
    data_dir: z.string().optional()
  })
  .strict();

type RlInput = z.output<typeof rlInputSchema>;

export interface RLTrainingToolOptions {
  /** 训练后端（默认 Python 桥接；测试可注入 mock）。 */
  backend?: TrainingBackend;
  /** GSM8K 本地数据目录（train/load_dataset 需要）。 */
  dataDir?: string;
  /** 评估时生成预测的回调（默认 Python 桥接；注入以验证纯逻辑）。 */
  generateCompletions?: (prompts: string[]) => string[] | Promise<string[]>;
}

export class RLTrainingTool extends Tool<typeof rlInputSchema> {
  public readonly backend: TrainingBackend;
  public readonly dataDir: string | undefined;
  private readonly generateCompletionsImpl: (prompts: string[]) => Promise<string[]>;
  private customDatasets: Record<string, unknown[]> = {};
  private customRewardFunctions: Record<string, RewardFunction> = {};

  public constructor(options: RLTrainingToolOptions = {}) {
    super({
      name: 'rl_training',
      description:
        '强化学习训练工具。支持SFT、GRPO等算法，用于训练和优化语言模型的推理能力。' +
        '也支持数据集加载、奖励函数创建、模型评估等功能。支持自定义数据集和奖励函数。',
      inputSchema: rlInputSchema
    });
    this.backend = options.backend ?? new PythonTrainingBackend();
    this.dataDir = options.dataDir;
    const defaultGenerate = async (): Promise<string[]> => {
      if (!this.backend.available()) {
        throw new TrainingBackendUnavailableError(getInstallationGuide());
      }
      // 默认经 Python 推理（后端边界）；实现见 rl-training 的推理脚本
      throw new Error(
        '默认模型推理需要 Python 环境（transformers）。请注入 generateCompletions 回调，' +
          '或先安装训练后端（见安装指导）。'
      );
    };
    this.generateCompletionsImpl =
      options.generateCompletions !== undefined
        ? async (prompts: string[]) => await options.generateCompletions!(prompts)
        : defaultGenerate;
  }

  /** 注册自定义数据集（对齐上游 `register_dataset`）。 */
  public registerDataset(name: string, dataset: unknown[]): void {
    this.customDatasets[name] = dataset;
    console.log(`✅ 已注册自定义数据集: ${name}`);
  }

  /** 注册自定义奖励函数（对齐上游 `register_reward_function`）。 */
  public registerRewardFunction(name: string, rewardFn: RewardFunction): void {
    this.customRewardFunctions[name] = rewardFn;
    console.log(`✅ 已注册自定义奖励函数: ${name}`);
  }

  protected async run(input: RlInput): Promise<ToolResponse> {
    try {
      switch (input.action) {
        case 'train':
          return await this.handleTrain(input);
        case 'load_dataset':
          return this.handleLoadDataset(input);
        case 'create_reward':
          return this.handleCreateReward(input);
        case 'evaluate':
          return await this.handleEvaluate(input);
        default: {
          const exhaustive: never = input.action;
          throw new Error(`不支持的操作: ${String(exhaustive)}`);
        }
      }
    } catch (error) {
      if (error instanceof TrainingBackendUnavailableError) {
        return ToolResponse.fromObject({
          status: 'error',
          text: error.guide,
          data: {},
          error: { code: 'BACKEND_UNAVAILABLE', message: error.guide }
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return ToolResponse.fromObject({
        status: 'error',
        text: message,
        data: {},
        error: { code: 'OPERATION_FAILED', message }
      });
    }
  }

  private loadDatasetForTraining(input: RlInput, format: 'sft' | 'rl'): unknown[] {
    if (this.customDatasets[input.dataset]) {
      return this.customDatasets[input.dataset]!;
    }
    if (input.dataset !== 'gsm8k') {
      throw new Error(
        `不支持的数据集: ${input.dataset}。支持: gsm8k 或已注册的自定义数据集（registerDataset）。`
      );
    }
    const dataDir = input.data_dir ?? this.dataDir;
    if (!dataDir) {
      throw new Error(
        '缺少本地 GSM8K 数据目录（data_dir）。TS 端不内置 HuggingFace 下载，' +
          '请提供本地数据目录（JSON/JSONL 含 question/answer 字段）。'
      );
    }
    const dataset = new GSM8KDataset({
      split: input.split,
      ...(input.max_samples !== undefined ? { max_samples: input.max_samples } : {}),
      format_type: format,
      dataDir
    });
    return dataset.getDataset();
  }

  private async handleTrain(input: RlInput): Promise<ToolResponse> {
    const algorithm = input.algorithm;
    const config = trainingConfig({
      model_name: input.model_name,
      output_dir: input.output_dir,
      num_train_epochs: input.num_epochs,
      per_device_train_batch_size: input.batch_size,
      use_lora: input.use_lora
    });
    const sftData = this.loadDatasetForTraining(input, 'sft');
    const rlData = this.loadDatasetForTraining(input, 'rl');
    let result: TrainingResult;
    if (algorithm === 'sft') {
      const wrapper = new SFTTrainerWrapper({
        config,
        dataset: sftData as Gsm8kExample[],
        backend: this.backend
      });
      result = wrapper.train();
    } else {
      if (this.customRewardFunctions[input.reward_type]) {
        return ToolResponse.fromObject({
          status: 'error',
          text:
            `自定义奖励函数 '${input.reward_type}' 无法跨 Python 训练后端执行。` +
            '真实 GRPO 训练仅支持内置 reward_type: accuracy / length_penalty / step；' +
            '自定义奖励函数可配合 evaluate 的 reward_function 参数使用。',
          data: {},
          error: {
            code: 'CUSTOM_REWARD_BACKEND_BOUNDARY',
            message: '自定义奖励函数无法跨 Python 训练后端执行'
          }
        });
      }
      if (!['accuracy', 'length_penalty', 'step'].includes(input.reward_type)) {
        return ToolResponse.fromObject({
          status: 'error',
          text: `未注册的自定义奖励函数: ${input.reward_type}（先调用 registerRewardFunction）`,
          data: {},
          error: { code: 'UNKNOWN_REWARD_FUNCTION', message: `未注册: ${input.reward_type}` }
        });
      }
      const wrapper = new GRPOTrainerWrapper({
        config,
        dataset: rlData as Gsm8kExample[],
        rewardType: input.reward_type as 'accuracy' | 'length_penalty' | 'step',
        backend: this.backend
      });
      result = wrapper.train();
    }
    if (result.status === 'error') {
      return ToolResponse.fromObject({
        status: 'error',
        text: result.error ?? '训练失败',
        data: result,
        error: { code: 'TRAIN_FAILED', message: result.error ?? '训练失败' }
      });
    }
    return ToolResponse.fromObject({
      status: 'success',
      text: `训练完成：${result.algorithm.toUpperCase()} (模型 ${result.model}，${result.dataset_size} 样本，输出 ${result.output_dir})`,
      data: { ...result, algorithm: result.algorithm.toUpperCase() }
    });
  }

  private handleLoadDataset(input: RlInput): ToolResponse {
    const format = input.format;
    const data = this.loadDatasetForTraining(input, format);
    const sample = data[0] as Record<string, unknown> | undefined;
    return ToolResponse.fromObject({
      status: 'success',
      text: `数据集加载成功：format=${format} split=${input.split} size=${data.length}`,
      data: {
        format,
        split: input.split,
        dataset_size: data.length,
        sample_keys: Object.keys(sample ?? {})
      }
    });
  }

  private handleCreateReward(input: RlInput): ToolResponse {
    const custom = this.customRewardFunctions[input.reward_type];
    if (custom) {
      return ToolResponse.fromObject({
        status: 'success',
        text: `自定义奖励函数（已注册）: ${input.reward_type}（可用于 evaluate 的 reward_function 参数）`,
        data: { reward_type: input.reward_type, registered: true, source: 'customRewardFunctions' }
      });
    }
    const base = createAccuracyReward();
    switch (input.reward_type) {
      case 'accuracy':
        return ToolResponse.fromObject({
          status: 'success',
          text: '准确性奖励函数: 答案正确=1.0, 错误=0.0',
          data: { reward_type: 'accuracy' }
        });
      case 'length_penalty': {
        const maxLength = input.max_samples ?? 1024;
        createLengthPenaltyReward(base, maxLength, 0.001);
        return ToolResponse.fromObject({
          status: 'success',
          text: `长度惩罚奖励函数: 基础奖励 - 0.001 * (长度 / ${maxLength})`,
          data: { reward_type: 'length_penalty', max_length: maxLength, penalty_weight: 0.001 }
        });
      }
      case 'step':
        createStepReward(base, 0.1);
        return ToolResponse.fromObject({
          status: 'success',
          text: '步骤奖励函数: 基础奖励 + 0.1 * 步骤数',
          data: { reward_type: 'step', step_bonus: 0.1 }
        });
      default:
        return ToolResponse.fromObject({
          status: 'error',
          text: `未注册的自定义奖励函数: ${input.reward_type}（先调用 registerRewardFunction）`,
          data: {},
          error: { code: 'UNKNOWN_REWARD_FUNCTION', message: `未注册: ${input.reward_type}` }
        });
    }
  }

  private async handleEvaluate(input: RlInput): Promise<ToolResponse> {
    const modelPath = input.model_name;
    const dataDir = input.data_dir ?? this.dataDir;
    if (!dataDir) {
      return ToolResponse.fromObject({
        status: 'error',
        text: '缺少必需参数: data_dir（评估需要本地 GSM8K 数据）',
        data: {},
        error: { code: 'MISSING_PARAM', message: '缺少必需参数: data_dir' }
      });
    }
    const dataset = new GSM8KDataset({
      split: 'test',
      max_samples: input.max_samples ?? 100,
      format_type: 'rl',
      dataDir
    });
    const examples = dataset.getDataset() as RlExample[];
    const prompts = examples.map((e) => e.prompt);
    const groundTruths = examples.map((e) => e.ground_truth);
    const completions = await this.generateCompletionsImpl(prompts);
    let rewardFn: RewardFunction = createAccuracyReward();
    if (input.reward_function !== undefined) {
      const custom = this.customRewardFunctions[input.reward_function];
      if (!custom) {
        return ToolResponse.fromObject({
          status: 'error',
          text: `未注册的自定义奖励函数: ${input.reward_function}（先调用 registerRewardFunction）`,
          data: {},
          error: { code: 'UNKNOWN_REWARD_FUNCTION', message: `未注册: ${input.reward_function}` }
        });
      }
      rewardFn = custom;
    }
    const metrics = evaluateRewards(completions, groundTruths, rewardFn);
    const accuracy = metrics.mean_reward;
    return ToolResponse.fromObject({
      status: 'success',
      text: `评估完成：模型 ${modelPath}，样本 ${metrics.num_samples}，准确率 ${(accuracy * 100).toFixed(2)}%`,
      data: {
        model_path: modelPath,
        num_samples: metrics.num_samples,
        accuracy: `${(accuracy * 100).toFixed(2)}%`,
        average_reward: accuracy.toFixed(4)
      }
    });
  }
}

/* ------------------------- 便捷函数（对齐上游） ------------------------- */

function toolFor(options: { backend?: TrainingBackend; dataDir?: string } = {}): RLTrainingTool {
  return new RLTrainingTool({
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {})
  });
}

export function trainWithSft(
  options: {
    modelName?: string;
    maxSamples?: number;
    numEpochs?: number;
    outputDir?: string;
    dataDir?: string;
    backend?: TrainingBackend;
  } = {}
): Promise<ToolResponse> {
  return toolFor({
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {})
  }).execute({
    action: 'train',
    algorithm: 'sft',
    model_name: options.modelName ?? 'Qwen/Qwen2-0.5B-Instruct',
    ...(options.maxSamples !== undefined ? { max_samples: options.maxSamples } : {}),
    num_epochs: options.numEpochs ?? 3,
    output_dir: options.outputDir ?? './output/sft'
  });
}

export function trainWithGrpo(
  options: {
    modelName?: string;
    maxSamples?: number;
    numEpochs?: number;
    outputDir?: string;
    dataDir?: string;
    backend?: TrainingBackend;
  } = {}
): Promise<ToolResponse> {
  return toolFor({
    ...(options.backend !== undefined ? { backend: options.backend } : {}),
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {})
  }).execute({
    action: 'train',
    algorithm: 'grpo',
    model_name: options.modelName ?? 'Qwen/Qwen2-0.5B-Instruct',
    ...(options.maxSamples !== undefined ? { max_samples: options.maxSamples } : {}),
    num_epochs: options.numEpochs ?? 3,
    output_dir: options.outputDir ?? './output/grpo'
  });
}

export function loadDataset(
  options: { format?: 'sft' | 'rl'; split?: string; maxSamples?: number; dataDir?: string } = {}
): Promise<ToolResponse> {
  return toolFor({
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {})
  }).execute({
    action: 'load_dataset',
    format: options.format ?? 'sft',
    split: options.split ?? 'train',
    ...(options.maxSamples !== undefined ? { max_samples: options.maxSamples } : {})
  });
}

export function createRewardFunction(
  rewardType: 'accuracy' | 'length_penalty' | 'step' = 'accuracy'
): Promise<ToolResponse> {
  return toolFor().execute({ action: 'create_reward', reward_type: rewardType });
}

export function evaluateModel(
  options: {
    modelPath?: string;
    maxSamples?: number;
    dataDir?: string;
    generateCompletions?: (prompts: string[]) => string[] | Promise<string[]>;
  } = {}
): Promise<ToolResponse> {
  const tool = new RLTrainingTool({
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.generateCompletions !== undefined
      ? { generateCompletions: options.generateCompletions }
      : {})
  });
  return tool.execute({
    action: 'evaluate',
    model_name: options.modelPath ?? '',
    ...(options.maxSamples !== undefined ? { max_samples: options.maxSamples } : {})
  });
}
