/**
 * 文档处理 primitives（上游 `memory/rag/document.py` 的教学版移植）。
 *
 * 文档与分块 ID 使用 MD5 保持和 Python 实现的可重复性；处理器保留
 * Markdown/中文文本常用的分隔符优先级，并在没有自然边界时按字符切分。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type DocumentMetadata = Record<string, unknown>;

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

/** Python `len`/slice 的字符串语义：按 Unicode code point，而不是 UTF-16 code unit。 */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

function codePointPrefix(value: string, length: number): string {
  return Array.from(value).slice(0, length).join('');
}

/** 输入文档。 */
export class Document {
  public content: string;
  public metadata: DocumentMetadata;
  public doc_id: string;

  public constructor(content: string, metadata: DocumentMetadata = {}, doc_id?: string) {
    this.content = content;
    this.metadata = { ...metadata };
    this.doc_id = doc_id ?? md5(content);
  }

  /** JavaScript 风格的别名；线格式仍使用上游 snake_case 字段。 */
  public get docId(): string {
    return this.doc_id;
  }

  public set docId(value: string) {
    this.doc_id = value;
  }
}

/** 文档分块。 */
export class DocumentChunk {
  public content: string;
  public metadata: DocumentMetadata;
  public chunk_id: string;
  public doc_id: string | undefined;
  public chunk_index: number;

  public constructor(
    content: string,
    metadata: DocumentMetadata = {},
    chunk_id?: string,
    doc_id?: string,
    chunk_index = 0
  ) {
    this.content = content;
    this.metadata = { ...metadata };
    this.doc_id = doc_id;
    this.chunk_index = chunk_index;
    this.chunk_id =
      chunk_id ?? md5(`${doc_id ?? 'undefined'}_${chunk_index}_${codePointPrefix(content, 50)}`);
  }

  public get chunkId(): string {
    return this.chunk_id;
  }

  public set chunkId(value: string) {
    this.chunk_id = value;
  }

  public get docId(): string | undefined {
    return this.doc_id;
  }

  public set docId(value: string | undefined) {
    this.doc_id = value;
  }

  public get chunkIndex(): number {
    return this.chunk_index;
  }

  public set chunkIndex(value: number) {
    this.chunk_index = value;
  }
}

/** 将文档按字符长度分成带重叠的块。 */
export class DocumentProcessor {
  public readonly chunk_size: number;
  public readonly chunk_overlap: number;
  public readonly separators: readonly string[];

  public constructor(
    chunk_size = 1000,
    chunk_overlap = 200,
    separators: readonly string[] = ['\n\n', '\n', '。', '.', ' ']
  ) {
    this.chunk_size = chunk_size;
    this.chunk_overlap = chunk_overlap;
    // Python 使用 `separators or [...]`：空列表也会触发默认分隔符。
    this.separators = separators.length > 0 ? [...separators] : ['\n\n', '\n', '。', '.', ' '];
  }

  public get chunkSize(): number {
    return this.chunk_size;
  }

  public get chunkOverlap(): number {
    return this.chunk_overlap;
  }

  /** 处理单份文档并补充分块元数据。 */
  public process_document(document: Document): DocumentChunk[] {
    const chunks = this._split_text(document.content);
    return chunks.map((chunkContent, index) => {
      const chunkMetadata: DocumentMetadata = {
        ...document.metadata,
        doc_id: document.doc_id,
        chunk_index: index,
        total_chunks: chunks.length,
        processed_at: new Date().toISOString()
      };
      return new DocumentChunk(chunkContent, chunkMetadata, undefined, document.doc_id, index);
    });
  }

  /** JavaScript 风格别名。 */
  public processDocument(document: Document): DocumentChunk[] {
    return this.process_document(document);
  }

  /** 批量处理文档。 */
  public process_documents(documents: readonly Document[]): DocumentChunk[] {
    return documents.flatMap((document) => this.process_document(document));
  }

  public processDocuments(documents: readonly Document[]): DocumentChunk[] {
    return this.process_documents(documents);
  }

