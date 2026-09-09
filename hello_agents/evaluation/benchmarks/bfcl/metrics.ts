/**
 * BFCL 评估指标模块（对齐上游 `evaluation/benchmarks/bfcl/metrics.py`）。
 *
 * 计算 BFCL 相关的评估指标：
 * - 准确率 (Accuracy)：完全正确的比例
 * - AST 匹配度 (AST Match)：调用表达式结构匹配度
 * - 参数准确率 (Parameter Accuracy)：参数正确的比例
 * - F1 分数：精确率和召回率的调和平均
 * - 执行成功率：可执行函数调用的成功率
 *
 * 上游 `metrics.py` 使用 Python `ast.parse`/`ast.dump` 做结构比较；TS 端以
 * 调用表达式归一化结构（函数名 + 有序参数）等价实现，详见 DIFF-041。
 */

/** 评估结果样本的宽松形状（对齐上游 `results: List[Dict[str, Any]]`）。 */
export interface BfclResultSample {
  success?: boolean;
  score?: number;
  execution_time?: number;
  category?: string;
  predicted?: unknown;
  expected?: unknown;
  [key: string]: unknown;
}

/** 综合指标输出的类别统计。 */
export interface BfclCategoryMetrics {
  total: number;
  success: number;
  accuracy: number;
  average_score: number;
}

/** 综合指标输出。 */
export interface BfclComputedMetrics {
  total_samples: number;
  success_count: number;
  accuracy: number;
  average_score: number;
  average_execution_time: number;
  category_metrics: Record<string, BfclCategoryMetrics>;
  function_call_stats: Record<string, unknown>;
  score_distribution: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 解析单个函数调用表达式字符串为结构（对齐 Python `ast.dump` 的可比语义）。 */
export function parseCallExpression(
  input: string
): { name: string; args: Array<[string, unknown]> } | null {
  const text = input.trim();
  const match = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\((.*)\)$/s.exec(text);
  if (!match) return null;
  const name = match[1]!;
  const argsText = match[2]!.trim();
  const args: Array<[string, unknown]> = [];
  if (argsText.length === 0) return { name, args };
  // 按顶层逗号切分参数（忽略括号/引号内的逗号）。
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = '';
  for (const ch of argsText) {
    if (inString) {
      current += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      args.push([part.slice(0, eq).trim(), normalizeLiteral(part.slice(eq + 1).trim())]);
    } else {
      args.push([`arg${args.length}`, normalizeLiteral(part)]);
    }
  }
  return { name, args };
}

/** 把参数字面量归一化为可比较值（数字/字符串/布尔/null 与 Python 字面量对齐）。 */
export function normalizeLiteral(raw: string): unknown {
  const text = raw.trim();
  if (text === 'True' || text === 'true') return true;
  if (text === 'False' || text === 'false') return false;
  if (text === 'None' || text === 'null') return null;
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  if (/^-?\d+$/.test(text)) {
    const num = Number(text);
    if (Number.isSafeInteger(num)) return num;
  }
  if (/^-?\d*\.\d+$/.test(text) || /^-?\d+\.\d*[eE][+-]?\d+$/.test(text)) {
    return Number(text);
  }
  return text;
}

/** 结构相似度（Jaccard，对齐上游 `_calculate_string_similarity`）。 */
export function stringSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;
  const set1 = new Set(s1.split(/\s+/));
  const set2 = new Set(s2.split(/\s+/));
  if (set1.size === 0 || set2.size === 0) return 0.0;
  let intersection = 0;
  for (const word of set1) {
    if (set2.has(word)) intersection += 1;
  }
  const union = set1.size + set2.size - intersection;
  return union > 0 ? intersection / union : 0.0;
}

function dumpCall(call: { name: string; args: Array<[string, unknown]> }): string {
  return JSON.stringify(call);
}

export class BFCLMetrics {
  /** 计算准确率（对齐上游 `calculate_accuracy`）。 */
  public static calculateAccuracy(predictions: unknown[], references: unknown[]): number {
    if (predictions.length === 0 || references.length === 0) return 0.0;
    const minLen = Math.min(predictions.length, references.length);
    let correct = 0;
    for (let i = 0; i < minLen; i += 1) {
      if (predictions[i] === references[i]) correct += 1;
    }
    return correct / minLen;
  }

