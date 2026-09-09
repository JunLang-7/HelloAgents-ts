/**
 * RL 训练数据集（对齐上游 `rl/datasets.py`）。
 *
 * 数据格式化逻辑（SFT / RL 模板、#### 答案提取）为纯函数，具备确定性
 * 对照测试。远程 HuggingFace 下载（openai/gsm8k）在 TS 端不内置等价实现：
 * 通过本地数据目录加载；未提供本地数据时明确报错并给出下载指引（DIFF-047）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** GSM8K 原始样本（上游 `load_dataset("openai/gsm8k", "main")` 的行结构）。 */
export interface Gsm8kRawItem {
  question: string;
  answer: string;
}

/** SFT 格式化样本。 */
export interface SftExample {
  prompt: string;
  completion: string;
  text: string;
}

/** RL 格式化样本（standard format）。 */
export interface RlExample {
  prompt: string;
  ground_truth: string;
  question: string;
  full_answer: string;
}

export type Gsm8kExample = SftExample | RlExample;

export type ChatTemplateFn = (messages: { role: string; content: string }[]) => string;

/** 从 GSM8K 答案中提取推理与最终答案（对齐上游 `####` 分割）。 */
export function splitGsm8kAnswer(answer: string): {
  reasoning: string;
  finalAnswer: string;
} {
  if (answer.includes('####')) {
    const [reasoning, finalAnswer] = answer.split('####');
    return {
      reasoning: (reasoning ?? '').trim(),
      finalAnswer: (finalAnswer ?? '').trim()
    };
  }
  return { reasoning: answer.trim(), finalAnswer: '' };
}

/** 格式化为 SFT 训练格式（对齐上游 `format_for_sft`）。 */
export function formatForSft(question: string, answer: string): SftExample {
  const { reasoning, finalAnswer } = splitGsm8kAnswer(answer);
  const prompt = `Question: ${question}\n\nLet's solve this step by step:\n`;
  const completion = `${reasoning}\n\nFinal Answer: ${finalAnswer}`;
  return { prompt, completion, text: prompt + completion };
}

/** 格式化为 RL 训练格式（对齐上游 `format_for_rl`）。 */
export function formatForRl(
  question: string,
  answer: string,
  chatTemplate?: ChatTemplateFn
): RlExample {
  const { finalAnswer } = splitGsm8kAnswer(answer);
  const promptContent = `Question: ${question}\n\nLet's solve this step by step:`;
  const promptText = chatTemplate
    ? chatTemplate([{ role: 'user', content: promptContent }])
    : promptContent;
  return {
    prompt: promptText,
    ground_truth: finalAnswer,
    question,
    full_answer: answer
  };
}

export interface GSM8KDatasetOptions {
  split?: string;
  max_samples?: number;
  format_type?: 'sft' | 'rl';
  /** 本地数据目录（JSON 数组或 JSONL，含 question/answer 字段）。 */
  dataDir?: string;
  /** 用于 RL 格式应用 chat template（对齐上游 tokenizer 注入）。 */
  chatTemplate?: ChatTemplateFn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toGsm8kRaw(item: Record<string, unknown>): Gsm8kRawItem {
  return {
    question: typeof item.question === 'string' ? item.question : '',
    answer: typeof item.answer === 'string' ? item.answer : ''
  };
}

/** 读取本地 GSM8K 数据（JSON 数组或逐行 JSONL）。
 *
 * 当提供 `split` 时只读取匹配该 split 的文件（如 `gsm8k_train.json` /
 * `gsm8k_train.jsonl` 或 `train.json` / `train.jsonl`），避免 train/test 混用。
 */
export function loadGsm8kLocal(dataDir: string, split?: string): Gsm8kRawItem[] {
  const items: Gsm8kRawItem[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    throw new Error(`本地数据目录不存在: ${dataDir}`);
  }
  const jsonFiles = entries
    .filter((name) => name.endsWith('.json') || name.endsWith('.jsonl'))
    .filter((name) => {
      if (!split) return true;
      return (
        name.endsWith(`_${split}.json`) ||
        name.endsWith(`_${split}.jsonl`) ||
        name === `${split}.json` ||
        name === `${split}.jsonl`
      );
    })
    .sort();
  if (jsonFiles.length === 0) {
    throw new Error(
      split === undefined
        ? `本地数据目录中没有 JSON/JSONL 文件: ${dataDir}`
        : `本地数据目录中没有匹配 split='${split}' 的 JSON/JSONL 文件（如 gsm8k_${split}.json）: ${dataDir}`
    );
  }
  for (const name of jsonFiles) {
    const full = join(dataDir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const text = readFileSync(full, 'utf8');
    if (name.endsWith('.jsonl')) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) items.push(toGsm8kRaw(parsed));
        } catch {
          // 跳过坏行（对齐上游 map 语义不中断）
        }
      }
    } else {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (isRecord(item)) items.push(toGsm8kRaw(item));
          }
        } else if (isRecord(parsed)) {
          items.push(toGsm8kRaw(parsed));
        }
      } catch {
        // 坏 JSON 文件跳过
      }
    }
  }
  return items;
}

export class GSM8KDataset {
  public readonly split: string;
  public readonly max_samples: number | undefined;
  public readonly format_type: 'sft' | 'rl';
  public readonly dataDir: string | undefined;
  public readonly chatTemplate: ChatTemplateFn | undefined;
  private rawItems: Gsm8kRawItem[] = [];

  public constructor(options: GSM8KDatasetOptions = {}) {
    this.split = options.split ?? 'train';
    this.max_samples = options.max_samples;
    this.format_type = options.format_type ?? 'sft';
    this.dataDir = options.dataDir;
    this.chatTemplate = options.chatTemplate;
  }

