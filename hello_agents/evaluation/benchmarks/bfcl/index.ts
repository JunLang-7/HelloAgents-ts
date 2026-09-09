/**
 * BFCL 评估模块（对齐上游 `evaluation/benchmarks/bfcl/__init__.py`）。
 */

export { BFCLDataset, loadJsonlFile, BFCL_CATEGORY_MAPPING } from './dataset.js';
export type { BfclSample, BFCLDatasetOptions } from './dataset.js';
export { BFCLEvaluator, extractFunctionCalls, astStringsMatch } from './evaluator.js';
export type {
  EvaluableAgent,
  BfclSampleResult,
  BfclEvaluationResults,
  BFCLEvaluatorOptions
} from './evaluator.js';
export { BFCLMetrics, parseCallExpression, normalizeLiteral, stringSimilarity } from './metrics.js';
export type { BfclResultSample, BfclCategoryMetrics, BfclComputedMetrics } from './metrics.js';
export { BFCLIntegration, parseBfclVersion, semverGte, BFCL_MIN_VERSION } from './integration.js';
export type { BFCLIntegrationOptions } from './integration.js';
