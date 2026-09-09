/**
 * RL 训练工具函数（对齐上游 `rl/utils.py`）。
 *
 * 训练后端采用 **Python 桥接（外部进程边界）**：SFT/GRPO 训练通过显式
 * `TrainingBackend` adapter 调用 Python（trl/transformers/torch）执行；
 * TS 侧只做配置、探测、编排与结果解析。后端缺失时返回明确安装/配置指导，
 * 不伪装为已执行训练（DIFF-046）。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 训练配置（对齐上游 `TrainingConfig` dataclass 默认值）。 */
export interface TrainingConfig {
  /** 模型名称或本地路径。 */
  model_name: string;
  model_revision?: string;
  output_dir: string;
  num_train_epochs: number;
  per_device_train_batch_size: number;
  gradient_accumulation_steps: number;
  learning_rate: number;
  warmup_steps: number;
  logging_steps: number;
  save_steps: number;
  eval_steps: number;
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  use_fp16: boolean;
  use_bf16: boolean;
  gradient_checkpointing: boolean;
  use_lora: boolean;
  lora_r: number;
  lora_alpha: number;
  lora_dropout: number;
  lora_target_modules: string[];
  use_wandb: boolean;
  wandb_project?: string;
  use_tensorboard: boolean;
  seed: number;
  max_length: number;
}

export function defaultTrainingConfig(): TrainingConfig {
  return {
    model_name: 'Qwen/Qwen3-0.6B',
    output_dir: './output',
    num_train_epochs: 3,
    per_device_train_batch_size: 4,
    gradient_accumulation_steps: 4,
    learning_rate: 5e-5,
    warmup_steps: 100,
    logging_steps: 10,
    save_steps: 500,
    eval_steps: 500,
    max_new_tokens: 512,
    temperature: 0.7,
    top_p: 0.9,
    use_fp16: true,
    use_bf16: false,
    gradient_checkpointing: true,
    use_lora: true,
    lora_r: 16,
    lora_alpha: 32,
    lora_dropout: 0.05,
    lora_target_modules: ['q_proj', 'v_proj'],
    use_wandb: false,
    use_tensorboard: true,
    seed: 42,
    max_length: 2048
  };
}

/** 将配置合并为完整对象（对齐上游 `TrainingConfig(...)` 缺省填默认）。 */
export function trainingConfig(options: Partial<TrainingConfig> = {}): TrainingConfig {
  return { ...defaultTrainingConfig(), ...options };
}

