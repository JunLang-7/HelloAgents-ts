/**
 * BFCL 数据集加载模块（对齐上游 `evaluation/benchmarks/bfcl/dataset.py`）。
 *
 * 负责从 BFCL 官方数据目录加载 Berkeley Function Calling Leaderboard
 * 数据集，包括测试数据与 ground truth。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** BFCL 样本的宽松形状。 */
export interface BfclSample {
  id?: string;
  question?: unknown;
  function?: unknown;
  ground_truth?: unknown;
  category?: string;
  [key: string]: unknown;
}

/** BFCL v4 标准类别映射（对齐上游 `CATEGORY_MAPPING`）。 */
export const BFCL_CATEGORY_MAPPING: Record<string, string> = {
  simple_python: 'BFCL_v4_simple_python',
  simple_java: 'BFCL_v4_simple_java',
  simple_javascript: 'BFCL_v4_simple_javascript',
  multiple: 'BFCL_v4_multiple',
  parallel: 'BFCL_v4_parallel',
  parallel_multiple: 'BFCL_v4_parallel_multiple',
  irrelevance: 'BFCL_v4_irrelevance',
  live_simple: 'BFCL_v4_live_simple',
  live_multiple: 'BFCL_v4_live_multiple',
  live_parallel: 'BFCL_v4_live_parallel',
  live_parallel_multiple: 'BFCL_v4_live_parallel_multiple',
  live_irrelevance: 'BFCL_v4_live_irrelevance',
  live_relevance: 'BFCL_v4_live_relevance',
  multi_turn_base: 'BFCL_v4_multi_turn_base',
  multi_turn_miss_func: 'BFCL_v4_multi_turn_miss_func',
  multi_turn_miss_param: 'BFCL_v4_multi_turn_miss_param',
  multi_turn_long_context: 'BFCL_v4_multi_turn_long_context',
  memory: 'BFCL_v4_memory',
  web_search: 'BFCL_v4_web_search'
};

export interface BFCLDatasetOptions {
  /** BFCL 官方数据目录路径（含 `BFCL_v4_*.json` 文件与 `possible_answer/`）。 */
  dataDir?: string;
  /** 评估类别，如 `simple_python`、`multiple` 等。 */
  category?: string;
}

/** 逐行解析 JSON/JSONL 文件；坏行跳过并计数（对齐上游 `_load_jsonl_file`）。 */
export function loadJsonlFile(filePath: string): {
  items: Array<Record<string, unknown>>;
  skipped: number;
} {
  const items: Array<Record<string, unknown>> = [];
  let skipped = 0;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        items.push(parsed as Record<string, unknown>);
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { items, skipped };
}

export class BFCLDataset {
  /** BFCL v4 标准类别映射。 */
  public static readonly CATEGORY_MAPPING: Record<string, string> = BFCL_CATEGORY_MAPPING;

  public readonly dataDir: string;
  public readonly category: string | undefined;
  public readonly answerDir: string;
  public data: BfclSample[] = [];
  public groundTruth: Record<string, unknown> = {};

  /** 构建数据集加载器。 */
  public constructor(options: BFCLDatasetOptions = {}) {
    this.dataDir =
      options.dataDir ?? './temp_gorilla/berkeley-function-call-leaderboard/bfcl_eval/data';
    this.category = options.category;
    this.answerDir = join(this.dataDir, 'possible_answer');
    if (!existsSync(this.dataDir)) {
      console.log(`   ⚠️ BFCL数据目录不存在: ${this.dataDir}`);
      console.log('   请确保已克隆BFCL仓库到正确位置');
    }
    if (!existsSync(this.answerDir)) {
      console.log(`   ⚠️ Ground truth目录不存在: ${this.answerDir}`);
    }
  }

  /** 加载数据集（测试数据 + ground truth；类别缺省时加载 simple_python 示例）。 */
  public load(): BfclSample[] {
    if (!existsSync(this.dataDir)) {
      console.log('   ⚠️ 数据目录不存在，无法加载数据');
      return [];
    }
    if (this.category) {
      const filename = BFCL_CATEGORY_MAPPING[this.category];
      if (!filename) {
        console.log(`   ⚠️ 未知类别: ${this.category}`);
        console.log(`   支持的类别: ${Object.keys(BFCL_CATEGORY_MAPPING).join(', ')}`);
        return [];
      }
      this.data = this.loadCategory(filename);
    } else {
      console.log('   ⚠️ 未指定类别，将加载simple_python作为示例');
      this.data = this.loadCategory(BFCL_CATEGORY_MAPPING.simple_python!);
    }
    console.log('✅ BFCL数据集加载完成');
    console.log(`   数据目录: ${this.dataDir}`);
    console.log(`   类别: ${this.category ?? 'simple_python'}`);
    console.log(`   样本数: ${this.data.length}`);
    console.log(`   Ground truth数: ${Object.keys(this.groundTruth).length}`);
    return this.data;
  }

  /** 加载指定类别的数据（测试数据 + ground truth 合并）。 */
  public loadCategory(filename: string): BfclSample[] {
    const testFile = join(this.dataDir, `${filename}.json`);
    if (!existsSync(testFile)) {
      console.log(`   ⚠️ 测试数据文件不存在: ${testFile}`);
      return [];
    }
    const testData = loadJsonlFile(testFile);
    console.log(`   ✓ 加载测试数据: ${filename}.json (${testData.items.length} 样本)`);

    const gtFile = join(this.answerDir, `${filename}.json`);
    if (existsSync(gtFile)) {
      const gtData = loadJsonlFile(gtFile);
      for (const item of gtData.items) {
        const itemId = typeof item.id === 'string' ? item.id : undefined;
        if (itemId !== undefined) this.groundTruth[itemId] = item.ground_truth ?? [];
      }
      console.log(`   ✓ 加载ground truth: ${filename}.json (${gtData.items.length} 样本)`);
    } else {
      console.log(`   ⚠️ Ground truth文件不存在: ${gtFile}`);
    }

    const merged: BfclSample[] = [];
    for (const item of testData.items) {
      const itemId = typeof item.id === 'string' ? item.id : undefined;
      if (itemId && itemId in this.groundTruth) {
        merged.push({ ...item, ground_truth: this.groundTruth[itemId] });
      } else {
        merged.push({ ...item });
      }
    }
    return merged;
  }

  /** 获取指定样本的 ground truth。 */
  public getGroundTruth(sampleId: string): unknown {
    return this.groundTruth[sampleId] ?? [];
  }

  /** 获取单个样本。 */
  public getSample(index: number): BfclSample {
    if (this.data.length === 0) this.load();
    return index < this.data.length ? (this.data[index] ?? {}) : {};
  }

  /** 获取所有可用类别。 */
  public getAvailableCategories(): string[] {
    return Object.keys(BFCL_CATEGORY_MAPPING);
  }

  /** 数据集大小。 */
  public get length(): number {
    if (this.data.length === 0) this.load();
    return this.data.length;
  }

  /** 迭代器。 */
  public [Symbol.iterator](): Iterator<BfclSample> {
    if (this.data.length === 0) this.load();
    return this.data[Symbol.iterator]();
  }
}
