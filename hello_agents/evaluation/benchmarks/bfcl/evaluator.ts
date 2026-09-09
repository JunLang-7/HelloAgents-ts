/**
 * BFCL 评估器模块（对齐上游 `evaluation/benchmarks/bfcl/evaluator.py`）。
 *
 * 评估智能体的工具调用能力（简单/多函数/并行/无关检测），支持 AST 与
 * 执行两种评估模式，并可导出 BFCL 官方格式结果。
 *
 * 说明：上游 `BFCLEvaluator.__init__` 会把 `local_data_dir` 透传给
 * `BFCLDataset`（该构造函数并无此参数），导致实例化即抛 TypeError。
 * TS 端修正该上游缺陷（见 DIFF-040）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { BFCLDataset, type BfclSample } from './dataset.js';
import { BFCLMetrics, parseCallExpression } from './metrics.js';

/** 可评估智能体的最小契约（对齐上游 `agent.run(prompt) -> str`）。 */
export interface EvaluableAgent {
  name?: string;
  run(task: string): Promise<string> | string;
}

/** 单个样本的评估结果。 */
export interface BfclSampleResult {
  success: boolean;
  score: number;
  predicted: unknown;
  expected: unknown;
  response?: string;
  question?: unknown;
  execution_time?: number;
  sample_id?: string;
  category?: string;
  error?: string;
}

/** 评估汇总结果。 */
export interface BfclEvaluationResults {
  benchmark: string;
  agent_name: string;
  evaluation_mode: string;
  category: string | undefined;
  total_samples: number;
  correct_samples: number;
  overall_accuracy: number;
  category_metrics: Record<string, { total: number; correct: number; accuracy: number }>;
  detailed_results: BfclSampleResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 从响应中提取函数调用（对齐上游 `_extract_function_calls`）。 */
export function extractFunctionCalls(response: string): Array<Record<string, unknown>> {
  const trimmed = response.trim();
  try {
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(isRecord);
    }
  } catch {
    /* fall through to regex extraction */
  }
  const jsonArrayPattern = /\[.*?\]/gs;
  for (const match of trimmed.match(jsonArrayPattern) ?? []) {
    try {
      const parsed: unknown = JSON.parse(match);
      if (Array.isArray(parsed)) return parsed.filter(isRecord);
    } catch {
      /* try next candidate */
    }
  }
  const singleCallPattern = /\{.*?"name".*?\}/gs;
  const calls: Array<Record<string, unknown>> = [];
  for (const match of trimmed.match(singleCallPattern) ?? []) {
    try {
      const parsed: unknown = JSON.parse(match);
      if (isRecord(parsed) && typeof parsed.name === 'string') calls.push(parsed);
    } catch {
      /* skip malformed candidate */
    }
  }
  return calls;
}

/** 结构比较两个函数调用字符串（对齐上游 `_ast_strings_match`）。 */
export function astStringsMatch(pred: string, expected: string): boolean {
  const predCall = parseCallExpression(pred);
  const expCall = parseCallExpression(expected);
  if (predCall && expCall) {
    return JSON.stringify(predCall) === JSON.stringify(expCall);
  }
  return pred.trim() === expected.trim();
}

export interface BFCLEvaluatorOptions {
  dataset?: BFCLDataset;
  category?: string;
  evaluationMode?: 'ast' | 'execution';
  /** 数据集目录（dataset 未提供时作为 BFCLDataset.dataDir）。 */
  dataDir?: string;
}

export class BFCLEvaluator {
  public readonly dataset: BFCLDataset;
  public readonly metrics: BFCLMetrics;
  public readonly evaluationMode: 'ast' | 'execution';
  public readonly category: string | undefined;

  public constructor(options: BFCLEvaluatorOptions = {}) {
    this.dataset =
      options.dataset ??
      new BFCLDataset({
        ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
        ...(options.category === undefined ? {} : { category: options.category })
      });
    this.metrics = new BFCLMetrics();
    this.evaluationMode = options.evaluationMode ?? 'ast';
    this.category = options.category;
  }

