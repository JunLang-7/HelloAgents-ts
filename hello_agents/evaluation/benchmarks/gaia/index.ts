/**
 * GAIA 评估模块（对齐上游 `evaluation/benchmarks/gaia/__init__.py`）。
 */

export { GAIADataset, standardizeGaiaItem, collectJsonFiles } from './dataset.js';
export type { GaiaItem, GAIADatasetOptions } from './dataset.js';
export {
  GAIAEvaluator,
  extractGaiaAnswer,
  normalizeGaiaAnswer,
  normalizeSingleAnswer,
  checkExactMatch,
  checkPartialMatch
} from './evaluator.js';
export type {
  EvaluableAgent,
  GaiaSampleResult,
  GaiaEvaluationResults,
  GAIAEvaluatorOptions
} from './evaluator.js';
export { GAIAMetrics } from './metrics.js';
export type { GaiaResultSample, GaiaLevelMetrics, GaiaComputedMetrics } from './metrics.js';