/** 转换为字典（对齐上游 `to_dict`，跳过 undefined）。 */
export function trainingConfigToDict(config: TrainingConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** 后端探测结果。 */
export interface TrainingBackendProbe {
  /** Python 训练栈（trl + transformers + torch）是否可用。 */
  available: boolean;
  /** 使用的 python 可执行文件。 */
  python: string;
  /** 各组件版本（探测失败时为 undefined）。 */
  versions?: {
    trl?: string;
    transformers?: string;
    torch?: string;
    datasets?: string;
  };
  /** 不可用原因（available=false 时给出）。 */
  reason?: string;
}

/** 按解释器路径分键缓存探测结果，避免不同 python 互相污染。 */
const backendProbeCache = new Map<string, TrainingBackendProbe>();

/**
 * 探测 Python 训练后端（真实命令，不 mock）。
 *
 * 检查 `python3 -c "import trl, torch, transformers, datasets"` 是否成功并
 * 读取版本。结果按进程缓存一次，避免反复 spawn（对齐上游 `TRL_AVAILABLE`
 * 的进程级语义）。
 */
export function probeTrainingBackend(pythonBin = 'python3'): TrainingBackendProbe {
  const cached = backendProbeCache.get(pythonBin);
  if (cached) return cached;
  const check = spawnSync(
    pythonBin,
    [
      '-c',
      'import importlib; mods=["trl","torch","transformers","datasets"]; ' +
        'out={}; [out.update({m: importlib.import_module(m).__version__}) for m in mods]; ' +
        'print(out)'
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (check.status !== 0 || !check.stdout) {
    const reason =
      (check.error?.message ?? '').trim() ||
      (check.stderr?.toString().trim().slice(0, 200) ?? '') ||
      'Python 训练栈（trl/transformers/torch）不可用';
    const fail = { available: false, python: pythonBin, reason };
    backendProbeCache.set(pythonBin, fail);
    return fail;
  }
  let versions: TrainingBackendProbe['versions'];
  try {
    versions = JSON.parse(check.stdout.replace(/'/g, '"'));
  } catch {
    versions = undefined;
  }
  const ok: TrainingBackendProbe = {
    available: true,
    python: pythonBin,
    ...(versions !== undefined ? { versions } : {})
  };
  backendProbeCache.set(pythonBin, ok);
  return ok;
}

/** 重置后端探测缓存（仅供测试）。 */
export function resetTrainingBackendProbe(): void {
  backendProbeCache.clear();
}

/** TRL 可用性标志（对齐上游 `TRL_AVAILABLE`：模块加载时真实探测一次）。 */
export const TRL_AVAILABLE: boolean = probeTrainingBackend().available;

/** 运行时重新探测 TRL 可用性。 */
export function trlAvailable(pythonBin = 'python3'): boolean {
  return probeTrainingBackend(pythonBin).available;
}

/** 获取安装指南（对齐上游 `get_installation_guide`）。 */
export function getInstallationGuide(): string {
  return `TRL (Transformer Reinforcement Learning) 未安装。

请使用以下命令安装：

方式1：安装 HelloAgents 的 RL 功能（推荐）
    pip install hello-agents[rl]

方式2：单独安装 TRL
    pip install trl

方式3：从源码安装最新版本
    pip install git+https://github.com/huggingface/trl.git

安装完成后，您可以使用以下功能：
- SFT训练（监督微调）
- GRPO训练（群体相对策略优化）
- PPO训练（近端策略优化）

更多信息请访问：https://huggingface.co/docs/trl`;
}

/** 格式化训练时间（对齐上游 `format_training_time`）。 */
export function formatTrainingTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** 设备信息（对齐上游 `get_device_info`；无 torch 后端时返回 CUDA 不可用）。 */
export function getDeviceInfo(pythonBin = 'python3'): {
  cuda_available: boolean;
  cuda_device_count: number;
  cuda_device_name: string | null;
} {
  const probe = probeTrainingBackend(pythonBin);
  if (!probe.available) {
    return { cuda_available: false, cuda_device_count: 0, cuda_device_name: null };
  }
  const check = spawnSync(
    pythonBin,
    [
      '-c',
      'import torch; print(torch.cuda.is_available(), torch.cuda.device_count(), ' +
        '(torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""))'
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (check.status !== 0 || !check.stdout) {
    return { cuda_available: false, cuda_device_count: 0, cuda_device_name: null };
  }
  const [avail, count, name] = check.stdout.trim().split(' ');
  return {
    cuda_available: avail === 'True',
    cuda_device_count: Number(count) || 0,
    cuda_device_name: name && name !== '' ? name : null
  };
}

/**
 * 设置训练环境（对齐上游 `setup_training_environment`）。
 *
 * TS 侧：创建输出目录、设置进程环境变量（TOKENIZERS_PARALLELISM / WANDB）。
 * 随机种子与 torch 种子在 Python 训练进程中设置（见 trainers.ts 的 seed 注入）。
 */
export function setupTrainingEnvironment(config: TrainingConfig): void {
  mkdirSync(resolve(config.output_dir), { recursive: true });
  process.env.TOKENIZERS_PARALLELISM = 'false';
  if (config.use_wandb && config.wandb_project) {
    process.env.WANDB_PROJECT = config.wandb_project;
  }
  process.env.WANDB_LOG_MODEL = 'false';
  console.log('✅ 训练环境设置完成');
  console.log(`   - 输出目录: ${config.output_dir}`);
  console.log(`   - 随机种子: ${config.seed}`);
  console.log(`   - 模型: ${config.model_name}`);
}

/** 打印训练摘要（对齐上游 `print_training_summary`）。 */
export function printTrainingSummary(
  algorithm: string,
  modelName: string,
  datasetName: string,
  numEpochs: number,
  outputDir: string,
  pythonBin = 'python3'
): void {
  const device = getDeviceInfo(pythonBin);
  console.log('\n' + '='.repeat(60));
  console.log(`🚀 开始 ${algorithm} 训练`);
  console.log('='.repeat(60));
  console.log(`📦 模型: ${modelName}`);
  console.log(`📊 数据集: ${datasetName}`);
  console.log(`🔄 训练轮数: ${numEpochs}`);
  console.log(`💾 输出目录: ${outputDir}`);
  console.log(`🖥️  设备: ${device.cuda_available ? 'GPU' : 'CPU'}`);
  if (device.cuda_available) {
    console.log(`   - GPU数量: ${device.cuda_device_count}`);
    console.log(`   - GPU型号: ${device.cuda_device_name}`);
  }
  console.log('='.repeat(60) + '\n');
}

/** 校验并返回存在的输出目录绝对路径（训练保存目标）。 */
export function ensureOutputDir(outputDir: string): string {
  const abs = resolve(outputDir);
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  return abs;
}
