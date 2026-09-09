/**
 * GAIA 评估器模块（对齐上游 `evaluation/benchmarks/gaia/evaluator.py`）。
 *
 * 评估智能体的通用 AI 助手能力：精确匹配、部分匹配、分级指标与
 * GAIA 官方格式导出（JSONL）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { GAIADataset, type GaiaItem } from './dataset.js';
import { GAIAMetrics } from './metrics.js';

/** 可评估智能体的最小契约（对齐上游 `agent.run(prompt) -> str`）。 */
export interface EvaluableAgent {
  name?: string;
  run(task: string): Promise<string> | string;
}

/** 单个样本的 GAIA 评估结果。 */
export interface GaiaSampleResult {
  task_id: string;
  level: number;
  exact_match: boolean;
  partial_match: boolean;
  score: number;
  predicted: string | null;
  expected: string;
  response?: string;
  execution_time?: number;
  error?: string;
}

/** GAIA 评估汇总结果。 */
export interface GaiaEvaluationResults {
  benchmark: string;
  agent_name: string;
  strict_mode: boolean;
  level_filter: number | undefined;
  total_samples: number;
  exact_matches: number;
  partial_matches: number;
  exact_match_rate: number;
  partial_match_rate: number;
  level_metrics: Record<
    string,
    {
      total: number;
      exact_matches: number;
      partial_matches: number;
      exact_match_rate: number;
      partial_match_rate: number;
    }
  >;
  detailed_results: GaiaSampleResult[];
}

export interface GAIAEvaluatorOptions {
  dataset?: GAIADataset;
  level?: number;
  localDataDir?: string;
  strictMode?: boolean;
}

/** 从响应中提取答案（对齐上游 `_extract_answer`）。 */
export function extractGaiaAnswer(response: string): string {
  const finalAnswerPattern = /FINAL ANSWER:\s*(.+?)(?:\n|$)/im;
  const match = finalAnswerPattern.exec(response);
  if (match) {
    return match[1]!.trim().replace(/^\[|\]$/g, '');
  }
  const answerPatterns = [
    /答案[：:]\s*(.+)/i,
    /最终答案[：:]\s*(.+)/i,
    /Final answer[：:]\s*(.+)/i,
    /Answer[：:]\s*(.+)/i
  ];
  for (const pattern of answerPatterns) {
    const m = pattern.exec(response);
    if (m) return m[1]!.trim();
  }
  const lines = response.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line && !line.startsWith('#')) return line;
  }
  return response.trim();
}

/** 标准化单个答案（对齐上游 `_normalize_single_answer`）。 */
export function normalizeSingleAnswer(answer: string): string {
  let text = answer.trim().toLowerCase();
  const articles = ['the', 'a', 'an'];
  const words = text.split(/\s+/);
  if (words.length > 0 && articles.includes(words[0]!)) {
    words.shift();
    text = words.join(' ');
  }
  text = text.replace(/[$%€£]/g, '');
  text = text.replace(/(\d),(\d)/g, '$1$2');
  text = text.split(/\s+/).join(' ');
  text = text.replace(/[.,;:!?]+$/, '');
  return text;
}

/** 标准化答案字符串（对齐上游 `_normalize_answer`，GAIA 官方规则）。 */
export function normalizeGaiaAnswer(answer: string): string {
  if (!answer) return '';
  const text = answer.trim();
  if (text.includes(',')) {
    const parts = text
      .split(',')
      .map((p) => normalizeSingleAnswer(p.trim()))
      .sort();
    return parts.join(',');
  }
  return normalizeSingleAnswer(text);
}

/** 检查精确匹配（对齐上游 `_check_exact_match`）。 */
export function checkExactMatch(predicted: string, expected: string): boolean {
  if (!predicted || !expected) return false;
  return normalizeGaiaAnswer(predicted) === normalizeGaiaAnswer(expected);
}