  /** 合并同一文档中相邻且长度允许的小块。此行为与上游一致，会更新首块。 */
  public merge_chunks(chunks: DocumentChunk[], max_length = 2000): DocumentChunk[] {
    if (chunks.length === 0) return [];

    const mergedChunks: DocumentChunk[] = [];
    let currentChunk = chunks[0]!;
    for (const nextChunk of chunks.slice(1)) {
      const combinedLength =
        codePointLength(currentChunk.content) + codePointLength(nextChunk.content);
      if (combinedLength <= max_length && currentChunk.doc_id === nextChunk.doc_id) {
        currentChunk.content += `\n${nextChunk.content}`;
        currentChunk.metadata.total_chunks = Number(currentChunk.metadata.total_chunks ?? 1) + 1;
      } else {
        mergedChunks.push(currentChunk);
        currentChunk = nextChunk;
      }
    }
    mergedChunks.push(currentChunk);
    return mergedChunks;
  }

  public mergeChunks(chunks: DocumentChunk[], maxLength = 2000): DocumentChunk[] {
    return this.merge_chunks(chunks, maxLength);
  }

  /** 过滤去掉过短的块（按去除首尾空白后的长度判断）。 */
  public filter_chunks(chunks: readonly DocumentChunk[], min_length = 50): DocumentChunk[] {
    return chunks.filter((chunk) => codePointLength(chunk.content.trim()) >= min_length);
  }

  public filterChunks(chunks: readonly DocumentChunk[], minLength = 50): DocumentChunk[] {
    return this.filter_chunks(chunks, minLength);
  }

  /** 给每个块合并额外元数据；后者覆盖同名键。 */
  public add_chunk_metadata(
    chunks: readonly DocumentChunk[],
    metadata: DocumentMetadata
  ): DocumentChunk[] {
    for (const chunk of chunks) Object.assign(chunk.metadata, metadata);
    return [...chunks];
  }

  public addChunkMetadata(
    chunks: readonly DocumentChunk[],
    metadata: DocumentMetadata
  ): DocumentChunk[] {
    return this.add_chunk_metadata(chunks, metadata);
  }

  /** 上游 Python 的 `_split_text` 行为：优先在尾部 100 字符寻找分隔符。 */
  public _split_text(text: string): string[] {
    const codePoints = Array.from(text);
    if (codePoints.length <= this.chunk_size) return [text];

    const chunks: string[] = [];
    let start = 0;
    while (start < codePoints.length) {
      const end = start + this.chunk_size;
      if (end >= codePoints.length) {
        chunks.push(codePoints.slice(start).join(''));
        break;
      }

      const splitPoint = this._find_split_point(codePoints.join(''), start, end);
      const actualSplitPoint = splitPoint === -1 ? end : splitPoint;
      chunks.push(codePoints.slice(start, actualSplitPoint).join(''));
      start = Math.max(start + 1, actualSplitPoint - this.chunk_overlap);
    }
    return chunks;
  }

  public splitText(text: string): string[] {
    return this._split_text(text);
  }

  /** 在 [end - 100, end) 的范围内从后往前查找第一个分隔符。 */
  public _find_split_point(text: string, start: number, end: number): number {
    const codePoints = Array.from(text);
    const searchStart = Math.max(start, end - 100);
    for (const separator of this.separators) {
      const separatorCodePoints = Array.from(separator);
      if (separatorCodePoints.length === 0) continue;
      for (let index = end - separatorCodePoints.length; index >= searchStart; index -= 1) {
        if (codePoints.slice(index, index + separatorCodePoints.length).join('') === separator) {
          return index + separatorCodePoints.length;
        }
      }
    }
    return -1;
  }

  public findSplitPoint(text: string, start: number, end: number): number {
    return this._find_split_point(text, start, end);
  }
}

/** 从文本文件创建文档。 */
export function load_text_file(file_path: string, encoding: BufferEncoding = 'utf8'): Document {
  const content = readFileSync(file_path, { encoding });
  return new Document(content, {
    source: file_path,
    type: 'text_file',
    loaded_at: new Date().toISOString()
  });
}

export function loadTextFile(filePath: string, encoding: BufferEncoding = 'utf8'): Document {
  return load_text_file(filePath, encoding);
}

/** 创建文档的便捷函数，对应 Python 的 `create_document(content, **metadata)`。 */
export function create_document(content: string, metadata: DocumentMetadata = {}): Document {
  return new Document(content, metadata);
}

export function createDocument(content: string, metadata: DocumentMetadata = {}): Document {
  return create_document(content, metadata);
}
