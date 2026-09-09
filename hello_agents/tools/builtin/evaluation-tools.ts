/**
 * Evaluation 工具集合（对齐上游 `tools/builtin/{bfcl_evaluation,gaia_evaluation,llm_judge,win_rate}_tool.py`）。
 *
 * - BFCLEvaluationTool：BFCL 一键评估（数据检查 → 评估 → 导出 → 官方评估 → 报告）
 * - GAIAEvaluationTool：GAIA 一键评估（评估 → 导出 → 报告）
 * - LLMJudgeTool：LLM 评委评估生成数据质量
 * - WinRateTool：生成数据对真题的胜率评估
 *
 * 上游工具以 Python 对象直接传 `agent`；TS 工具在构造时注入 `agent`
 * （Zod JSON input 无法序列化实例），input 只携带可序列化参数（DIFF-043）。
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { Tool } from '../tool.js';
import { ToolResponse } from '../response.js';
import {
  BFCLDataset,
  BFCLEvaluator,
  BFCLIntegration
} from '../../evaluation/benchmarks/bfcl/index.js';
import { GAIADataset, GAIAEvaluator } from '../../evaluation/benchmarks/gaia/index.js';
import {
  AIDataset,
  LLMJudgeEvaluator,
  WinRateEvaluator
} from '../../evaluation/benchmarks/data-generation/index.js';
import type { EvaluableAgent } from '../../evaluation/benchmarks/bfcl/evaluator.js';
import type { GaiaEvaluationResults } from '../../evaluation/benchmarks/gaia/evaluator.js';
import type {
  LlmJudgeLlmLike,
  LlmJudgeBatchResult
} from '../../evaluation/benchmarks/data-generation/llm-judge.js';
import type {
  WinRateLlmLike,
  WinRateEvaluationResult
} from '../../evaluation/benchmarks/data-generation/win-rate.js';
import type { AimeProblem } from '../../evaluation/benchmarks/data-generation/dataset.js';

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function markdownPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/* -------------------------------------------------------------------------- */
/* BFCLEvaluationTool                                                          */
/* -------------------------------------------------------------------------- */

const bfclInputSchema = z
  .object({
    category: z
      .enum([
        'simple_python',
        'simple_java',
        'simple_javascript',
        'multiple',
        'parallel',
        'parallel_multiple',
        'irrelevance'
      ])
      .default('simple_python'),
    max_samples: z.number().int().nonnegative().default(5),
    run_official_eval: z.boolean().default(true),
    model_name: z.string().optional()
  })
  .strict();

type BfclInput = z.output<typeof bfclInputSchema>;

export interface BFCLEvaluationToolOptions {
  /** 要评估的智能体（构造时注入，对齐上游 `run(agent=...)`）。 */
  agent: EvaluableAgent;
  bfclDataDir?: string;
  projectRoot?: string;
  bin?: string;
}

export class BFCLEvaluationTool extends Tool<typeof bfclInputSchema> {
  public readonly agent: EvaluableAgent;
  public readonly projectRoot: string;
  public readonly bfclDataDir: string;
  public readonly bin: string | undefined;

  public constructor(options: BFCLEvaluationToolOptions) {
    super({
      name: 'bfcl_evaluation',
      description:
        'BFCL一键评估工具。评估智能体的工具调用能力，支持多个评估类别。自动完成数据加载、评估运行、结果导出和报告生成。',
      inputSchema: bfclInputSchema
    });
    this.agent = options.agent;
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.bfclDataDir =
      options.bfclDataDir ??
      join(
        this.projectRoot,
        'temp_gorilla',
        'berkeley-function-call-leaderboard',
        'bfcl_eval',
        'data'
      );
    this.bin = options.bin;
  }