  /** 评估智能体（对齐上游 `evaluate`）。 */
  public async evaluate(
    agent: EvaluableAgent,
    maxSamples?: number
  ): Promise<BfclEvaluationResults> {
    console.log(`\n🔧 开始 BFCL 评估...`);
    console.log(`   智能体: ${agent.name ?? 'Unknown'}`);
    console.log(`   评估模式: ${this.evaluationMode}`);
    console.log(`   类别: ${this.category ?? '全部'}`);

    const dataset = this.dataset.load();
    if (dataset.length === 0) {
      console.log('   ⚠️ 数据集为空,跳过评估');
      return this.createEmptyResults(agent);
    }
    const samples =
      maxSamples !== undefined && maxSamples > 0 ? dataset.slice(0, maxSamples) : dataset;
    console.log(`   样本数量: ${samples.length}`);

    const results: BfclSampleResult[] = [];
    const categories = new Map<string, { total: number; correct: number }>();

    for (let i = 0; i < samples.length; i += 1) {
      if (i % 10 === 0) console.log(`   进度: ${i + 1}/${samples.length}`);
      const sample = samples[i]!;
      try {
        const sampleResult = await this.evaluateSample(agent, sample);
        results.push(sampleResult);
        const category =
          this.category ?? (typeof sample.category === 'string' ? sample.category : 'unknown');
        const stats = categories.get(category) ?? { total: 0, correct: 0 };
        stats.total += 1;
        if (sampleResult.success) stats.correct += 1;
        categories.set(category, stats);
      } catch (error) {
        console.log(`   ⚠️ 样本 ${i} 评估失败: ${String(error)}`);
        results.push({
          success: false,
          error: String(error),
          predicted: null,
          expected: sample.ground_truth,
          score: 0.0
        });
      }
    }

    const totalSamples = results.length;
    const correctSamples = results.filter((r) => r.success).length;
    const overallAccuracy = totalSamples > 0 ? correctSamples / totalSamples : 0.0;

    const categoryMetrics: Record<string, { total: number; correct: number; accuracy: number }> =
      {};
    for (const [cat, stats] of categories) {
      categoryMetrics[cat] = {
        total: stats.total,
        correct: stats.correct,
        accuracy: stats.total > 0 ? stats.correct / stats.total : 0.0
      };
    }

    const finalResults: BfclEvaluationResults = {
      benchmark: 'BFCL',
      agent_name: agent.name ?? 'Unknown',
      evaluation_mode: this.evaluationMode,
      category: this.category,
      total_samples: totalSamples,
      correct_samples: correctSamples,
      overall_accuracy: overallAccuracy,
      category_metrics: categoryMetrics,
      detailed_results: results
    };

    console.log('✅ BFCL 评估完成');
    console.log(`   总体准确率: ${(overallAccuracy * 100).toFixed(2)}%`);
    for (const [cat, metrics] of Object.entries(categoryMetrics)) {
      console.log(
        `   ${cat}: ${(metrics.accuracy * 100).toFixed(2)}% (${metrics.correct}/${metrics.total})`
      );
    }
    return finalResults;
  }

  /** 评估单个样本（对齐上游 `evaluate_sample`）。 */
  public async evaluateSample(
    agent: EvaluableAgent,
    sample: BfclSample
  ): Promise<BfclSampleResult> {
    try {
      const question = sample.question;
      const functions = Array.isArray(sample.function) ? sample.function : [];
      const groundTruth = Array.isArray(sample.ground_truth) ? sample.ground_truth : [];
      const prompt = this.buildFunctionCallingPrompt(
        typeof question === 'string' ? question : JSON.stringify(question),
        functions
      );
      const started = performance.now();
      const response = await agent.run(prompt);
      const executionTime = (performance.now() - started) / 1000;
      const predictedCalls = extractFunctionCalls(response);
      let success: boolean;
      let score: number;
      if (this.evaluationMode === 'ast') {
        [success, score] = this.evaluateAstMatching(predictedCalls, groundTruth);
      } else {
        [success, score] = this.evaluateExecution(predictedCalls, groundTruth, functions);
      }
      return {
        success,
        score,
        predicted: predictedCalls,
        expected: groundTruth,
        response,
        question,
        execution_time: executionTime,
        sample_id: typeof sample.id === 'string' ? sample.id : '',
        category:
          this.category ?? (typeof sample.category === 'string' ? sample.category : 'unknown')
      };
    } catch (error) {
      return {
        success: false,
        score: 0.0,
        predicted: null,
        expected: Array.isArray(sample.ground_truth) ? sample.ground_truth : [],
        question: sample.question,
        error: String(error),
        sample_id: typeof sample.id === 'string' ? sample.id : '',
        category:
          this.category ?? (typeof sample.category === 'string' ? sample.category : 'unknown')
      };
    }
  }

