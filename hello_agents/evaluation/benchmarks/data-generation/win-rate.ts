/**
 * Win Rate 评估器（对齐上游 `evaluation/benchmarks/data_generation/win_rate.py`）。
 *
 * 通过 LLM 成对对比计算生成数据相对参考数据的胜率。上游用 `random` 无种子
 * 采样；TS 端支持注入 `rng`（默认 `Math.random`），使评估可复现（DIFF-044）。
 */

import { writeFileSync } from 'node:fs';

import { HelloAgentsLLM } from '../../../core/llm.js';
import type { LLMMessage } from '../../../adapters/base.js';

/** Win Rate 依赖的最小 LLM 契约（对齐上游 `llm.invoke(messages)`）。 */
export interface WinRateLlmLike {
  invoke(messages: readonly LLMMessage[]): Promise<string> | string;
}

/** 单次对比结果。 */
export interface WinRateComparison {
  problem_a_id: string;
  problem_b_id: string;
  winner: string;
  reason: string;
  comparison_text: string;
  execution_time: number;
  actual_order?: Record<string, string>;
  actual_winner?: string;
}

/** 胜率评估汇总。 */
export interface WinRateEvaluationResult {
  comparisons: WinRateComparison[];
  metrics: {
    win_rate: number;
    loss_rate: number;
    tie_rate: number;
    wins: number;
    losses: number;
    ties: number;
    total_comparisons: number;
  };
  evaluation_date: string;
  judge_model: string;
}

