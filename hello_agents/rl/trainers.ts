/**
 * RL 训练器封装（对齐上游 `rl/trainers.py`）。
 *
 * 训练后端方案（阻塞验收记录）：**Python 桥接**。TS 侧定义显式
 * `TrainingBackend` adapter 边界（可注入、可 mock），默认实现
 * `PythonTrainingBackend` 通过外部进程调用 Python 训练栈
 * （trl + transformers + torch，依赖版本由 `probeTrainingBackend` 探测）。
 * 后端缺失时抛错并给出安装/配置指导，不伪装为已执行训练（DIFF-046）。
 *
 * 上游 `PPOTrainerWrapper` 本身未实现（NotImplementedError），TS 保持一致。
 */

import { unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Gsm8kExample } from './datasets.js';
import {
  getInstallationGuide,
  probeTrainingBackend,
  setupTrainingEnvironment,
  trainingConfig,
  type TrainingConfig
} from './utils.js';

/** 训练算法。 */
export type TrainingAlgorithm = 'sft' | 'grpo';

/** 训练请求（backend 边界输入）。 */
export interface TrainingRequest {
  algorithm: TrainingAlgorithm;
  modelName: string;
  /** 训练数据集（Gsm8kExample[]，SFT 用 prompt/completion，RL 用 prompt/ground_truth）。 */
  dataset: Gsm8kExample[];
  /** GRPO 奖励函数类型（对齐上游内置奖励）。 */
  rewardType?: 'accuracy' | 'length_penalty' | 'step';
  config: TrainingConfig;
}

/** 训练结果（backend 边界输出）。 */
export interface TrainingResult {
  status: 'success' | 'error';
  algorithm: string;
  model: string;
  output_dir: string;
  num_epochs: number;
  dataset_size: number;
  backend: string;
  error?: string;
}

/** 训练后端 adapter（显式边界，可 mock）。 */
export interface TrainingBackend {
  readonly kind: string;
  /** 后端是否可用（真实探测，不 mock）。 */
  available(): boolean;
  /** 执行训练。 */
  train(request: TrainingRequest): TrainingResult;
}

/** 后端不可用错误（携带安装/配置指导）。 */
export class TrainingBackendUnavailableError extends Error {
  public constructor(public readonly guide: string) {
    super(guide);
    this.name = 'TrainingBackendUnavailableError';
  }
}

/**
 * 内嵌 Python 训练脚本（SFT / GRPO，trl + transformers）。
 *
 * 通过 `python3 <script> <config.json> <dataset.json>` 执行；模型保存到
 * output_dir。奖励函数在 Python 侧复刻 `rewards.ts` 语义（Final Answer /
 * #### / 数字容差），保证真实训练与 TS 奖励一致。
 */