  /** 加载数据集（本地目录；远程明确报错 + 指引）。 */
  public load(): void {
    if (!this.dataDir || !existsSync(this.dataDir)) {
      throw new Error(
        'TS 端不内置 HuggingFace 下载（openai/gsm8k）。请提供本地数据目录：' +
          `\n  new GSM8KDataset({ dataDir: "path/to/gsm8k" })` +
          '\n数据可从 https://huggingface.co/datasets/openai/gsm8k 下载（JSONL 行含 question/answer 字段）。'
      );
    }
    let items = loadGsm8kLocal(this.dataDir, this.split);
    if (this.max_samples !== undefined && this.max_samples > 0) {
      items = items.slice(0, Math.min(this.max_samples, items.length));
    }
    this.rawItems = items;
    console.log(`✅ GSM8K 数据集加载完成 (split=${this.split})`);
    console.log(`   样本数: ${items.length}`);
  }

  /** 格式化单个样本（对齐上游 `format_for_sft` / `format_for_rl`）。 */
  public formatExample(example: Gsm8kRawItem): Gsm8kExample {
    return this.format_type === 'sft'
      ? formatForSft(example.question, example.answer)
      : formatForRl(example.question, example.answer, this.chatTemplate);
  }

  /** 获取格式化后的数据集（对齐上游 `get_dataset`）。 */
  public getDataset(): Gsm8kExample[] {
    if (this.rawItems.length === 0) this.load();
    return this.rawItems.map((item) => this.formatExample(item));
  }

  /** 原始样本数（对齐上游 `__len__`；仅本地数据可数）。 */
  public get length(): number {
    if (this.rawItems.length === 0) this.load();
    return this.rawItems.length;
  }

  /** 获取单个格式化样本（对齐上游 `__getitem__`）。 */
  public getItem(idx: number): Gsm8kExample {
    if (this.rawItems.length === 0) this.load();
    const item = this.rawItems[idx];
    if (!item) throw new Error(`Index out of range: ${idx}`);
    return this.formatExample(item);
  }
}

/** 创建数学推理数据集（对齐上游 `create_math_dataset`；仅支持 gsm8k）。 */
export function createMathDataset(
  options: {
    dataset_name?: string;
    split?: string;
    max_samples?: number;
    format_type?: 'sft' | 'rl';
    dataDir?: string;
    chatTemplate?: ChatTemplateFn;
  } = {}
): Gsm8kExample[] {
  const datasetName = (options.dataset_name ?? 'gsm8k').toLowerCase();
  if (datasetName !== 'gsm8k') {
    throw new Error(`不支持的数据集: ${options.dataset_name}`);
  }
  const wrapper = new GSM8KDataset({
    split: options.split ?? 'train',
    ...(options.max_samples !== undefined ? { max_samples: options.max_samples } : {}),
    format_type: options.format_type ?? 'sft',
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.chatTemplate !== undefined ? { chatTemplate: options.chatTemplate } : {})
  });
  return wrapper.getDataset();
}

/** 将自定义数据集转换为训练格式（对齐上游 `format_math_dataset`）。 */
export function formatMathDataset(
  dataset: Array<Record<string, unknown>>,
  options: {
    format_type?: 'sft' | 'rl';
    /** 对齐上游 tokenizer.apply_chat_template；缺失时用原始文本。 */
    chatTemplate?: ChatTemplateFn;
  } = {}
): Gsm8kExample[] {
  const formatType = options.format_type ?? 'sft';
  const out: Gsm8kExample[] = [];
  for (const raw of dataset) {
    const item = toGsm8kRaw(raw);
    out.push(
      formatType === 'sft'
        ? formatForSft(item.question, item.answer)
        : formatForRl(item.question, item.answer, options.chatTemplate)
    );
  }
  return out;
}

/** 创建 SFT 训练数据集（便捷函数，对齐上游 `create_sft_dataset`）。 */
export function createSftDataset(
  maxSamples = 1000,
  split = 'train',
  dataDir?: string
): Gsm8kExample[] {
  return createMathDataset({
    dataset_name: 'gsm8k',
    split,
    max_samples: maxSamples,
    format_type: 'sft',
    ...(dataDir !== undefined ? { dataDir } : {})
  });
}

/** 创建 RL 训练数据集（便捷函数，对齐上游 `create_rl_dataset`）。 */
export function createRlDataset(
  maxSamples = 500,
  split = 'train',
  options: { dataDir?: string; chatTemplate?: ChatTemplateFn } = {}
): Gsm8kExample[] {
  return createMathDataset({
    dataset_name: 'gsm8k',
    split,
    max_samples: maxSamples,
    format_type: 'rl',
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.chatTemplate !== undefined ? { chatTemplate: options.chatTemplate } : {})
  });
}

/** 预览数据集样本（对齐上游 `preview_dataset`）。 */
export function previewDataset(dataset: Gsm8kExample[], numSamples = 3): void {
  console.log(`\n📋 数据集预览（前 ${numSamples} 个样本）:`);
  console.log('='.repeat(80));
  for (let i = 0; i < Math.min(numSamples, dataset.length); i += 1) {
    const sample = dataset[i] ?? {};
    console.log(`\n样本 ${i + 1}:`);
    console.log('-'.repeat(80));
    for (const [key, value] of Object.entries(sample)) {
      let valueStr = String(value);
      if (valueStr.length > 200) valueStr = valueStr.slice(0, 200) + '...';
      console.log(`${key}: ${valueStr}`);
    }
  }
  console.log('='.repeat(80) + '\n');
}
