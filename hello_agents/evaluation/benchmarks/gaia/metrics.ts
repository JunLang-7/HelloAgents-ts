/**
 * GAIA 评估指标模块（对齐上游 `evaluation/benchmarks/gaia/metrics.py`）。
 */

/** GAIA 样本结果的宽松形状。 */
export interface GaiaResultSample {
  exact_match?: boolean;
  partial_match?: boolean;
  level?: number;
  score?: number;
  execution_time?: number;
  [key: string]: unknown;
}

/** 单级别指标。 */
export interface GaiaLevelMetrics {
  total: number;
  exact_match_rate: number;
  partial_match_rate: number;
  average_score: number;
}

/** 综合指标输出。 */
export interface GaiaComputedMetrics {
  total_samples: number;
  exact_match_rate: number;
  partial_match_rate: number;
  average_execution_time: number;
  level_metrics: Record<string, GaiaLevelMetrics>;
  score_statistics: Record<string, number>;
  performance_analysis: Record<string, unknown>;
}

export class GAIAMetrics {
  /** 计算精确匹配率（对齐上游 `calculate_exact_match_rate`）。 */
  public static calculateExactMatchRate(results: GaiaResultSample[]): number {
    if (results.length === 0) return 0.0;
    const exactMatches = results.filter((r) => r.exact_match === true).length;
    return exactMatches / results.length;
  }

  /** 计算部分匹配率（对齐上游 `calculate_partial_match_rate`）。 */
  public static calculatePartialMatchRate(results: GaiaResultSample[]): number {
    if (results.length === 0) return 0.0;
    const partialMatches = results.filter((r) => r.partial_match === true).length;
    return partialMatches / results.length;
  }

  /** 计算特定难度级别的指标（对齐上游 `calculate_level_metrics`）。 */
  public static calculateLevelMetrics(
    results: GaiaResultSample[],
    level: number
  ): GaiaLevelMetrics {
    const levelResults = results.filter((r) => r.level === level);
    if (levelResults.length === 0) {
      return { total: 0, exact_match_rate: 0.0, partial_match_rate: 0.0, average_score: 0.0 };
    }
    const exactMatches = levelResults.filter((r) => r.exact_match === true).length;
    const partialMatches = levelResults.filter((r) => r.partial_match === true).length;
    const scores = levelResults.map((r) => (typeof r.score === 'number' ? r.score : 0.0));
    return {
      total: levelResults.length,
      exact_match_rate: exactMatches / levelResults.length,
      partial_match_rate: partialMatches / levelResults.length,
      average_score: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.0
    };
  }

  /** 计算平均执行时间（对齐上游 `calculate_average_execution_time`）。 */
  public static calculateAverageExecutionTime(results: GaiaResultSample[]): number {
    const executionTimes = results
      .filter((r) => typeof r.execution_time === 'number')
      .map((r) => r.execution_time as number);
    return executionTimes.length > 0
      ? executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length
      : 0.0;
  }

  /** 计算综合指标（对齐上游 `compute_metrics`）。 */
  public computeMetrics(results: GaiaResultSample[]): GaiaComputedMetrics {
    if (results.length === 0) return this.emptyMetrics();
    const total = results.length;
    const exactMatchRate = GAIAMetrics.calculateExactMatchRate(results);
    const partialMatchRate = GAIAMetrics.calculatePartialMatchRate(results);
    const avgExecutionTime = GAIAMetrics.calculateAverageExecutionTime(results);
    const levelMetrics: Record<string, GaiaLevelMetrics> = {
      Level_1: GAIAMetrics.calculateLevelMetrics(results, 1),
      Level_2: GAIAMetrics.calculateLevelMetrics(results, 2),
      Level_3: GAIAMetrics.calculateLevelMetrics(results, 3)
    };
    const scores = results.map((r) => (typeof r.score === 'number' ? r.score : 0.0));
    return {
      total_samples: total,
      exact_match_rate: exactMatchRate,
      partial_match_rate: partialMatchRate,
      average_execution_time: avgExecutionTime,
      level_metrics: levelMetrics,
      score_statistics: this.computeScoreStatistics(scores),
      performance_analysis: this.analyzePerformance(results)
    };
  }

  /** 空指标（对齐上游 `_empty_metrics`）。 */
  public emptyMetrics(): GaiaComputedMetrics {
    return {
      total_samples: 0,
      exact_match_rate: 0.0,
      partial_match_rate: 0.0,
      average_execution_time: 0.0,
      level_metrics: {
        Level_1: { total: 0, exact_match_rate: 0.0, partial_match_rate: 0.0, average_score: 0.0 },
        Level_2: { total: 0, exact_match_rate: 0.0, partial_match_rate: 0.0, average_score: 0.0 },
        Level_3: { total: 0, exact_match_rate: 0.0, partial_match_rate: 0.0, average_score: 0.0 }
      },
      score_statistics: {},
      performance_analysis: {}
    };
  }