const PYTHON_TRAIN_SCRIPT = String.raw`
import json, sys, os

args = json.loads(sys.argv[1])
with open(sys.argv[2], "r", encoding="utf-8") as f:
    dataset = json.load(f)

os.environ["TOKENIZERS_PARALLELISM"] = "false"
try:
    import torch
    torch.manual_seed(args["seed"])
    # The public device probe treats CUDA as the supported accelerator. Keep
    # Trainer placement consistent with it: on Apple Silicon, TRL may select
    # MPS even though GRPO attention with dropout is unsupported there.
    force_cpu = not torch.cuda.is_available()
except Exception:
    force_cpu = True

use_fp16 = bool(args.get("use_fp16", False)) and not force_cpu
use_bf16 = bool(args.get("use_bf16", False)) and not force_cpu

from transformers import AutoModelForCausalLM, AutoTokenizer
from datasets import Dataset
from trl import SFTConfig, SFTTrainer, GRPOConfig, GRPOTrainer

model_name = args["model_name"]
output_dir = args["output_dir"]
algorithm = args["algorithm"]
os.makedirs(output_dir, exist_ok=True)

tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

model = AutoModelForCausalLM.from_pretrained(
    model_name,
    trust_remote_code=True,
    device_map="auto" if (use_fp16 or use_bf16) else None,
)

report_to = []
if args.get("use_wandb"):
    report_to.append("wandb")
if args.get("use_tensorboard"):
    report_to.append("tensorboard")
if not report_to:
    report_to = "none"

if algorithm == "sft":
    train_dataset = Dataset.from_list(
        [{"text": ex.get("text", ex.get("prompt", "") + ex.get("completion", ""))} for ex in dataset]
    )
    training_args = SFTConfig(
        output_dir=output_dir,
        num_train_epochs=args["num_train_epochs"],
        per_device_train_batch_size=args["per_device_train_batch_size"],
        gradient_accumulation_steps=args["gradient_accumulation_steps"],
        learning_rate=args["learning_rate"],
        warmup_steps=args["warmup_steps"],
        logging_steps=args["logging_steps"],
        save_steps=args["save_steps"],
        fp16=use_fp16,
        bf16=use_bf16,
        gradient_checkpointing=args.get("gradient_checkpointing", False),
        max_length=args.get("max_length", 2048),
        use_cpu=force_cpu,
        report_to=report_to,
    )
    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        processing_class=tokenizer,
    )
    trainer.train()
    trainer.save_model(output_dir)
elif algorithm == "grpo":
    import re

    def extract_answer(text):
        patterns = [
            r"Final Answer:\s*([^\n]+)",
            r"####\s*([^\n]+)",
            r"答案是?\s*[:：]?\s*([^\n]+)",
            r"Therefore,?\s*(?:the answer is)?\s*([^\n]+)",
        ]
        for p in patterns:
            m = re.search(p, text, re.IGNORECASE)
            if m:
                return m.group(1).strip()
        lines = text.strip().split("\n")
        for line in reversed(lines):
            nums = re.findall(r"-?\d+\.?\d*", line)
            if nums:
                return nums[-1]
        return None

    def normalize(a):
        if a is None:
            return None
        a = a.strip().replace(",", "").replace("$", "").replace("%", "")
        nums = re.findall(r"-?\d+\.?\d*", a)
        if not nums:
            return None
        try:
            return float(nums[0])
        except ValueError:
            return None

    reward_type = args.get("reward_type", "accuracy")

    def accuracy_reward(prompts, completions, **kwargs):
        truths = kwargs.get("ground_truth", [])
        rewards = []
        for comp, truth in zip(completions, truths):
            pred = extract_answer(comp)
            if pred is None:
                rewards.append(0.0)
                continue
            pn, tn = normalize(pred), normalize(truth)
            if pn is None or tn is None:
                rewards.append(1.0 if pred.strip().lower() == str(truth).strip().lower() else 0.0)
            else:
                rewards.append(1.0 if abs(pn - tn) < 1e-4 else 0.0)
        return rewards

    def length_penalty_reward(prompts, completions, **kwargs):
        base = accuracy_reward(prompts, completions, **kwargs)
        max_len = args.get("max_length", 2048)
        weight = 0.1
        out = []
        for r, c in zip(base, completions):
            if len(c) > max_len:
                r = max(0.0, r - weight * (len(c) - max_len) / max_len)
            out.append(r)
        return out

    def step_reward(prompts, completions, **kwargs):
        base = accuracy_reward(prompts, completions, **kwargs)
        bonus = 0.1
        out = []
        for r, c in zip(base, completions):
            out.append(r + min(bonus * c.count("\n"), 0.5))
        return out

    reward_funcs = {
        "accuracy": accuracy_reward,
        "length_penalty": length_penalty_reward,
        "step": step_reward,
    }.get(reward_type, accuracy_reward)

    train_dataset = Dataset.from_list(
        [
            {
                "prompt": ex.get("prompt", ""),
                "ground_truth": ex.get("ground_truth", ""),
                "question": ex.get("question", ""),
            }
            for ex in dataset
        ]
    )
    training_args = GRPOConfig(
        output_dir=output_dir,
        num_train_epochs=args["num_train_epochs"],
        per_device_train_batch_size=args["per_device_train_batch_size"],
        gradient_accumulation_steps=args["gradient_accumulation_steps"],
        learning_rate=args["learning_rate"],
        warmup_steps=args["warmup_steps"],
        logging_steps=args["logging_steps"],
        save_steps=args["save_steps"],
        fp16=use_fp16,
        bf16=use_bf16,
        use_cpu=force_cpu,
        report_to=report_to,
        remove_unused_columns=False,
        generation_batch_size=max(8, args["per_device_train_batch_size"] * 8),
        max_completion_length=max(32, args.get("max_length", 2048) // 4),
    )
    trainer = GRPOTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        reward_funcs=reward_funcs,
        processing_class=tokenizer,
    )
    trainer.train()
    trainer.save_model(output_dir)
else:
    raise ValueError(f"unsupported algorithm: {algorithm}")

print(json.dumps({"status": "success", "output_dir": output_dir, "algorithm": algorithm}))
`;

