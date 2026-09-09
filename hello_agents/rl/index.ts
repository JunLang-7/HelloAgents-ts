/**
 * RL 训练模块（第 11 章：Agentic RL）。
 *
 * 对齐上游 `rl/__init__.py`：SFT/GRPO 训练器封装、GSM8K 数学数据集格式化、
 * 准确性/长度/步骤奖励函数与训练工具。训练后端为 Python 桥接（见 trainers.ts
 * 的 TrainingBackend 边界与 DIFF-046/047）。
 */

export { TRL_AVAILABLE } from './utils.js';

export { SFTTrainerWrapper, GRPOTrainerWrapper, PPOTrainerWrapper } from './trainers.js';
export type { TrainingBackend, TrainingRequest, TrainingResult } from './trainers.js';
export {
  PythonTrainingBackend,
  TrainingBackendUnavailableError,
  formatTrainingLog
} from './trainers.js';

export {
  GSM8KDataset,
  createMathDataset,
  createSftDataset,
  createRlDataset,
  previewDataset,
  formatMathDataset,
  formatForSft,
  formatForRl,
  splitGsm8kAnswer,
  loadGsm8kLocal
} from './datasets.js';
export type {
  Gsm8kExample,
  Gsm8kRawItem,
  SftExample,
  RlExample,
  ChatTemplateFn,
  GSM8KDatasetOptions
} from './datasets.js';

export {
  MathRewardFunction,
  createAccuracyReward,
  createLengthPenaltyReward,
  createStepReward,
  evaluateRewards
} from './rewards.js';
export type { RewardFunction } from './rewards.js';

export {
  trainingConfig,
  defaultTrainingConfig,
  trainingConfigToDict,
  probeTrainingBackend,
  resetTrainingBackendProbe,
  trlAvailable,
  getInstallationGuide,
  setupTrainingEnvironment,
  formatTrainingTime,
  getDeviceInfo,
  printTrainingSummary,
  ensureOutputDir
} from './utils.js';
export type { TrainingConfig, TrainingBackendProbe } from './utils.js';