/** 检查部分匹配（对齐上游 `_check_partial_match`）。 */
export function checkPartialMatch(predicted: string, expected: string): boolean {
  if (!predicted || !expected) return false;
  const predNormalized = normalizeGaiaAnswer(predicted);
  const expNormalized = normalizeGaiaAnswer(expected);
  if (expNormalized.includes(predNormalized) || predNormalized.includes(expNormalized)) return true;
  const predWords = new Set(predNormalized.split(/\s+/));
  const expWords = new Set(expNormalized.split(/\s+/));
  if (expWords.size === 0) return false;
  let overlap = 0;
  for (const word of predWords) {
    if (expWords.has(word)) overlap += 1;
  }
  return overlap / expWords.size >= 0.7;
}

export class GAIAEvaluator {
  public readonly dataset: GAIADataset;
  public readonly metrics: GAIAMetrics;
  public readonly level: number | undefined;
  public readonly strictMode: boolean;

  public constructor(options: GAIAEvaluatorOptions = {}) {
    this.dataset =
      options.dataset ??
      new GAIADataset({
        ...(options.level === undefined ? {} : { level: options.level }),
        ...(options.localDataDir === undefined ? {} : { localDataDir: options.localDataDir })
      });
    this.metrics = new GAIAMetrics();
    this.level = options.level;
    this.strictMode = options.strictMode ?? true;
  }

  /** 评估智能体（对齐上游 `evaluate`）。 */
  public async evaluate(
    agent: EvaluableAgent,
    maxSamples?: number
  ): Promise<GaiaEvaluationResults> {
    console.log(`\n🌟 开始 GAIA 评估...`);
    console.log(`   智能体: ${agent.name ?? 'Unknown'}`);
    console.log(`   难度级别: ${this.level ?? '全部'}`);
    console.log(`   匹配模式: ${this.strictMode ? '严格' : '宽松'}`);

    const dataset = this.dataset.load();
    if (dataset.length === 0) {
      console.log('   ⚠️ 数据集为空,跳过评估');
      return this.createEmptyResults(agent);
    }
    const samples =
      maxSamples !== undefined && maxSamples > 0 ? dataset.slice(0, maxSamples) : dataset;
    console.log(`   样本数量: ${samples.length}`);

    const results: GaiaSampleResult[] = [];
    const levelStats: Record<number, { total: number; correct: number; partial: number }> = {
      1: { total: 0, correct: 0, partial: 0 },
      2: { total: 0, correct: 0, partial: 0 },
      3: { total: 0, correct: 0, partial: 0 }
    };

    for (let i = 0; i < samples.length; i += 1) {
      if (i % 10 === 0) console.log(`   进度: ${i + 1}/${samples.length}`);
      const sample = samples[i]!;
      try {
        const sampleResult = await this.evaluateSample(agent, sample);
        results.push(sampleResult);
        const level = sample.level in levelStats ? sample.level : 1;
        levelStats[level]!.total += 1;
        if (sampleResult.exact_match) levelStats[level]!.correct += 1;
        if (sampleResult.partial_match) levelStats[level]!.partial += 1;
      } catch (error) {
        console.log(`   ⚠️ 样本 ${i} 评估失败: ${String(error)}`);
        results.push({
          exact_match: false,
          partial_match: false,
          predicted: null,
          expected: sample.final_answer,
          error: String(error),
          score: 0.0,
          task_id: sample.task_id,
          level: sample.level
        });
      }
    }

    const totalSamples = results.length;
    const exactMatches = results.filter((r) => r.exact_match).length;
    const partialMatches = results.filter((r) => r.partial_match).length;
    const exactMatchRate = totalSamples > 0 ? exactMatches / totalSamples : 0.0;
    const partialMatchRate = totalSamples > 0 ? partialMatches / totalSamples : 0.0;

    const levelMetrics: GaiaEvaluationResults['level_metrics'] = {};
    for (const [level, stats] of Object.entries(levelStats)) {
      if (stats.total > 0) {
        levelMetrics[`Level_${level}`] = {
          total: stats.total,
          exact_matches: stats.correct,
          partial_matches: stats.partial,
          exact_match_rate: stats.correct / stats.total,
          partial_match_rate: stats.partial / stats.total
        };
      }
    }

    const finalResults: GaiaEvaluationResults = {
      benchmark: 'GAIA',
      agent_name: agent.name ?? 'Unknown',
      strict_mode: this.strictMode,
      level_filter: this.level,
      total_samples: totalSamples,
      exact_matches: exactMatches,
      partial_matches: partialMatches,
      exact_match_rate: exactMatchRate,
      partial_match_rate: partialMatchRate,
      level_metrics: levelMetrics,
      detailed_results: results
    };

    console.log('✅ GAIA 评估完成');
    console.log(`   精确匹配率: ${(exactMatchRate * 100).toFixed(2)}%`);
    console.log(`   部分匹配率: ${(partialMatchRate * 100).toFixed(2)}%`);
    for (const [levelName, metrics] of Object.entries(levelMetrics)) {
      console.log(
        `   ${levelName}: ${(metrics.exact_match_rate * 100).toFixed(2)}% 精确 / ${(metrics.partial_match_rate * 100).toFixed(2)}% 部分`
      );
    }
    return finalResults;
  }