  protected async run(input: BfclInput): Promise<ToolResponse> {
    console.log('\n' + '='.repeat(60));
    console.log('BFCL一键评估');
    console.log('='.repeat(60));
    console.log(`\n配置:`);
    console.log(`   评估类别: ${input.category}`);
    console.log(`   样本数量: ${input.max_samples > 0 ? input.max_samples : '全部'}`);
    console.log(`   智能体: ${this.agent.name ?? 'Unknown'}`);

    if (!existsSync(this.bfclDataDir)) {
      console.log(`\n❌ BFCL数据目录不存在: ${this.bfclDataDir}`);
      console.log('\n请先克隆BFCL仓库：');
      console.log(
        '   git clone --depth 1 https://github.com/ShishirPatil/gorilla.git temp_gorilla'
      );
      return ToolResponse.fromObject({
        status: 'error',
        text: `BFCL数据目录不存在: ${this.bfclDataDir}。请先克隆 BFCL 仓库：git clone --depth 1 https://github.com/ShishirPatil/gorilla.git temp_gorilla`,
        error: { code: 'NOT_FOUND', message: `BFCL数据目录不存在: ${this.bfclDataDir}` },
        data: {
          overall_accuracy: 0.0,
          correct_samples: 0,
          total_samples: 0,
          category_metrics: {},
          detailed_results: []
        }
      });
    }

    const dataset = new BFCLDataset({ dataDir: this.bfclDataDir, category: input.category });
    const evaluator = new BFCLEvaluator({ dataset, category: input.category });
    const results = await evaluator.evaluate(
      this.agent,
      input.max_samples > 0 ? input.max_samples : undefined
    );

    const outputDir = join(this.projectRoot, 'evaluation_results', 'bfcl_official');
    mkdirSync(outputDir, { recursive: true });
    const outputFile = join(outputDir, `BFCL_v4_${input.category}_result.json`);
    evaluator.exportToBfclFormat(results, outputFile);

    let officialEvaluation: { success: boolean; message: string } | undefined;
    if (input.run_official_eval) {
      const modelName = input.model_name ?? 'Qwen/Qwen3-8B';
      officialEvaluation = this.runOfficialEvaluation(outputFile, modelName, input.category);
    }

    results.agent_name = this.agent.name ?? 'Unknown';
    results.category = input.category;
    const report = this.generateReport(results as never);
    const data = {
      ...(results as unknown as Record<string, unknown>),
      ...(officialEvaluation === undefined ? {} : { official_evaluation: officialEvaluation })
    };
    if (officialEvaluation && !officialEvaluation.success) {
      return ToolResponse.partial(
        `${report}\n\n⚠️ BFCL 本地评估已完成，但官方评估未执行：${officialEvaluation.message}`,
        data
      );
    }
    return ToolResponse.fromObject({
      status: 'success',
      text: report,
      data
    });
  }

  private runOfficialEvaluation(
    sourceFile: string,
    modelName: string,
    category: string
  ): { success: boolean; message: string } {
    console.log('\n' + '='.repeat(60));
    console.log('步骤3: 运行BFCL官方评估');
    console.log('='.repeat(60));
    const integration = new BFCLIntegration({
      projectRoot: this.projectRoot,
      ...(this.bin ? { bin: this.bin } : {})
    });
    if (!integration.isInstalled()) {
      console.log('\n❌ 未找到bfcl命令');
      console.log('   请先安装: pip install bfcl-eval');
      return { success: false, message: '未找到 bfcl 命令；请先安装 pip install bfcl-eval' };
    }
    if (!integration.isVersionSupported()) {
      console.log(`\n❌ bfcl 版本过低（要求 >= ${'0.4.0'}）`);
      return { success: false, message: 'bfcl 版本不受支持（要求 >= 0.4.0）' };
    }
    const safeModelName = modelName.replace('/', '_');
    const resultDir = join(this.projectRoot, 'result', safeModelName);
    mkdirSync(resultDir, { recursive: true });
    const targetFile = join(resultDir, `BFCL_v4_${category}_result.json`);
    try {
      copyFileSync(sourceFile, targetFile);
    } catch (error) {
      console.log(`\n❌ 复制结果文件失败: ${String(error)}`);
      return { success: false, message: `复制官方评估结果文件失败：${String(error)}` };
    }
    console.log(`\n✅ 结果文件已复制到:`);
    console.log(`   ${targetFile}`);
    const success = integration.runEvaluation(modelName, category, targetFile);
    return {
      success,
      message: success ? 'BFCL 官方评估已完成' : 'BFCL 官方评估命令执行失败'
    };
  }