export interface WinRateEvaluatorOptions {
  llm?: WinRateLlmLike;
  judgeModel?: string;
  /** 随机源（默认 Math.random；注入固定值可使采样可复现，DIFF-044）。 */
  rng?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 解析对比响应（对齐上游 `_parse_comparison_response`，含 LaTeX 转义修复）。 */
export function parseComparisonResponse(
  response: string,
  labelA: string,
  labelB: string
): [string, string] {
  try {
    let jsonStr = response.trim();
    if (jsonStr.includes('```json')) {
      jsonStr = jsonStr.split('```json')[1]!.split('```')[0]!.trim();
    } else if (jsonStr.includes('```')) {
      jsonStr = jsonStr.split('```')[1]!.split('```')[0]!.trim();
    }
    let data: unknown;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      // 修复 LaTeX 转义：将 \frac 等未转义反斜杠双写。
      const fixed = jsonStr.replace(/(?<!\\)\\(?!["\\/bfnrtu])/g, '\\\\');
      data = JSON.parse(fixed);
    }
    if (!isRecord(data)) throw new Error('not an object');
    const winner = typeof data.winner === 'string' ? data.winner : 'Tie';
    const reason = typeof data.reason === 'string' ? data.reason : 'No reason provided';
    return [winner === labelA || winner === labelB || winner === 'Tie' ? winner : 'Tie', reason];
  } catch (error) {
    console.log(`⚠️ 解析对比响应失败: ${String(error)}`);
    return ['Tie', 'Failed to parse response'];
  }
}

export class WinRateEvaluator {
  public readonly llm: WinRateLlmLike;
  public readonly judgeModel: string;
  private readonly rng: () => number;

  public constructor(options: WinRateEvaluatorOptions = {}) {
    this.llm = options.llm ?? new HelloAgentsLLM({ model: options.judgeModel ?? 'gpt-4o' });
    this.judgeModel = options.judgeModel ?? 'gpt-4o';
    this.rng = options.rng ?? Math.random;
  }

  private randomInt(maxExclusive: number): number {
    return Math.floor(this.rng() * maxExclusive);
  }

  /** 对比两个问题，判断哪个更好（对齐上游 `compare_pair`）。 */
  public async comparePair(
    problemA: Record<string, unknown>,
    problemB: Record<string, unknown>,
    labelA = 'A',
    labelB = 'B'
  ): Promise<WinRateComparison> {
    const started = performance.now();
    const prompt = this.buildComparisonPrompt(problemA, problemB, labelA, labelB);
    const response = await this.llm.invoke([{ role: 'user', content: prompt }]);
    const [winner, reason] = parseComparisonResponse(response, labelA, labelB);
    const executionTime = (performance.now() - started) / 1000;
    return {
      problem_a_id: typeof problemA.problem_id === 'string' ? problemA.problem_id : 'unknown',
      problem_b_id: typeof problemB.problem_id === 'string' ? problemB.problem_id : 'unknown',
      winner,
      reason,
      comparison_text: response,
      execution_time: executionTime
    };
  }

  /** 评估生成数据相对参考数据的胜率（对齐上游 `evaluate_win_rate`）。 */
  public async evaluateWinRate(
    generatedProblems: Array<Record<string, unknown>>,
    referenceProblems: Array<Record<string, unknown>>,
    numComparisons?: number
  ): Promise<WinRateEvaluationResult> {
    console.log('\n🏆 开始Win Rate评估');
    console.log(`   评委模型: ${this.judgeModel}`);
    console.log(`   生成数据: ${generatedProblems.length} 个`);
    console.log(`   参考数据: ${referenceProblems.length} 个`);

    let comparisonsCount =
      numComparisons === undefined || numComparisons === null
        ? Math.min(generatedProblems.length, referenceProblems.length)
        : numComparisons;
    comparisonsCount = Math.min(comparisonsCount, generatedProblems.length);
    if (comparisonsCount < 0) comparisonsCount = 0;
    console.log(`   对比次数: ${comparisonsCount}`);
    if (generatedProblems.length === 0 || referenceProblems.length === 0) {
      throw new Error('Both generated and reference problems are required for win rate evaluation');
    }

    // 随机采样生成题目索引（对齐上游 `random.sample` 语义）。
    const pool = generatedProblems.map((_, i) => i);
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = this.randomInt(i + 1);
      const temp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = temp;
    }
    const genIndices = pool.slice(0, comparisonsCount);
    console.log('   采样方式: 随机采样');

    const comparisons: WinRateComparison[] = [];
    let wins = 0;
    let losses = 0;
    let ties = 0;

    for (let i = 0; i < genIndices.length; i += 1) {
      const genIdx = genIndices[i]!;
      const genProblem = generatedProblems[genIdx]!;
      const refProblem = referenceProblems[this.randomInt(referenceProblems.length)]!;
      console.log(`\n   对比进度: ${i + 1}/${genIndices.length}`);
      console.log(
        `   生成题目: #${genIdx + 1}, 参考题目: #${refIndexLabel(referenceProblems, refProblem)}`
      );

      let result: WinRateComparison;
      let actualWinner: string;
      if (this.rng() < 0.5) {
        result = await this.comparePair(genProblem, refProblem, 'Problem A', 'Problem B');
        result.actual_order = { A: 'Generated', B: 'Reference' };
        actualWinner =
          result.winner === 'Problem A'
            ? 'Generated'
            : result.winner === 'Problem B'
              ? 'Reference'
              : 'Tie';
      } else {
        result = await this.comparePair(refProblem, genProblem, 'Problem A', 'Problem B');
        result.actual_order = { A: 'Reference', B: 'Generated' };
        actualWinner =
          result.winner === 'Problem A'
            ? 'Reference'
            : result.winner === 'Problem B'
              ? 'Generated'
              : 'Tie';
      }
      result.actual_winner = actualWinner;
      comparisons.push(result);
      if (actualWinner === 'Generated') {
        wins += 1;
        console.log('   ✓ Generated胜出');
      } else if (actualWinner === 'Reference') {
        losses += 1;
        console.log('   ✗ Reference胜出');
      } else {
        ties += 1;
        console.log('   = 平局');
      }
    }

    const winRate = comparisonsCount > 0 ? wins / comparisonsCount : 0;
    const lossRate = comparisonsCount > 0 ? losses / comparisonsCount : 0;
    const tieRate = comparisonsCount > 0 ? ties / comparisonsCount : 0;
    const metrics = {
      win_rate: winRate,
      loss_rate: lossRate,
      tie_rate: tieRate,
      wins,
      losses,
      ties,
      total_comparisons: comparisonsCount
    };

    console.log('\n📊 Win Rate评估结果:');
    console.log(`   胜率: ${(winRate * 100).toFixed(2)}%`);
    console.log(`   败率: ${(lossRate * 100).toFixed(2)}%`);
    console.log(`   平局率: ${(tieRate * 100).toFixed(2)}%`);

    return {
      comparisons,
      metrics,
      evaluation_date: new Date().toISOString(),
      judge_model: this.judgeModel
    };
  }

  /** 构建对比提示词（对齐上游 `_build_comparison_prompt`）。 */
  public buildComparisonPrompt(
    problemA: Record<string, unknown>,
    problemB: Record<string, unknown>,
    labelA: string,
    labelB: string
  ): string {
    const hasSolutionA = Boolean(typeof problemA.solution === 'string' && problemA.solution.trim());
    const hasSolutionB = Boolean(typeof problemB.solution === 'string' && problemB.solution.trim());

    const problemAText = `**${labelA}**
Problem: ${typeof problemA.problem === 'string' ? problemA.problem : ''}
Answer: ${typeof problemA.answer === 'string' ? problemA.answer : ''}`;
    const problemBText = `**${labelB}**
Problem: ${typeof problemB.problem === 'string' ? problemB.problem : ''}
Answer: ${typeof problemB.answer === 'string' ? problemB.answer : ''}`;

    const solutionA = hasSolutionA ? `\nSolution: ${problemA.solution}` : '';
    const solutionB = hasSolutionB ? `\nSolution: ${problemB.solution}` : '';

    const criteria =
      hasSolutionA && hasSolutionB
        ? `**Evaluation Criteria:**
Please evaluate comprehensively from the following dimensions:
1. **Mathematical Correctness**: Are the problem, solution, and answer mathematically correct?
2. **Clarity**: Is the problem statement clear and unambiguous?
3. **Difficulty Appropriateness**: Does the difficulty match AIME standards (challenging but solvable)?
4. **Solution Completeness**: Is the solution complete with clear reasoning steps?`
        : `**Evaluation Criteria:**
Please evaluate comprehensively from the following dimensions:
1. **Mathematical Correctness**: Are the problem and answer mathematically correct and reasonable?
2. **Clarity**: Is the problem statement clear and unambiguous?
3. **Difficulty Appropriateness**: Does the difficulty match AIME standards (challenging but solvable)?
4. **Problem Quality**: Is the problem well-designed with appropriate complexity?

Note: Some problems may not have solutions provided. Focus on the problem statement and answer quality.`;

    return `You are a professional mathematics problem evaluator. Please compare the following two AIME-style math problems and determine which one has higher quality.

${problemAText}${solutionA}

${problemBText}${solutionB}

${criteria}

**Important Guidelines:**
- Be objective and fair in your evaluation
- Consider all dimensions equally
- If both problems are of similar quality, choose "Tie"
- Do not favor one problem just because it appears first or second
- If one problem has a solution and the other doesn't, focus on the problem statement and answer quality

Please output your judgment in the following JSON format:
\`\`\`json
{
    "winner": "${labelA}",  // or "${labelB}" or "Tie"
    "reason": "Detailed explanation of why you chose this answer, covering the evaluation dimensions..."
}
\`\`\`
`;
  }

  /** 导出评估结果（对齐上游 `export_results`）。 */
  public exportResults(results: WinRateEvaluationResult, outputPath: string): void {
    writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n✅ Win Rate结果已保存: ${outputPath}`);
  }
}

/** 参考题目在列表中的索引标签（仅用于日志）。 */
function refIndexLabel(
  referenceProblems: Array<Record<string, unknown>>,
  refProblem: Record<string, unknown>
): number {
  const idx = referenceProblems.indexOf(refProblem);
  return idx >= 0 ? idx + 1 : 0;
}