  /** 分数统计（对齐上游 `_compute_score_statistics`）。 */
  public computeScoreStatistics(scores: number[]): Record<string, number> {
    if (scores.length === 0) return {};
    const sorted = [...scores].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const variance =
      sorted.length > 1 ? sorted.reduce((acc, s) => acc + (s - mean) ** 2, 0) / sorted.length : 0.0;
    const percentile = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
    return {
      mean,
      median: sorted[sorted.length >> 1] ?? 0,
      std: Math.sqrt(variance),
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      q1: percentile(25),
      q3: percentile(75)
    };
  }

  /** 性能分析（对齐上游 `_analyze_performance`）。 */
  public analyzePerformance(results: GaiaResultSample[]): Record<string, unknown> {
    if (results.length === 0) return {};
    const levelPerformance: Record<
      string,
      { sample_count: number; success_count: number; success_rate: number }
    > = {};
    for (const level of [1, 2, 3]) {
      const levelResults = results.filter((r) => r.level === level);
      if (levelResults.length > 0) {
        const exactMatches = levelResults.filter((r) => r.exact_match === true).length;
        levelPerformance[`Level_${level}`] = {
          sample_count: levelResults.length,
          success_count: exactMatches,
          success_rate: exactMatches / levelResults.length
        };
      }
    }
    return {
      level_performance: levelPerformance,
      difficulty_progression: this.analyzeDifficultyProgression(levelPerformance),
      error_analysis: this.analyzeErrors(results)
    };
  }

  /** 难度递进表现（对齐上游 `_analyze_difficulty_progression`）。 */
  public analyzeDifficultyProgression(
    levelPerformance: Record<
      string,
      { sample_count: number; success_count: number; success_rate: number }
    >
  ): Record<string, unknown> {
    const progression: Record<string, unknown> = {};
    const levels = ['Level_1', 'Level_2', 'Level_3'];
    for (let i = 0; i < levels.length - 1; i += 1) {
      const currentLevel = levels[i]!;
      const nextLevel = levels[i + 1]!;
      const current = levelPerformance[currentLevel];
      const next = levelPerformance[nextLevel];
      if (current && next) {
        const dropRate = current.success_rate - next.success_rate;
        progression[`${currentLevel}_to_${nextLevel}`] = {
          drop_rate: dropRate,
          relative_drop: current.success_rate > 0 ? dropRate / current.success_rate : 0
        };
      }
    }
    return progression;
  }

  /** 错误分析（对齐上游 `_analyze_errors`）。 */
  public analyzeErrors(results: GaiaResultSample[]): Record<string, number> {
    const totalErrors = results.filter((r) => r.exact_match !== true).length;
    const partialCorrect = results.filter(
      (r) => r.partial_match === true && r.exact_match !== true
    ).length;
    const completeWrong = results.filter(
      (r) => r.partial_match !== true && r.exact_match !== true
    ).length;
    return {
      total_errors: totalErrors,
      partial_correct: partialCorrect,
      complete_wrong: completeWrong,
      error_rate: results.length > 0 ? totalErrors / results.length : 0,
      partial_correct_rate: totalErrors > 0 ? partialCorrect / totalErrors : 0
    };
  }

  /** 比较两个评估结果（对齐上游 `compare_results`）。 */
  public static compareResults(
    results1: Partial<GaiaComputedMetrics>,
    results2: Partial<GaiaComputedMetrics>
  ): Record<string, unknown> {
    const num = (v: unknown) => (typeof v === 'number' ? v : 0);
    const comparison: Record<string, unknown> = {
      exact_match_rate_diff: num(results1.exact_match_rate) - num(results2.exact_match_rate),
      partial_match_rate_diff: num(results1.partial_match_rate) - num(results2.partial_match_rate),
      execution_time_diff:
        num(results1.average_execution_time) - num(results2.average_execution_time)
    };
    const levelComparison: Record<string, unknown> = {};
    for (const level of ['Level_1', 'Level_2', 'Level_3']) {
      const level1 = results1.level_metrics?.[level];
      const level2 = results2.level_metrics?.[level];
      if (level1 && level2) {
        levelComparison[level] = {
          exact_match_rate_diff: num(level1.exact_match_rate) - num(level2.exact_match_rate),
          score_diff: num(level1.average_score) - num(level2.average_score)
        };
      }
    }
    comparison.level_comparison = levelComparison;
    return comparison;
  }
}