  /** 生成评估报告（对齐上游 `generate_report`）。 */
  public generateReport(
    results: Record<string, unknown> & {
      overall_accuracy: number;
      correct_samples: number;
      total_samples: number;
      category_metrics?: Record<string, { accuracy?: number; correct?: number; total?: number }>;
      detailed_results?: Array<Record<string, unknown>>;
    },
    outputFile?: string
  ): string {
    const reportTime = new Date().toISOString();
    let report = `# BFCL评估报告

**生成时间**: ${reportTime}

## 📊 评估概览

- **智能体**: ${String(results.agent_name ?? 'Unknown')}
- **评估类别**: ${String(results.category ?? 'Unknown')}
- **总体准确率**: ${markdownPercent(results.overall_accuracy)}
- **正确样本数**: ${results.correct_samples}/${results.total_samples}

## 📈 详细指标

`;
    const categoryMetrics = results.category_metrics;
    if (categoryMetrics && Object.keys(categoryMetrics).length > 0) {
      report += '### 分类准确率\n\n';
      for (const [category, metrics] of Object.entries(categoryMetrics)) {
        const accuracy = metrics.accuracy ?? 0.0;
        const correct = metrics.correct ?? 0;
        const total = metrics.total ?? 0;
        report += `- **${category}**: ${markdownPercent(accuracy)} (${correct}/${total})\n`;
      }
      report += '\n';
    }
    const detailed = results.detailed_results;
    if (detailed && detailed.length > 0) {
      report += '## 📝 样本详情\n\n';
      report += '| 样本ID | 问题 | 预测结果 | 正确答案 | 是否正确 |\n';
      report += '|--------|------|----------|----------|----------|\n';
      for (const detail of detailed.slice(0, 10)) {
        const sampleId = String(detail.sample_id ?? 'N/A');
        const question = String(detail.question ?? 'N/A').slice(0, 60);
        const prediction = String(detail.predicted ?? 'N/A').slice(0, 40);
        const expected = String(detail.expected ?? 'N/A').slice(0, 40);
        const isCorrect = detail.success === true ? '✅' : '❌';
        report += `| ${sampleId} | ${question} | ${prediction} | ${expected} | ${isCorrect} |\n`;
      }
      if (detailed.length > 10) report += `\n*显示前10个样本，共${detailed.length}个样本*\n`;
      report += '\n';
    }
    report += '## 📊 准确率可视化\n\n```\n';
    const barLength = Math.round(results.overall_accuracy * 50);
    report += `准确率: ${'█'.repeat(barLength)}${'░'.repeat(50 - barLength)} ${markdownPercent(results.overall_accuracy)}\n`;
    report += '```\n\n';
    const accuracy = results.overall_accuracy;
    report += '## 💡 建议\n\n';
    if (accuracy >= 0.9) report += '- ✅ 表现优秀！智能体在工具调用方面表现出色。\n';
    else if (accuracy >= 0.7)
      report += '- ⚠️ 表现良好，但仍有提升空间。建议检查错误样本，优化提示词。\n';
    else
      report +=
        '- ❌ 表现需要改进。建议：\n  1. 检查智能体的工具调用逻辑\n  2. 优化系统提示词\n  3. 增加更多训练样本\n';

    const target =
      outputFile ?? join(this.projectRoot, 'evaluation_reports', `bfcl_report_${timestamp()}.md`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, report, 'utf8');
    console.log(`\n📄 报告已生成: ${target}`);
    return report;
  }
}

/* -------------------------------------------------------------------------- */
/* GAIAEvaluationTool                                                          */
/* -------------------------------------------------------------------------- */

const gaiaInputSchema = z
  .object({
    level: z.number().int().min(1).max(3).optional(),
    max_samples: z.number().int().positive().optional(),
    local_data_dir: z.string().optional(),
    export_results: z.boolean().default(true),
    generate_report: z.boolean().default(true)
  })
  .strict();