/** 默认 Python 训练后端（外部进程桥接；真实探测，不 mock）。 */
export class PythonTrainingBackend implements TrainingBackend {
  public readonly kind: string;
  public constructor(
    public readonly pythonBin = 'python3',
    public readonly timeoutMs = 1_800_000
  ) {
    this.kind = `python:${pythonBin}`;
  }

  public available(): boolean {
    return probeTrainingBackend(this.pythonBin).available;
  }

  public train(request: TrainingRequest): TrainingResult {
    const probe = probeTrainingBackend(this.pythonBin);
    if (!probe.available) {
      throw new TrainingBackendUnavailableError(getInstallationGuide());
    }
    setupTrainingEnvironment(request.config);
    const script = PYTHON_TRAIN_SCRIPT;
    const datasetPath = join(
      tmpdir(),
      `helloagents-rl-dataset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    );
    const payload = {
      algorithm: request.algorithm,
      model_name: request.modelName,
      output_dir: request.config.output_dir,
      seed: request.config.seed,
      num_train_epochs: request.config.num_train_epochs,
      per_device_train_batch_size: request.config.per_device_train_batch_size,
      gradient_accumulation_steps: request.config.gradient_accumulation_steps,
      learning_rate: request.config.learning_rate,
      warmup_steps: request.config.warmup_steps,
      logging_steps: request.config.logging_steps,
      save_steps: request.config.save_steps,
      use_fp16: request.config.use_fp16,
      use_bf16: request.config.use_bf16,
      gradient_checkpointing: request.config.gradient_checkpointing,
      max_length: request.config.max_length,
      use_wandb: request.config.use_wandb,
      use_tensorboard: request.config.use_tensorboard,
      reward_type: request.rewardType ?? 'accuracy'
    };
    writeFileSync(datasetPath, JSON.stringify(request.dataset), 'utf8');
    try {
      const run = spawnSync(this.pythonBin, ['-c', script, JSON.stringify(payload), datasetPath], {
        encoding: 'utf8',
        timeout: this.timeoutMs,
        maxBuffer: 32 * 1024 * 1024
      });
      if (run.status !== 0) {
        const detail = (run.stderr ?? '').slice(-800) || (run.stdout ?? '').slice(-800);
        return {
          status: 'error',
          algorithm: request.algorithm,
          model: request.modelName,
          output_dir: request.config.output_dir,
          num_epochs: request.config.num_train_epochs,
          dataset_size: request.dataset.length,
          backend: this.kind,
          error: `训练失败 (exit ${run.status ?? 'timeout'}): ${detail}`
        };
      }
      return {
        status: 'success',
        algorithm: request.algorithm,
        model: request.modelName,
        output_dir: request.config.output_dir,
        num_epochs: request.config.num_train_epochs,
        dataset_size: request.dataset.length,
        backend: this.kind
      };
    } finally {
      try {
        unlinkSync(datasetPath);
      } catch {
        // 训练进程启动失败或文件已被清理时无需中断调用方。
      }
    }
  }
}

/** 详细日志回调格式化（对齐上游 `DetailedLoggingCallback.on_log` 输出）。 */
export function formatTrainingLog(logs: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof logs['loss'] === 'number') parts.push(`Loss: ${logs['loss'].toFixed(4)}`);
  if (typeof logs['learning_rate'] === 'number') {
    parts.push(`LR: ${logs['learning_rate'].toExponential(2)}`);
  }
  if (typeof logs['rewards/mean'] === 'number') {
    parts.push(`Reward: ${logs['rewards/mean'].toFixed(4)}`);
  }
  if (typeof logs['objective/kl'] === 'number') {
    parts.push(`KL: ${logs['objective/kl'].toFixed(4)}`);
  }
  return parts.join(' | ');
}

/** 训练器基类（对齐上游 `BaseTrainerWrapper`）。 */
export class BaseTrainerWrapper {
  public readonly config: TrainingConfig;
  public readonly backend: TrainingBackend;
  protected model: unknown = null;
  protected tokenizer: unknown = null;

  public constructor(
    config?: Partial<TrainingConfig>,
    backend: TrainingBackend = new PythonTrainingBackend()
  ) {
    if (!backend.available()) {
      throw new TrainingBackendUnavailableError(getInstallationGuide());
    }
    this.config = trainingConfig(config);
    this.backend = backend;
  }

  /** 设置模型和 tokenizer（TS 桥接下由 Python 后端在训练进程内加载）。 */
  public setupModel(): void {
    throw new Error(
      'setup_model 仅在 Python 训练进程中执行（TrainingBackend 边界内）；' +
        'TS 侧请直接调用 train()。'
    );
  }

  /** 保存模型（对齐上游 `save_model`）。 */
  public saveModel(outputDir?: string): void {
    if (this.model !== null) {
      console.log(`✅ 模型已保存到: ${outputDir ?? this.config.output_dir}`);
    } else {
      console.log('❌ 训练器未初始化，无法保存模型');
    }
  }
}

/** SFT 训练器封装（对齐上游 `SFTTrainerWrapper`）。 */
export class SFTTrainerWrapper extends BaseTrainerWrapper {
  public readonly dataset: Gsm8kExample[];

  public constructor(
    options: {
      config?: Partial<TrainingConfig>;
      dataset?: Gsm8kExample[];
      backend?: TrainingBackend;
    } = {}
  ) {
    super(options.config, options.backend);
    this.dataset = options.dataset ?? [];
  }

  /** 开始 SFT 训练（对齐上游 `train`）。 */
  public train(): TrainingResult {
    if (this.dataset.length === 0) {
      throw new Error('数据集未设置，请提供训练数据集');
    }
    return this.backend.train({
      algorithm: 'sft',
      modelName: this.config.model_name,
      dataset: this.dataset,
      config: this.config
    });
  }
}

/** GRPO 训练器封装（对齐上游 `GRPOTrainerWrapper`）。 */
export class GRPOTrainerWrapper extends BaseTrainerWrapper {
  public readonly dataset: Gsm8kExample[];
  public readonly rewardType: 'accuracy' | 'length_penalty' | 'step';

  public constructor(
    options: {
      config?: Partial<TrainingConfig>;
      dataset?: Gsm8kExample[];
      rewardType?: 'accuracy' | 'length_penalty' | 'step';
      backend?: TrainingBackend;
    } = {}
  ) {
    super(options.config, options.backend);
    this.dataset = options.dataset ?? [];
    this.rewardType = options.rewardType ?? 'accuracy';
  }

  /** 开始 GRPO 训练（对齐上游 `train`）。 */
  public train(): TrainingResult {
    if (this.dataset.length === 0) {
      throw new Error('数据集未设置，请提供训练数据集');
    }
    return this.backend.train({
      algorithm: 'grpo',
      modelName: this.config.model_name,
      dataset: this.dataset,
      rewardType: this.rewardType,
      config: this.config
    });
  }
}

/** PPO 训练器封装（对齐上游 `PPOTrainerWrapper`：上游本身未实现）。 */
export class PPOTrainerWrapper extends BaseTrainerWrapper {
  public readonly dataset: Gsm8kExample[];

  public constructor(
    options: {
      config?: Partial<TrainingConfig>;
      dataset?: Gsm8kExample[];
      backend?: TrainingBackend;
    } = {}
  ) {
    super(options.config, options.backend);
    this.dataset = options.dataset ?? [];
  }

  /** PPO 未实现（对齐上游 NotImplementedError 语义）。 */
  public train(): never {
    throw new Error('PPO训练器尚未实现，请使用GRPOTrainerWrapper');
  }
}