  /** 空评估结果（对齐上游 `_create_empty_results`）。 */
  public createEmptyResults(agent: EvaluableAgent): BfclEvaluationResults {
    return {
      benchmark: 'BFCL',
      agent_name: agent.name ?? 'Unknown',
      evaluation_mode: this.evaluationMode,
      category: this.category,
      total_samples: 0,
      correct_samples: 0,
      overall_accuracy: 0.0,
      category_metrics: {},
      detailed_results: []
    };
  }

  /** 构建函数调用提示（对齐上游 `_build_function_calling_prompt`）。 */
  public buildFunctionCallingPrompt(question: string, functions: unknown[]): string {
    if (functions.length === 0) return question;
    let prompt = '你是一个智能助手，可以调用以下函数来帮助回答问题：\n\n';
    functions.forEach((func, i) => {
      if (!isRecord(func)) return;
      const funcName = typeof func.name === 'string' ? func.name : `function_${i + 1}`;
      const funcDesc = typeof func.description === 'string' ? func.description : '';
      const funcParams = func.parameters;
      prompt += `函数 ${i + 1}: ${funcName}\n`;
      prompt += `描述: ${funcDesc}\n`;
      if (funcParams !== undefined) {
        prompt += `参数: ${JSON.stringify(funcParams, null, 2)}\n`;
      }
      prompt += '\n';
    });
    prompt += `请根据以下问题，选择合适的函数进行调用：\n${question}\n\n`;
    prompt += '请以JSON格式返回函数调用，例如：\n';
    prompt += '[{"name": "function_name", "arguments": {"param1": "value1"}}]';
    return prompt;
  }

  /** AST 匹配评估（对齐上游 `_evaluate_ast_matching`）。 */
  public evaluateAstMatching(
    predicted: Array<Record<string, unknown>>,
    expected: unknown[]
  ): [boolean, number] {
    if (expected.length === 0) {
      return [predicted.length === 0, predicted.length === 0 ? 1.0 : 0.0];
    }
    try {
      const first = expected[0];
      if (isRecord(first)) {
        return this.evaluateBfclV4Format(predicted, expected as Array<Record<string, unknown>>);
      }
      return this.evaluateStringFormat(predicted, expected as string[]);
    } catch (error) {
      console.log(`   ⚠️ 评估出错: ${String(error)}`);
      return [false, 0.0];
    }
  }

  /** 评估 BFCL v4 格式 ground truth（对齐上游 `_evaluate_bfcl_v4_format`）。 */
  public evaluateBfclV4Format(
    predicted: Array<Record<string, unknown>>,
    expected: Array<Record<string, unknown>>
  ): [boolean, number] {
    if (predicted.length !== expected.length) return [false, 0.0];
    let matches = 0;
    const matchedExpected = new Set<number>();
    for (const predCall of predicted) {
      if (!isRecord(predCall) || typeof predCall.name !== 'string') continue;
      const predFuncName = predCall.name;
      const predArgs = isRecord(predCall.arguments) ? predCall.arguments : {};
      for (const [index, expCall] of expected.entries()) {
        if (matchedExpected.has(index)) continue;
        if (!isRecord(expCall)) continue;
        for (const [expFuncName, expParams] of Object.entries(expCall)) {
          if (expFuncName !== predFuncName) continue;
          if (this.compareParameters(predArgs, isRecord(expParams) ? expParams : {})) {
            matches += 1;
            matchedExpected.add(index);
            break;
          }
        }
      }
    }
    const success = matches === expected.length;
    const score = expected.length > 0 ? matches / expected.length : 0.0;
    return [success, score];
  }