type GaiaInput = z.output<typeof gaiaInputSchema>;

export interface GAIAEvaluationToolOptions {
  agent: EvaluableAgent;
  localDataPath?: string;
}

export class GAIAEvaluationTool extends Tool<typeof gaiaInputSchema> {
  public readonly agent: EvaluableAgent;
  public readonly localDataPath: string | undefined;

  public constructor(options: GAIAEvaluationToolOptions) {
    super({
      name: 'gaia_evaluation',
      description:
        '评估智能体的通用AI助手能力。使用GAIA (General AI Assistants)基准测试。支持三个难度级别：Level 1(简单)、Level 2(中等)、Level 3(困难)。',
      inputSchema: gaiaInputSchema
    });
    this.agent = options.agent;
    this.localDataPath = options.localDataPath;
  }

  protected async run(input: GaiaInput): Promise<ToolResponse> {
    console.log('\n' + '='.repeat(60));
    console.log('GAIA一键评估');
    console.log('='.repeat(60));
    console.log(`\n配置:`);
    console.log(`   智能体: ${this.agent.name ?? 'Unknown'}`);
    console.log(`   难度级别: ${input.level ?? '全部'}`);
    console.log(`   样本数量: ${input.max_samples ?? '全部'}`);
    try {
      const results = await this.runEvaluation(
        this.agent,
        input.level,
        input.max_samples,
        input.local_data_dir
      );
      if (input.export_results) this.exportResults(results);
      if (input.generate_report) this.generateReport(results);
      console.log('\n' + '='.repeat(60));
      console.log('🎯 最终结果');
      console.log('='.repeat(60));
      console.log(`   精确匹配率: ${markdownPercent(results.exact_match_rate)}`);
      console.log(`   部分匹配率: ${markdownPercent(results.partial_match_rate)}`);
      console.log(`   正确数: ${results.exact_matches}/${results.total_samples}`);
      return ToolResponse.fromObject({
        status: 'success',
        text: this.generateReport(results),
        data: results as unknown as Record<string, unknown>
      });
    } catch (error) {
      console.log(`\n❌ 评估失败: ${String(error)}`);
      return ToolResponse.fromObject({
        status: 'error',
        text: `GAIA评估失败: ${String(error)}`,
        error: { code: 'EXECUTION_ERROR', message: String(error) },
        data: { benchmark: 'GAIA', agent_name: this.agent.name ?? 'Unknown' }
      });
    }
  }

  private async runEvaluation(
    agent: EvaluableAgent,
    level: number | undefined,
    maxSamples: number | undefined,
    localDataDir: string | undefined
  ): Promise<GaiaEvaluationResults> {
    const effectiveDataDir = localDataDir ?? this.localDataPath;
    const dataset = new GAIADataset({
      ...(level === undefined ? {} : { level }),
      ...(effectiveDataDir === undefined ? {} : { localDataDir: effectiveDataDir })
    });
    const datasetItems = dataset.load();
    if (datasetItems.length === 0) throw new Error('数据集加载失败或为空');
    const evaluator = new GAIAEvaluator({
      dataset,
      ...(level === undefined ? {} : { level }),
      ...(effectiveDataDir === undefined ? {} : { localDataDir: effectiveDataDir })
    });
    return evaluator.evaluate(agent, maxSamples);
  }

  private exportResults(results: GaiaEvaluationResults): void {
    const outputDir = join(process.cwd(), 'evaluation_results', 'gaia_official');
    mkdirSync(outputDir, { recursive: true });
    const levelStr =
      results.level_filter !== undefined && results.level_filter !== null
        ? `_level${results.level_filter}`
        : '_all';
    const outputFile = join(outputDir, `gaia${levelStr}_result_${timestamp()}.jsonl`);
    const evaluator = new GAIAEvaluator({
      dataset: new GAIADataset({}),
      ...(results.level_filter === undefined ? {} : { level: results.level_filter })
    });
    evaluator.exportToGaiaFormat(results, outputFile, true);
  }

