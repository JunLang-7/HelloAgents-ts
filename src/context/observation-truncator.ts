export type TruncationReason = 'line_limit' | 'byte_limit';
export interface TruncationResult {
  readonly preview: string;
  readonly truncated: boolean;
  readonly full_output_id?: string;
  readonly reason?: TruncationReason;
}
export interface ObservationTruncatorOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly headLines?: number;
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

/** Stores full observations in memory while exposing bounded LLM previews. */
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

  public getFullOutput(outputId: string): string | undefined {
    return this.outputs.get(outputId);
  }
}