  /** 评估单个样本（对齐上游 `evaluate_sample`）。 */
  public async evaluateSample(agent: EvaluableAgent, sample: GaiaItem): Promise<GaiaSampleResult> {
    try {
      const question = sample.question;
      const expectedAnswer = sample.final_answer;
      const level = sample.level;
      const taskId = sample.task_id;
      const prompt = this.buildPrompt(question, sample);
      const started = performance.now();
      const response = await agent.run(prompt);
      const executionTime = (performance.now() - started) / 1000;
      const predictedAnswer = extractGaiaAnswer(response);
      const exactMatch = checkExactMatch(predictedAnswer, expectedAnswer);
      const partialMatch = checkPartialMatch(predictedAnswer, expectedAnswer);
      const score = exactMatch ? 1.0 : partialMatch ? 0.5 : 0.0;
      return {
        task_id: taskId,
        level,
        exact_match: exactMatch,
        partial_match: partialMatch,
        score,
        predicted: predictedAnswer,
        expected: expectedAnswer,
        response,
        execution_time: executionTime
      };
    } catch (error) {
      return {
        task_id: sample.task_id,
        level: sample.level,
        exact_match: false,
        partial_match: false,
        score: 0.0,
        predicted: null,
        expected: sample.final_answer,
        error: String(error)
      };
    }
  }

  /** 空评估结果（对齐上游 `_create_empty_results`）。 */
  public createEmptyResults(agent: EvaluableAgent): GaiaEvaluationResults {
    return {
      benchmark: 'GAIA',
      agent_name: agent.name ?? 'Unknown',
      strict_mode: this.strictMode,
      level_filter: this.level,
      total_samples: 0,
      exact_matches: 0,
      partial_matches: 0,
      exact_match_rate: 0.0,
      partial_match_rate: 0.0,
      level_metrics: {},
      detailed_results: []
    };
  }

  /** 构建评估提示（对齐上游 `_build_prompt`）。 */
  public buildPrompt(question: string, sample: GaiaItem): string {
    let prompt = question;
    if (sample.file_name) {
      prompt += `\n\nNote: This question may require reference to the file: ${sample.file_name}`;
    }
    return prompt;
  }

  /** 导出为 GAIA 官方格式 JSONL（对齐上游 `export_to_gaia_format`）。 */
  public exportToGaiaFormat(
    results: GaiaEvaluationResults,
    outputPath: string,
    includeReasoning = true
  ): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    const lines: string[] = [];
    for (const result of results.detailed_results) {
      const gaiaResult: Record<string, unknown> = {
        task_id: result.task_id,
        model_answer: result.predicted ?? ''
      };
      if (includeReasoning) {
        gaiaResult.reasoning_trace = result.response ?? '';
      }
      lines.push(JSON.stringify(gaiaResult));
    }
    writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
    console.log('✅ GAIA格式结果已导出');
    console.log(`   输出文件: ${outputPath}`);
    console.log(`   样本数: ${lines.length}`);
    console.log(`   包含推理轨迹: ${includeReasoning}`);
  }
}