  /** 生成评估报告（对齐上游 `generate_report`）。 */
  public generateReport(results: GaiaEvaluationResults, outputFile?: string): string {
    const reportTime = new Date().toISOString();
    let report = `# GAIA评估报告

**生成时间**: ${reportTime}

## 📊 评估概览

- **智能体**: ${results.agent_name ?? 'Unknown'}
- **难度级别**: ${results.level_filter ?? '全部'}
- **总样本数**: ${results.total_samples}
- **精确匹配数**: ${results.exact_matches}
- **部分匹配数**: ${results.partial_matches}
- **精确匹配率**: ${markdownPercent(results.exact_match_rate)}
- **部分匹配率**: ${markdownPercent(results.partial_match_rate)}

## 📈 详细指标

### 分级准确率

`;
    for (const [levelName, metrics] of Object.entries(results.level_metrics)) {
      report += `- **${levelName.replace('Level_', 'Level ')}**: ${markdownPercent(metrics.exact_match_rate)} 精确 / ${markdownPercent(metrics.partial_match_rate)} 部分 (${metrics.exact_matches}/${metrics.total})\n`;
    }
    report += '\n## 📝 样本详情（前10个）\n\n';
    report += '| 任务ID | 级别 | 预测答案 | 正确答案 | 精确匹配 | 部分匹配 |\n';
    report += '|--------|------|----------|----------|----------|----------|\n';
    for (const detail of results.detailed_results.slice(0, 10)) {
      report += `| ${detail.task_id} | ${detail.level} | ${String(detail.predicted ?? '').slice(0, 50)} | ${String(detail.expected ?? '').slice(0, 50)} | ${detail.exact_match ? '✅' : '❌'} | ${detail.partial_match ? '✅' : '❌'} |\n`;
    }
    report += '\n## 📊 准确率可视化\n\n```\n';
    const filled = Math.round(results.exact_match_rate * 50);
    report += `精确匹配: ${'█'.repeat(filled)}${'░'.repeat(50 - filled)} ${markdownPercent(results.exact_match_rate)}\n`;
    const filledPartial = Math.round(results.partial_match_rate * 50);
    report += `部分匹配: ${'█'.repeat(filledPartial)}${'░'.repeat(50 - filledPartial)} ${markdownPercent(results.partial_match_rate)}\n`;
    report += '```\n\n## 💡 建议\n\n';
    if (results.exact_match_rate >= 0.9) report += '- ✅ 表现优秀！智能体在GAIA基准上表现出色。\n';
    else if (results.exact_match_rate >= 0.7)
      report += '- 👍 表现良好，但仍有提升空间。\n- 💡 建议优化提示词和推理策略。\n';
    else if (results.exact_match_rate >= 0.5)
      report += '- ⚠️ 表现一般，需要改进。\n- 💡 建议检查工具使用和多步推理能力。\n';
    else report += '- ❌ 表现较差，需要大幅改进。\n- 💡 建议从简单级别开始，逐步提升。\n';

    const target =
      outputFile ?? join(process.cwd(), 'evaluation_reports', `gaia_report_${timestamp()}.md`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, report, 'utf8');
    console.log(`📄 报告已生成: ${target}`);
    return report;
  }
}

/* -------------------------------------------------------------------------- */
/* LLMJudgeTool                                                               */
/* -------------------------------------------------------------------------- */

const llmJudgeInputSchema = z
  .object({
    generated_data_path: z.string(),
    reference_data_path: z.string().optional(),
    reference_year: z.number().int().optional(),
    max_samples: z.number().int().positive().optional(),
    output_dir: z.string().default('evaluation_results/llm_judge'),
    judge_model: z.string().default('gpt-4o')
  })
  .strict();

type LlmJudgeInput = z.output<typeof llmJudgeInputSchema>;

export interface LLMJudgeToolOptions {
  llm?: LlmJudgeLlmLike;
}

export class LLMJudgeTool extends Tool<typeof llmJudgeInputSchema> {
  public readonly llm: LlmJudgeLlmLike | undefined;