  /** 计算 AST 匹配度（对齐上游 `calculate_ast_match`）。 */
  public static calculateAstMatch(predicted: string, expected: string): number {
    const predCall = parseCallExpression(predicted);
    const expCall = parseCallExpression(expected);
    if (predCall && expCall) {
      const predDump = dumpCall(predCall);
      const expDump = dumpCall(expCall);
      if (predDump === expDump) return 1.0;
      return BFCLMetrics.stringSimilarity(predDump, expDump);
    }
    return BFCLMetrics.stringSimilarity(predicted, expected);
  }

  /** 结构相似度（对齐上游 `_calculate_string_similarity`）。 */
  public static stringSimilarity(s1: string, s2: string): number {
    return stringSimilarity(s1, s2);
  }

  /** 计算参数准确率（对齐上游 `calculate_parameter_accuracy`）。 */
  public static calculateParameterAccuracy(
    predictedParams: Record<string, unknown>,
    expectedParams: Record<string, unknown>
  ): number {
    const expectedKeys = Object.keys(expectedParams);
    if (expectedKeys.length === 0) {
      return Object.keys(predictedParams).length === 0 ? 1.0 : 0.0;
    }
    if (Object.keys(predictedParams).length === 0) return 0.0;
    let correct = 0;
    for (const key of expectedKeys) {
      if (key in predictedParams) {
        if (BFCLMetrics.valuesMatch(predictedParams[key], expectedParams[key])) correct += 1;
      }
    }
    return correct / expectedKeys.length;
  }

  /** 比较两个值是否匹配（对齐上游 `_values_match`）。 */
  public static valuesMatch(v1: unknown, v2: unknown): boolean {
    if (typeof v1 === 'number' && typeof v2 === 'number') {
      return Math.abs(v1 - v2) < 1e-6;
    }
    if (typeof v1 === 'string' && typeof v2 === 'string') {
      return v1.trim().toLowerCase() === v2.trim().toLowerCase();
    }
    if (Array.isArray(v1) && Array.isArray(v2)) {
      if (v1.length !== v2.length) return false;
      return v1.every((a, i) => BFCLMetrics.valuesMatch(a, v2[i]));
    }
    if (isRecord(v1) && isRecord(v2)) {
      const v1Keys = Object.keys(v1);
      const v2Keys = Object.keys(v2);
      if (v1Keys.length !== v2Keys.length) return false;
      if (!v1Keys.every((k) => k in v2)) return false;
      return v1Keys.every((k) => BFCLMetrics.valuesMatch(v1[k], v2[k]));
    }
    return v1 === v2;
  }

  /** 计算综合指标（对齐上游 `compute_metrics`）。 */
  public computeMetrics(results: BfclResultSample[]): BfclComputedMetrics {
    if (results.length === 0) return this.emptyMetrics();
    const total = results.length;
    const successCount = results.filter((r) => r.success === true).length;
    const accuracy = successCount / total;
    const scores = results.map((r) => (typeof r.score === 'number' ? r.score : 0.0));
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.0;
    const executionTimes = results
      .filter((r) => typeof r.execution_time === 'number')
      .map((r) => r.execution_time as number);
    const avgExecutionTime =
      executionTimes.length > 0
        ? executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length
        : 0.0;
    return {
      total_samples: total,
      success_count: successCount,
      accuracy,
      average_score: avgScore,
      average_execution_time: avgExecutionTime,
      category_metrics: this.computeCategoryMetrics(results),
      function_call_stats: this.computeFunctionCallStats(results),
      score_distribution: this.computeScoreDistribution(scores)
    };
  }

  /** 空指标（对齐上游 `_empty_metrics`）。 */
  public emptyMetrics(): BfclComputedMetrics {
    return {
      total_samples: 0,
      success_count: 0,
      accuracy: 0.0,
      average_score: 0.0,
      average_execution_time: 0.0,
      category_metrics: {},
      function_call_stats: {},
      score_distribution: {}
    };
  }

