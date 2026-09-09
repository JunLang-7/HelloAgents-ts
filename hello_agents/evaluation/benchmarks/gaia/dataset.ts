/**
 * GAIA 数据集加载模块（对齐上游 `evaluation/benchmarks/gaia/dataset.py`）。
 *
 * 支持从本地数据目录加载 GAIA 数据。上游的 HuggingFace `snapshot_download`
 * 远程下载（gated dataset，需 HF_TOKEN 与访问权限）在 TS 端不提供等价
 * 实现：远程路径返回空数据并给出明确指引，详见 DIFF-042。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** GAIA 标准化样本。 */
export interface GaiaItem {
  task_id: string;
  question: string;
  level: number;
  final_answer: string;
  file_name: string;
  file_path: string;
  annotator_metadata: Record<string, unknown>;
  steps: number;
  tools: unknown[];
  raw_item: Record<string, unknown>;
}

export interface GAIADatasetOptions {
  datasetName?: string;
  split?: string;
  level?: number;
  localDataDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 将 GAIA 的 level 字段（官方数据为字符串 '1'/'2'/'3'，部分数据集为 number）
 * 归一化为整数；非法值回退到 1（对齐上游默认值语义）。
 */
function normalizeGaiaLevel(value: unknown, fallback: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 1;
}

/** 标准化数据项格式（对齐上游 `_standardize_item`）。 */
export function standardizeGaiaItem(item: Record<string, unknown>): GaiaItem {
  return {
    task_id: typeof item.task_id === 'string' ? item.task_id : '',
    question:
      (typeof item.Question === 'string' ? item.Question : '') ||
      (typeof item.question === 'string' ? item.question : ''),
    level: normalizeGaiaLevel(item.Level, item.level),
    final_answer:
      (typeof item['Final answer'] === 'string' ? item['Final answer'] : '') ||
      (typeof item.final_answer === 'string' ? item.final_answer : ''),
    file_name: typeof item.file_name === 'string' ? item.file_name : '',
    file_path: typeof item.file_path === 'string' ? item.file_path : '',
    annotator_metadata: isRecord(item['Annotator Metadata'])
      ? item['Annotator Metadata']
      : isRecord(item.annotator_metadata)
        ? item.annotator_metadata
        : {},
    steps:
      (typeof item.Steps === 'number' ? item.Steps : undefined) ??
      (typeof item.steps === 'number' ? item.steps : 0),
    tools: Array.isArray(item.Tools) ? item.Tools : Array.isArray(item.tools) ? item.tools : [],
    raw_item: item
  };
}

/** 递归收集目录下所有匹配文件名模式的 JSON 文件。 */
export function collectJsonFiles(
  dir: string,
  filterName: (name: string) => boolean,
  out: string[] = []
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectJsonFiles(full, filterName, out);
    } else if (stat.isFile() && entry.endsWith('.json') && filterName(entry.toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

export class GAIADataset {
  public readonly datasetName: string;
  public readonly split: string;
  public readonly level: number | undefined;
  public readonly localDataDir: string | undefined;
  public data: GaiaItem[] = [];
  private readonly isLocal: boolean;

  public constructor(options: GAIADatasetOptions = {}) {
    this.datasetName = options.datasetName ?? 'gaia-benchmark/GAIA';
    this.split = options.split ?? 'validation';
    this.level = options.level;
    this.localDataDir = options.localDataDir;
    this.isLocal = Boolean(this.localDataDir && existsSync(this.localDataDir));
  }

  /** 加载数据集（本地目录优先；远程路径明确报不可用）。 */
  public load(): GaiaItem[] {
    if (this.isLocal) {
      this.data = this.loadFromLocal();
    } else {
      this.data = this.loadFromRemote();
    }
    if (this.level !== undefined) {
      this.data = this.data.filter((item) => item.level === this.level);
    }
    console.log('✅ GAIA数据集加载完成');
    console.log(`   数据源: ${this.datasetName}`);
    console.log(`   分割: ${this.split}`);
    console.log(`   级别: ${this.level ?? '全部'}`);
    console.log(`   样本数: ${this.data.length}`);
    return this.data;
  }

  /** 从本地加载数据集（对齐上游 `_load_from_local`）。 */
  public loadFromLocal(): GaiaItem[] {
    const data: GaiaItem[] = [];
    if (!this.localDataDir || !existsSync(this.localDataDir)) {
      console.log('   ⚠️ 本地数据目录不存在');
      return data;
    }
    const jsonFiles = collectJsonFiles(this.localDataDir, (name) => name.includes('gaia'));
    for (const jsonFile of jsonFiles) {
      try {
        const fileData: unknown = JSON.parse(readFileSync(jsonFile, 'utf8'));
        if (Array.isArray(fileData)) {
          for (const item of fileData) {
            if (isRecord(item)) data.push(standardizeGaiaItem(item));
          }
          console.log(`   加载文件: ${jsonFile.split('/').pop()} (${fileData.length} 样本)`);
        } else if (isRecord(fileData)) {
          data.push(standardizeGaiaItem(fileData));
          console.log(`   加载文件: ${jsonFile.split('/').pop()} (1 样本)`);
        }
      } catch (error) {
        console.log(`   ⚠️ 加载文件失败: ${jsonFile.split('/').pop()} - ${String(error)}`);
      }
    }
    return data;
  }

  /**
   * 远程加载（上游 HuggingFace gated 下载）。
   *
   * TS 端不内置 `huggingface_hub.snapshot_download` 等价实现：返回空数据并
   * 给出明确指引（本地数据目录 / Python 环境），见 DIFF-042。
   */
  public loadFromRemote(): GaiaItem[] {
    console.log(`   ⚠️ GAIA 是 HuggingFace gated 数据集（需 HF_TOKEN 与访问权限）`);
    console.log('   TS 端不支持远程 snapshot_download 下载；请提供本地数据目录：');
    console.log('     new GAIADataset({ localDataDir: "path/to/gaia/json" })');
    console.log('   或在 Python 环境中使用 huggingface_hub 下载后通过本地目录加载。');
    return [];
  }

  /** 获取单个样本。 */
  public getSample(index: number): GaiaItem {
    if (this.data.length === 0) this.load();
    return index < this.data.length ? (this.data[index] ?? ({} as GaiaItem)) : ({} as GaiaItem);
  }

  /** 获取指定难度级别的样本。 */
  public getByLevel(level: number): GaiaItem[] {
    if (this.data.length === 0) this.load();
    return this.data.filter((item) => item.level === level);
  }

  /** 获取难度级别分布。 */
  public getLevelDistribution(): Record<number, number> {
    if (this.data.length === 0) this.load();
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (const item of this.data) {
      const level = item.level in distribution ? item.level : 1;
      distribution[level]! += 1;
    }
    return distribution;
  }

  /** 获取数据集统计信息。 */
  public getStatistics(): Record<string, unknown> {
    if (this.data.length === 0) this.load();
    const levelDist = this.getLevelDistribution();
    const withFiles = this.data.filter((item) => item.file_name).length;
    const stepsList = this.data.filter((item) => item.steps).map((item) => item.steps);
    const avgSteps =
      stepsList.length > 0 ? stepsList.reduce((a, b) => a + b, 0) / stepsList.length : 0;
    return {
      total_samples: this.data.length,
      level_distribution: levelDist,
      samples_with_files: withFiles,
      average_steps: avgSteps,
      split: this.split
    };
  }

  /** 数据集大小。 */
  public get length(): number {
    if (this.data.length === 0) this.load();
    return this.data.length;
  }

  /** 迭代器。 */
  public [Symbol.iterator](): Iterator<GaiaItem> {
    if (this.data.length === 0) this.load();
    return this.data[Symbol.iterator]();
  }
}