  public constructor(options: LLMJudgeToolOptions = {}) {
    super({
      name: 'llm_judge_evaluation',
      description: '使用LLM作为评委评估数据生成质量',
      inputSchema: llmJudgeInputSchema
    });
    this.llm = options.llm;
  }

  protected async run(input: LlmJudgeInput): Promise<ToolResponse> {
    const outputDir = input.output_dir;
    mkdirSync(outputDir, { recursive: true });
    console.log('\n' + '='.repeat(60));
    console.log('🎯 LLM Judge评估');
    console.log('='.repeat(60));

    const genDataset = new AIDataset({
      datasetType: 'generated',
      dataPath: input.generated_data_path
    });
    let genProblems = genDataset.load();
    if (input.max_samples !== undefined) genProblems = genProblems.slice(0, input.max_samples);

    let refProblems: AimeProblem[] | undefined;
    if (input.reference_data_path) {
      const refDataset = new AIDataset({
        datasetType: 'generated',
        dataPath: input.reference_data_path
      });
      refProblems = refDataset.load();
    } else if (input.reference_year) {
      // TS 端不支持远程下载：明确报错（DIFF-042）。
      throw new Error(
        `reference_year=${input.reference_year} 需要从 HuggingFace 下载 AIME 真题，TS 端不支持远程下载；` +
          `请提供 reference_data_path 指向本地 JSON 文件。`
      );
    }

    const evaluator = new LLMJudgeEvaluator({
      ...(this.llm === undefined ? {} : { llm: this.llm }),
      judgeModel: input.judge_model
    });
    const results = await evaluator.evaluateBatch(
      genProblems as unknown as Array<Record<string, unknown>>,
      refProblems as unknown as Array<Record<string, unknown>>
    );

    const resultFile = join(outputDir, `llm_judge_results_${timestamp()}.json`);
    evaluator.exportResults(results, resultFile);
    const reportFile = join(outputDir, `llm_judge_report_${timestamp()}.md`);
    this.generateReport(results, reportFile);

    console.log('\n' + '='.repeat(60));
    console.log('✅ LLM Judge评估完成');
    console.log('='.repeat(60));
    console.log('\n📁 输出文件:');
    const report = this.generateReport(results, reportFile);
    console.log(`   - 评估结果: ${resultFile}`);
    console.log(`   - 评估报告: ${reportFile}`);
    return ToolResponse.fromObject({
      status: 'success',
      text: report,
      data: {
        metrics: results.metrics,
        num_problems: results.num_problems,
        result_file: resultFile,
        report_file: reportFile
      }
    });
  }

  /** 生成 Markdown 评估报告（对齐上游 `_generate_report`）。 */
  public generateReport(results: LlmJudgeBatchResult, outputPath: string): string {
    const metrics = results.metrics as unknown as {
      average_total_score: number;
      pass_rate: number;
      excellent_rate: number;
      dimension_averages: Record<string, number>;
    };
    const rating = (score: number): string =>
      score >= 4.5
        ? '优秀 ⭐⭐⭐⭐⭐'
        : score >= 4.0
          ? '良好 ⭐⭐⭐⭐'
          : score >= 3.5
            ? '合格 ⭐⭐⭐'
            : score >= 3.0
              ? '一般 ⭐⭐'
              : '需改进 ⭐';
    let report = `# LLM Judge评估报告

## 基本信息

- **评估日期**: ${results.evaluation_date}
- **评委模型**: ${results.judge_model}
- **评估数量**: ${results.num_problems} 个题目

## 评估结果

### 总体评分

- **平均总分**: ${metrics.average_total_score.toFixed(2)}/5.0
- **通过率**: ${markdownPercent(metrics.pass_rate)} (≥3.5分)
- **优秀率**: ${markdownPercent(metrics.excellent_rate)} (≥4.5分)

### 各维度评分

| 维度 | 平均分 | 评级 |
|------|--------|------|
`;
    const dimensionNames: Array<[string, string]> = [
      ['correctness', '正确性 (Correctness)'],
      ['clarity', '清晰度 (Clarity)'],
      ['difficulty_match', '难度匹配 (Difficulty Match)'],
      ['completeness', '完整性 (Completeness)']
    ];
    for (const [key, label] of dimensionNames) {
      const score = metrics.dimension_averages[key] ?? 0;
      report += `| ${label} | ${score.toFixed(2)}/5.0 | ${rating(score)} |\n`;
    }
    report += '\n## 详细结果\n\n';
    for (let idx = 0; idx < Math.min(results.results.length, 10); idx += 1) {
      const result = results.results[idx]!;
      report += `### 题目 ${idx + 1}: ${result.problem_id}

- **总分**: ${result.total_score.toFixed(2)}/5.0
- **各维度评分**:
  - 正确性: ${result.scores.correctness.toFixed(1)}
  - 清晰度: ${result.scores.clarity.toFixed(1)}
  - 难度匹配: ${result.scores.difficulty_match.toFixed(1)}
  - 完整性: ${result.scores.completeness.toFixed(1)}

`;
    }
    if (results.results.length > 10)
      report += '*（仅显示前10个题目的详细评分，完整结果请查看JSON文件）*\n';
    report += `\n## 结论

基于LLM Judge的评估，生成的数据集质量${metrics.average_total_score >= 4.5 ? '优秀' : metrics.average_total_score >= 3.5 ? '良好' : '需要改进'}。

---

*报告生成时间: ${new Date().toISOString()}*
`;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, report, 'utf8');
    console.log(`✅ 评估报告已保存: ${outputPath}`);
    return report;
  }
}