  /** 计算分类别指标（对齐上游 `_compute_category_metrics`）。 */
  public computeCategoryMetrics(results: BfclResultSample[]): Record<string, BfclCategoryMetrics> {
    const categoryMetrics: Record<string, BfclCategoryMetrics> = {};
    const counts = new Map<string, { total: number; success: number; scores: number[] }>();
    for (const result of results) {
      const category = typeof result.category === 'string' ? result.category : 'unknown';
      const entry = counts.get(category) ?? { total: 0, success: 0, scores: [] };
      entry.total += 1;
      if (result.success === true) entry.success += 1;
      entry.scores.push(typeof result.score === 'number' ? result.score : 0.0);
      counts.set(category, entry);
    }
    for (const [category, stats] of counts) {
      const avgScore =
        stats.scores.length > 0
          ? stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length
          : 0.0;
      categoryMetrics[category] = {
        total: stats.total,
        success: stats.success,
        accuracy: stats.total > 0 ? stats.success / stats.total : 0.0,
        average_score: avgScore
      };
    }
    return categoryMetrics;
  }

  /** 计算函数调用统计（对齐上游 `_compute_function_call_stats`）。 */
  public computeFunctionCallStats(results: BfclResultSample[]): Record<string, unknown> {
    let totalCalls = 0;
    let successfulCalls = 0;
    const functionNames = new Set<string>();
    for (const result of results) {
      const predicted = result.predicted;
      if (Array.isArray(predicted)) {
        totalCalls += predicted.length;
        for (const call of predicted) {
          if (isRecord(call) && typeof call.name === 'string') {
            functionNames.add(call.name);
            if (result.success === true) successfulCalls += 1;
          }
        }
      }
    }
    return {
      total_function_calls: totalCalls,
      successful_calls: successfulCalls,
      unique_functions: functionNames.size,
      function_names: [...functionNames].sort(),
      avg_calls_per_sample: results.length > 0 ? totalCalls / results.length : 0.0
    };
  }

  /** 计算分数分布（对齐上游 `_compute_score_distribution`）。 */
  public computeScoreDistribution(scores: number[]): Record<string, unknown> {
    if (scores.length === 0) return {};
    const sorted = [...scores].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const mid = sorted.length >> 1;
    const median = sorted[mid];
    const variance =
      sorted.length > 1 ? sorted.reduce((acc, s) => acc + (s - mean) ** 2, 0) / sorted.length : 0.0;
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean,
      median,
      std: Math.sqrt(variance),
      quartiles: {
        q1: sorted[sorted.length >> 2],
        q2: sorted[mid],
        q3: sorted[(3 * sorted.length) >> 2]
      }
    };
  }

  /** 计算 F1 分数（对齐上游 `calculate_f1_score`）。 */
  public static calculateF1Score(precision: number, recall: number): number {
    if (precision + recall === 0) return 0.0;
    return (2 * (precision * recall)) / (precision + recall);
  }

  /** 计算精确率和召回率（对齐上游 `calculate_precision_recall`）。 */
  public static calculatePrecisionRecall(
    predicted: Array<Record<string, unknown>>,
    expected: Array<Record<string, unknown>>
  ): [number, number] {
    if (expected.length === 0) return predicted.length === 0 ? [1.0, 1.0] : [0.0, 1.0];
    if (predicted.length === 0) return [0.0, 0.0];
    const predNames = new Set(
      predicted
        .filter((c) => isRecord(c) && typeof c.name === 'string')
        .map((c) => c.name as string)
    );
    const expNames = new Set(
      expected.filter((c) => isRecord(c) && typeof c.name === 'string').map((c) => c.name as string)
    );
    let truePositives = 0;
    for (const name of predNames) {
      if (expNames.has(name)) truePositives += 1;
    }
    const precision = predNames.size > 0 ? truePositives / predNames.size : 0.0;
    const recall = expNames.size > 0 ? truePositives / expNames.size : 0.0;
    return [precision, recall];
  }
}
