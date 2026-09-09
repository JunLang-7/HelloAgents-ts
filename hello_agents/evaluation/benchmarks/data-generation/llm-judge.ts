/**
 * LLM Judge 评估器（对齐上游 `evaluation/benchmarks/data_generation/llm_judge.py`）。
 *
 * 使用 LLM 作为评委评估数据生成质量，覆盖正确性、清晰度、难度匹配、
 * 完整性四个维度（1-5 分）。
 *
 * 上游依赖 `hello_agents.core.llm.HelloAgentsLLM.invoke(messages)`；TS 端注入
 * 本地 `HelloAgentsLLM`（或满足 `invoke` 契约的轻量对象，便于测试）。
 */

import { writeFileSync } from 'node:fs';

import { HelloAgentsLLM } from '../../../core/llm.js';
import type { LLMMessage } from '../../../adapters/base.js';

/** LLM Judge 依赖的最小 LLM 契约（对齐上游 `llm.invoke(messages)`）。 */
export interface LlmJudgeLlmLike {
  invoke(messages: readonly LLMMessage[]): Promise<string> | string;
}

/** 评估维度（对齐上游 `EVALUATION_DIMENSIONS`）。 */
export const LLM_JUDGE_DIMENSIONS = [
  'correctness',
  'clarity',
  'difficulty_match',
  'completeness'
] as const;

export type LlmJudgeDimension = (typeof LLM_JUDGE_DIMENSIONS)[number];

/** 单个问题的评估结果。 */
export interface LlmJudgeSingleResult {
  problem_id: string;
  scores: Record<LlmJudgeDimension, number>;
  total_score: number;
  evaluation_text: string;
  execution_time: number;
}

/** 批量评估汇总。 */
export interface LlmJudgeBatchResult {
  results: LlmJudgeSingleResult[];
  metrics: LlmJudgeMetrics;
  evaluation_date: string;
  judge_model: string;
  num_problems: number;
}

export interface LlmJudgeMetrics {
  average_total_score: number;
  dimension_averages: Record<LlmJudgeDimension, number>;
  pass_rate: number;
  excellent_rate: number;
}

export interface LLMJudgeEvaluatorOptions {
  llm?: LlmJudgeLlmLike;
  judgeModel?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 解析 LLM 评估响应（对齐上游 `_parse_evaluation_response`）。 */
export function parseJudgeResponse(response: string): Record<LlmJudgeDimension, number> {
  try {
    let jsonStr = response.trim();
    if (jsonStr.includes('```json')) {
      jsonStr = jsonStr.split('```json')[1]!.split('```')[0]!.trim();
    } else if (jsonStr.includes('```')) {
      jsonStr = jsonStr.split('```')[1]!.split('```')[0]!.trim();
    }
    const data: unknown = JSON.parse(jsonStr);
    if (!isRecord(data)) throw new Error('not an object');
    const scores = {} as Record<LlmJudgeDimension, number>;
    for (const dim of LLM_JUDGE_DIMENSIONS) {
      const raw = data[dim];
      scores[dim] = typeof raw === 'number' ? raw : 3.0;
    }
    return scores;
  } catch (error) {
    console.log(`⚠️ 解析评估响应失败: ${String(error)}`);
    const fallback = {} as Record<LlmJudgeDimension, number>;
    for (const dim of LLM_JUDGE_DIMENSIONS) fallback[dim] = 3.0;
    return fallback;
  }
}

export class LLMJudgeEvaluator {
  public static readonly EVALUATION_DIMENSIONS: readonly LlmJudgeDimension[] = LLM_JUDGE_DIMENSIONS;

  public readonly llm: LlmJudgeLlmLike;
  public readonly judgeModel: string;

  public constructor(options: LLMJudgeEvaluatorOptions = {}) {
    this.llm = options.llm ?? new HelloAgentsLLM({ model: options.judgeModel ?? 'gpt-4o' });
    this.judgeModel = options.judgeModel ?? 'gpt-4o';
  }

  /** 评估单个问题（对齐上游 `evaluate_single`）。 */
  public async evaluateSingle(
    problem: Record<string, unknown>,
    reference?: Record<string, unknown>
  ): Promise<LlmJudgeSingleResult> {
    const started = performance.now();
    const prompt = this.buildEvaluationPrompt(problem, reference);
    const response = await this.llm.invoke([{ role: 'user', content: prompt }]);
    const scores = parseJudgeResponse(response);
    const totalScore =
      LLM_JUDGE_DIMENSIONS.reduce((sum, dim) => sum + scores[dim], 0) / LLM_JUDGE_DIMENSIONS.length;
    const executionTime = (performance.now() - started) / 1000;
    return {
      problem_id: typeof problem.problem_id === 'string' ? problem.problem_id : 'unknown',
      scores,
      total_score: totalScore,
      evaluation_text: response,
      execution_time: executionTime
    };
  }