  /** 比较预测参数与期望参数（对齐上游 `_compare_parameters`）。 */
  public compareParameters(
    predParams: Record<string, unknown>,
    expParams: Record<string, unknown>
  ): boolean {
    for (const [paramName, expectedValues] of Object.entries(expParams)) {
      if (!(paramName in predParams)) {
        if (!Array.isArray(expectedValues) || !expectedValues.includes('')) return false;
        continue;
      }
      const predValue = predParams[paramName];
      if (Array.isArray(expectedValues)) {
        if (!expectedValues.includes(predValue)) {
          const predStr = String(predValue);
          if (!expectedValues.some((v) => String(v) === predStr)) return false;
        }
      } else {
        if (predValue !== expectedValues && String(predValue) !== String(expectedValues))
          return false;
      }
    }
    return true;
  }

  /** 评估字符串格式 ground truth（旧版，对齐上游 `_evaluate_string_format`）。 */
  public evaluateStringFormat(
    predicted: Array<Record<string, unknown>>,
    expected: string[]
  ): [boolean, number] {
    const predictedStrs: string[] = [];
    for (const call of predicted) {
      if (isRecord(call) && typeof call.name === 'string') {
        const funcName = call.name;
        const args = isRecord(call.arguments) ? call.arguments : {};
        if (Object.keys(args).length > 0) {
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(', ');
          predictedStrs.push(`${funcName}(${argsStr})`);
        } else {
          predictedStrs.push(`${funcName}()`);
        }
      }
    }
    if (predictedStrs.length !== expected.length) return [false, 0.0];
    let matches = 0;
    const matchedExpected = new Set<number>();
    for (const predStr of predictedStrs) {
      for (const [index, expStr] of expected.entries()) {
        if (matchedExpected.has(index)) continue;
        if (astStringsMatch(predStr, expStr)) {
          matches += 1;
          matchedExpected.add(index);
          break;
        }
      }
    }
    const success = matches === expected.length;
    const score = expected.length > 0 ? matches / expected.length : 0.0;
    return [success, score];
  }

  /** 执行评估（简化：等价 AST，对齐上游 `_evaluate_execution`）。 */
  public evaluateExecution(
    predicted: Array<Record<string, unknown>>,
    expected: unknown[],
    functions: unknown[]
  ): [boolean, number] {
    void functions;
    return this.evaluateAstMatching(predicted, expected);
  }

  /** 导出评估结果为 BFCL 官方格式 JSONL（对齐上游 `export_to_bfcl_format`）。 */
  public exportToBfclFormat(
    results: BfclEvaluationResults,
    outputPath: string,
    includeInferenceLog = true
  ): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    const lines: string[] = [];
    for (const detail of results.detailed_results) {
      const predicted = Array.isArray(detail.predicted) ? detail.predicted : [];
      let resultString = '';
      if (predicted.length > 0) {
        const call = predicted[0];
        if (isRecord(call) && typeof call.name === 'string') {
          const funcName = call.name;
          const args = isRecord(call.arguments) ? call.arguments : {};
          if (Object.keys(args).length > 0) {
            const argsStr = Object.entries(args)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(', ');
            resultString = `${funcName}(${argsStr})`;
          } else {
            resultString = `${funcName}()`;
          }
        }
      }
      const bfclItem: Record<string, unknown> = {
        id: detail.sample_id ?? '',
        result: resultString
      };
      if (includeInferenceLog) {
        bfclItem.inference_log = [
          { role: 'user', content: typeof detail.question === 'string' ? detail.question : '' },
          { role: 'assistant', content: detail.response ?? '' }
        ];
      }
      lines.push(JSON.stringify(bfclItem));
    }
    writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(`\n✅ BFCL格式结果已导出`);
    console.log(`   输出文件: ${outputPath}`);
    console.log(`   样本数: ${lines.length}`);
    console.log(`   包含推理日志: ${includeInferenceLog}`);
    console.log(`\n📝 使用BFCL官方评估工具：`);
    console.log(`   1. 安装: pip install bfcl-eval`);
    console.log(`   2. 设置环境变量: export BFCL_PROJECT_ROOT=.`);
    console.log(`   3. 将结果文件复制到: result/HelloAgents/`);
    console.log(
      `   4. 运行评估: bfcl evaluate --model HelloAgents --test-category ${this.category ?? ''}`
    );
  }
}
