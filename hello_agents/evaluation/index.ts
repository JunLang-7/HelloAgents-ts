/**
 * HelloAgents 智能体评估模块（对齐上游 `evaluation/__init__.py`）。
 *
 * 提供完整的智能体评估框架：
 * - BFCL：Berkeley Function Calling Leaderboard，工具调用能力评估
 * - GAIA：General AI Assistants，通用 AI 助手能力评估
 * - Data Generation：数据生成质量评估（LLM Judge & Win Rate）
 */

export { BFCLDataset } from './benchmarks/bfcl/dataset.js';
export { BFCLEvaluator } from './benchmarks/bfcl/evaluator.js';
export { GAIADataset } from './benchmarks/gaia/dataset.js';
export { GAIAEvaluator } from './benchmarks/gaia/evaluator.js';
export { AIDataset } from './benchmarks/data-generation/dataset.js';
export { LLMJudgeEvaluator } from './benchmarks/data-generation/llm-judge.js';
export { WinRateEvaluator } from './benchmarks/data-generation/win-rate.js';

/** 对齐上游 `evaluation.__version__`。 */
export const __version__ = '0.1.0';