/* -------------------------------------------------------------------------- */
/* WinRateTool                                                                */
/* -------------------------------------------------------------------------- */

const winRateInputSchema = z
  .object({
    generated_data_path: z.string(),
    reference_data_path: z.string().optional(),
    reference_year: z.number().int().optional(),
    num_comparisons: z.number().int().positive().optional(),
    output_dir: z.string().default('evaluation_results/win_rate'),
    judge_model: z.string().default('gpt-4o')
  })
  .strict();

type WinRateInput = z.output<typeof winRateInputSchema>;

export interface WinRateToolOptions {
  llm?: WinRateLlmLike;
  rng?: () => number;
}

export class WinRateTool extends Tool<typeof winRateInputSchema> {
  public readonly llm: WinRateLlmLike | undefined;
  public readonly rng: (() => number) | undefined;

  public constructor(options: WinRateToolOptions = {}) {
    super({
      name: 'win_rate_evaluation',
      description: '通过成对对比计算生成数据相对于真题的胜率',
      inputSchema: winRateInputSchema
    });
    this.llm = options.llm;
    this.rng = options.rng;
  }

  protected async run(input: WinRateInput): Promise<ToolResponse> {
    const outputDir = input.output_dir;
    mkdirSync(outputDir, { recursive: true });
    console.log('\n' + '='.repeat(60));
    console.log('🏆 Win Rate评估');
    console.log('='.repeat(60));

    const genDataset = new AIDataset({
      datasetType: 'generated',
      dataPath: input.generated_data_path
    });
    const genProblems = genDataset.load();

    let refProblems: AimeProblem[];
    if (input.reference_data_path) {
      const refDataset = new AIDataset({
        datasetType: 'generated',
        dataPath: input.reference_data_path
      });
      refProblems = refDataset.load();
    } else if (input.reference_year) {
      throw new Error(
        `reference_year=${input.reference_year} 需要从 HuggingFace 下载 AIME 真题，TS 端不支持远程下载；` +
          `请提供 reference_data_path 指向本地 JSON 文件。`
      );
    } else {
      throw new Error('必须提供reference_data_path或reference_year之一');
    }

    const evaluator = new WinRateEvaluator({
      ...(this.llm === undefined ? {} : { llm: this.llm }),
      judgeModel: input.judge_model,
      ...(this.rng === undefined ? {} : { rng: this.rng })
    });
    const results = await evaluator.evaluateWinRate(
      genProblems as unknown as Array<Record<string, unknown>>,
      refProblems as unknown as Array<Record<string, unknown>>,
      input.num_comparisons
    );

    const resultFile = join(outputDir, `win_rate_results_${timestamp()}.json`);
    evaluator.exportResults(results, resultFile);
    const reportFile = join(outputDir, `win_rate_report_${timestamp()}.md`);
    this.generateReport(results, reportFile);

    console.log('\n' + '='.repeat(60));
    console.log('✅ Win Rate评估完成');
    console.log('='.repeat(60));
    console.log('\n📁 输出文件:');
    const report = this.generateReport(results, reportFile);
    console.log(`   - 评估结果: ${resultFile}`);
    console.log(`   - 评估报告: ${reportFile}`);
    return ToolResponse.fromObject({
      status: 'success',
      text: report,
      data: {
        metrics: results.metrics,
        result_file: resultFile,
        report_file: reportFile
      }
    });
  }

