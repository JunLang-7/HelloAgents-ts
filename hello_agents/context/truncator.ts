/** 导致观测预览被截断的限制类型。 */
export type TruncationReason = 'line_limit' | 'byte_limit';
/** 预览内容，以及指向内存中完整观测结果的稳定引用。 */
export interface TruncationResult {
  readonly preview: string;
  readonly truncated: boolean;
  readonly full_output_id?: string;
  readonly reason?: TruncationReason;
}
export interface ObservationTruncatorOptions {
  /** 预览中最多暴露的源文本行数。 */
  readonly maxLines?: number;
  /** 预览中最多暴露的 UTF-8 字节数。 */
  readonly maxBytes?: number;
  /** 按行截断时从开头保留的行数。 */
  readonly headLines?: number;
  /** 按行截断时从结尾保留的行数。 */
  readonly tailLines?: number;
}

function utf8Prefix(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = '';
  for (const character of text) {
    if (encoder.encode(result + character).length > maxBytes) break;
    result += character;
  }
  return result;
}

function utf8Suffix(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = '';
  for (const character of [...text].reverse()) {
    if (encoder.encode(character + result).length > maxBytes) break;
    result = character + result;
  }
  return result;
}

function markerForBudget(outputId: string, maxBytes: number): string {
  const full = `… (输出已截断；完整内容: ${outputId}) …`;
  if (new TextEncoder().encode(full).length <= maxBytes) return full;
  return utf8Prefix(`…[${outputId}]…`, maxBytes);
}

/** 在内存中保存完整观测，同时向 LLM 暴露有界预览。 */
export class ObservationTruncator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly headLines: number;
  private readonly tailLines: number;
  private readonly outputs = new Map<string, string>();

  public constructor(options: ObservationTruncatorOptions = {}) {
    this.maxLines = options.maxLines ?? 200;
    this.maxBytes = options.maxBytes ?? 32_000;
    this.headLines = options.headLines ?? 20;
    this.tailLines = options.tailLines ?? 20;
  }

  /**
   * 保存完整输出，并返回受行数和 UTF-8 字节数限制的 LLM 预览。
   *
   * @param output 原始输出。
   * @param outputId 完整输出的稳定 ID。
   * @returns 截断结果，包含预览和完整输出引用。
   */
  public truncate(output: string, outputId: string): TruncationResult {
    this.outputs.set(outputId, output);
    const bytes = new TextEncoder().encode(output).length;
    const lines = output.split('\n');
    if (lines.length <= this.maxLines && bytes <= this.maxBytes)
      return { preview: output, truncated: false };
    const reason: TruncationReason = lines.length > this.maxLines ? 'line_limit' : 'byte_limit';
    const marker = `… (输出已截断；完整内容: ${outputId}) …`;
    let preview: string;
    if (reason === 'line_limit') {
      preview = [...lines.slice(0, this.headLines), marker, ...lines.slice(-this.tailLines)].join(
        '\n'
      );
    } else {
      const boundedMarker = markerForBudget(outputId, this.maxBytes);
      const available = Math.max(0, this.maxBytes - new TextEncoder().encode(boundedMarker).length);
      preview = `${utf8Prefix(output, Math.floor(available / 2))}${boundedMarker}${utf8Suffix(
        output,
        Math.ceil(available / 2)
      )}`;
    }
    return { preview, truncated: true, full_output_id: outputId, reason };
  }

  /** 根据输出 ID 获取之前保存的完整观测。 */
  public getFullOutput(outputId: string): string | undefined {
    return this.outputs.get(outputId);
  }
}
