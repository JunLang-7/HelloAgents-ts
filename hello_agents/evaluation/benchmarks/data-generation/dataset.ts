/**
 * AIME 数据集加载模块（对齐上游 `evaluation/benchmarks/data_generation/dataset.py`）。
 *
 * 支持加载本地生成的题目数据（JSON）。上游的 HuggingFace AIME 真题下载
 * （`math-ai/aime25`，经 `snapshot_download`）在 TS 端不提供等价实现，
 * 返回明确报错，详见 DIFF-042。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/** AIME 题目（统一格式）。 */
export interface AimeProblem {
  problem_id: string;
  problem: string;
  answer: string;
  solution: string;
  difficulty: number | null;
  topic: string | null;
}

export interface AIDatasetOptions {
  /** 数据集类型：`generated`（生成的）或 `real`（真题）。 */
  datasetType?: 'generated' | 'real';
  /** 本地数据路径（generated 类型必填）。 */
  dataPath?: string;
  /** AIME 年份（real 类型用；TS 端不支持远程下载）。 */
  year?: number;
  cacheDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof item[key] === 'string') return item[key];
  }
  return '';
}

function numberField(item: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (typeof item[key] === 'number') return item[key];
  }
  return null;
}

export class AIDataset {
  public readonly datasetType: 'generated' | 'real';
  public readonly dataPath: string | undefined;
  public readonly year: number | undefined;
  public readonly cacheDir: string;
  public problems: AimeProblem[] = [];

  public constructor(options: AIDatasetOptions = {}) {
    this.datasetType = options.datasetType ?? 'generated';
    this.dataPath = options.dataPath;
    this.year = options.year;
    this.cacheDir = options.cacheDir ?? `${homedir()}/.cache/hello_agents/aime`;
  }

  /** 加载数据集。 */
  public load(): AimeProblem[] {
    if (this.datasetType === 'generated') return this.loadGeneratedData();
    if (this.datasetType === 'real') return this.loadRealData();
    throw new Error(`Unknown dataset_type: ${this.datasetType}`);
  }

  /** 加载生成的数据（对齐上游 `_load_generated_data`）。 */
  public loadGeneratedData(): AimeProblem[] {
    if (!this.dataPath) throw new Error('data_path is required for generated dataset');
    if (!existsSync(this.dataPath)) {
      throw new Error(`Data file not found: ${this.dataPath}`);
    }
    console.log(`📥 加载生成数据: ${this.dataPath}`);
    const data: unknown = JSON.parse(readFileSync(this.dataPath, 'utf8'));
    if (!Array.isArray(data)) {
      throw new Error(`Expected a JSON array at: ${this.dataPath}`);
    }
    const problems: AimeProblem[] = [];
    data.forEach((raw, idx) => {
      const item = isRecord(raw) ? raw : {};
      problems.push({
        problem_id: typeof item.id === 'string' ? item.id : `gen_${idx}`,
        problem: stringField(item, ['problem', 'question']),
        answer: stringField(item, ['answer']),
        solution: stringField(item, ['solution', 'reasoning']),
        difficulty: numberField(item, ['difficulty']),
        topic: stringField(item, ['topic', 'category']) || null
      });
    });
    this.problems = problems;
    console.log(`✅ 加载了 ${problems.length} 个生成题目`);
    return problems;
  }

  /**
   * 从 HuggingFace 加载 AIME 真题（上游 `snapshot_download`）。
   *
   * TS 端不内置 `huggingface_hub` 等价实现：明确报错并给出指引（本地文件 /
   * Python 环境），见 DIFF-042。
   */
  public loadRealData(): AimeProblem[] {
    if (!this.year) throw new Error('year is required for real dataset');
    throw new Error(
      `TS 端不支持从 HuggingFace 下载 AIME 真题（math-ai/aime25 需要 huggingface_hub 与 HF 凭据）。` +
        `请先通过 Python ` +
        `\`huggingface_hub.snapshot_download\` 下载，再以 datasetType="generated" + dataPath 加载本地文件。`
    );
  }

  /** 根据 ID 获取问题。 */
  public getProblem(problemId: string): AimeProblem | undefined {
    return this.problems.find((p) => p.problem_id === problemId);
  }

  /** 根据主题获取问题。 */
  public getProblemsByTopic(topic: string): AimeProblem[] {
    return this.problems.filter((p) => p.topic === topic);
  }

  /** 根据难度范围获取问题。 */
  public getProblemsByDifficulty(minDiff: number, maxDiff: number): AimeProblem[] {
    return this.problems.filter(
      (p) => p.difficulty !== null && p.difficulty >= minDiff && p.difficulty <= maxDiff
    );
  }

  /** 数据集大小。 */
  public get length(): number {
    return this.problems.length;
  }

  /** 支持索引访问。 */
  public getItem(idx: number): AimeProblem {
    return this.problems[idx]!;
  }
}