  /** 生成 Markdown 评估报告（对齐上游 `_generate_report`）。 */
  public generateReport(results: WinRateEvaluationResult, outputPath: string): string {
    const metrics = results.metrics;
    const winAnalysis =
      metrics.win_rate >= 0.55
        ? '\n✅ **优秀**: 生成数据质量超过参考数据！这表明数据生成系统表现出色。\n'
        : metrics.win_rate >= 0.45
          ? '\n✅ **良好**: 生成数据质量接近参考数据（差距<10%）。这是理想的结果，说明生成质量达到了真题水平。\n'
          : metrics.win_rate >= 0.35
            ? '\n⚠️ **合格**: 生成数据质量略低于参考数据，但仍在可接受范围内。建议进一步优化生成策略。\n'
            : '\n❌ **需改进**: 生成数据质量明显低于参考数据。建议检查生成Pipeline并进行优化。\n';
    const conclusion =
      metrics.win_rate >= 0.45
        ? `基于Win Rate评估，生成数据集的质量**接近或达到AIME真题水平**（Win Rate = ${markdownPercent(metrics.win_rate)}）。\n\n这证明了数据生成系统的有效性，生成的题目在质量上可以与真题相媲美。\n`
        : `基于Win Rate评估，生成数据集的质量**仍有提升空间**（Win Rate = ${markdownPercent(metrics.win_rate)}）。\n\n建议：\n1. 优化题目生成的提示词\n2. 增加质量过滤步骤\n3. 使用更强的生成模型\n4. 增加人工审核环节\n`;
    let report = `# Win Rate评估报告

## 基本信息

- **评估日期**: ${results.evaluation_date}
- **评委模型**: ${results.judge_model}
- **对比次数**: ${metrics.total_comparisons} 次

## 评估结果

### 胜率统计

| 指标 | 数值 | 百分比 |
|------|------|--------|
| 生成数据胜出 | ${metrics.wins} 次 | ${markdownPercent(metrics.win_rate)} |
| 参考数据胜出 | ${metrics.losses} 次 | ${markdownPercent(metrics.loss_rate)} |
| 平局 | ${metrics.ties} 次 | ${markdownPercent(metrics.tie_rate)} |

### 结果分析

**Win Rate**: ${markdownPercent(metrics.win_rate)}

${winAnalysis}
## 详细对比结果

`;
    for (let idx = 0; idx < Math.min(results.comparisons.length, 10); idx += 1) {
      const comparison = results.comparisons[idx]!;
      const winnerEmoji =
        comparison.winner === 'Generated' ? '🏆' : comparison.winner === 'Reference' ? '❌' : '🤝';
      report += `### 对比 ${idx + 1}

- **生成题目**: ${comparison.problem_a_id}
- **参考题目**: ${comparison.problem_b_id}
- **胜者**: ${winnerEmoji} ${comparison.winner}
- **理由**: ${comparison.reason}

`;
    }
    if (results.comparisons.length > 10)
      report += '*（仅显示前10次对比的详细结果，完整结果请查看JSON文件）*\n';
    report += `\n## 结论

${conclusion}
---

*报告生成时间: ${new Date().toISOString()}*
`;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, report, 'utf8');
    console.log(`✅ 评估报告已保存: ${outputPath}`);
    return report;
  }
}