  /** 批量评估问题（对齐上游 `evaluate_batch`）。 */
  public async evaluateBatch(
    problems: Array<Record<string, unknown>>,
    references?: Array<Record<string, unknown>>
  ): Promise<LlmJudgeBatchResult> {
    console.log('\n🎯 开始LLM Judge评估');
    console.log(`   评委模型: ${this.judgeModel}`);
    console.log(`   评估数量: ${problems.length}`);
    console.log(`   评估维度: ${LLM_JUDGE_DIMENSIONS.join(', ')}`);

    const results: LlmJudgeSingleResult[] = [];
    for (let idx = 0; idx < problems.length; idx += 1) {
      console.log(`\n   评估进度: ${idx + 1}/${problems.length}`);
      const reference = references && idx < references.length ? references[idx] : undefined;
      const result = await this.evaluateSingle(problems[idx]!, reference);
      results.push(result);
      console.log(`   ✓ ${result.problem_id}: ${result.total_score.toFixed(2)}/5.0`);
    }
    const metrics = this.computeMetrics(results);
    return {
      results,
      metrics,
      evaluation_date: new Date().toISOString(),
      judge_model: this.judgeModel,
      num_problems: problems.length
    };
  }

  /** 构建评估提示词（对齐上游 `_build_evaluation_prompt`）。 */
  public buildEvaluationPrompt(
    problem: Record<string, unknown>,
    reference?: Record<string, unknown>
  ): string {
    let prompt = `你是一位专业的数学题目评估专家。请评估以下AIME风格数学题目的质量。

【待评估题目】
问题: ${typeof problem.problem === 'string' ? problem.problem : ''}
答案: ${typeof problem.answer === 'string' ? problem.answer : ''}
解答: ${typeof problem.solution === 'string' ? problem.solution : ''}
`;
    if (reference) {
      prompt += `
【参考题目（AIME真题）】
问题: ${typeof reference.problem === 'string' ? reference.problem : ''}
答案: ${typeof reference.answer === 'string' ? reference.answer : ''}
解答: ${typeof reference.solution === 'string' ? reference.solution : ''}
`;
    }
    prompt += `
请从以下四个维度评估题目质量（每个维度1-5分）：

1. **正确性 (Correctness)**: 数学逻辑是否正确，答案是否准确
2. **清晰度 (Clarity)**: 问题表述是否清晰，解答是否易懂
3. **难度匹配 (Difficulty Match)**: 难度是否符合AIME标准（6-9/15）
4. **完整性 (Completeness)**: 解答步骤是否完整，是否包含必要的推理

请按以下JSON格式输出评分：
\`\`\`json
{
    "correctness": 5,
    "clarity": 4,
    "difficulty_match": 4,
    "completeness": 5,
    "comments": "详细评价..."
}
\`\`\`
`;
    return prompt;
  }

  /** 计算评估指标（对齐上游 `_compute_metrics`）。 */
  public computeMetrics(results: LlmJudgeSingleResult[]): LlmJudgeMetrics {
    if (results.length === 0) {
      return {
        average_total_score: 0,
        dimension_averages: { correctness: 0, clarity: 0, difficulty_match: 0, completeness: 0 },
        pass_rate: 0,
        excellent_rate: 0
      };
    }
    const dimensionScores: Record<LlmJudgeDimension, number[]> = {
      correctness: [],
      clarity: [],
      difficulty_match: [],
      completeness: []
    };
    const totalScores: number[] = [];
    for (const result of results) {
      totalScores.push(result.total_score);
      for (const dim of LLM_JUDGE_DIMENSIONS) dimensionScores[dim].push(result.scores[dim]);
    }
    const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    return {
      average_total_score: average(totalScores),
      dimension_averages: {
        correctness: average(dimensionScores.correctness),
        clarity: average(dimensionScores.clarity),
        difficulty_match: average(dimensionScores.difficulty_match),
        completeness: average(dimensionScores.completeness)
      },
      pass_rate: totalScores.filter((s) => s >= 3.5).length / totalScores.length,
      excellent_rate: totalScores.filter((s) => s >= 4.5).length / totalScores.length
    };
  }

  /** 导出评估结果（对齐上游 `export_results`）。 */
  public exportResults(results: LlmJudgeBatchResult, outputPath: string): void {
    writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n✅ 评估结果已保存: ${outputPath}`);
  }
}
