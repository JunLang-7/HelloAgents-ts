import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDocument,
  Document,
  DocumentChunk,
  DocumentProcessor,
  loadTextFile
} from '../hello_agents/memory/rag/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

describe('RAG document primitives', () => {
  test('Document derives a stable content id and preserves metadata', () => {
    const document = new Document('hello agents', { source: 'unit-test', nested: { ok: true } });
    expect(document.doc_id).toBe(md5('hello agents'));
    expect(document.docId).toBe(document.doc_id);
    expect(document.metadata).toEqual({ source: 'unit-test', nested: { ok: true } });

    const explicit = new Document('hello agents', {}, 'custom-document');
    expect(explicit.doc_id).toBe('custom-document');
  });

  test('DocumentChunk derives ids from document, index, and content prefix', () => {
    const chunk = new DocumentChunk('abcdef', { source: 'unit-test' }, undefined, 'doc-1', 2);
    expect(chunk.chunk_id).toBe(md5('doc-1_2_abcdef'));
    expect(chunk.docId).toBe('doc-1');
    expect(chunk.chunkIndex).toBe(2);

    const explicit = new DocumentChunk('abcdef', {}, 'chunk-1', 'doc-1');
    expect(explicit.chunk_id).toBe('chunk-1');
  });

  test('processor adds chunk metadata, uses boundaries, and preserves overlap', () => {
    const processor = new DocumentProcessor(12, 3);
    const document = new Document('first paragraph\n\nsecond paragraph\n\nthird paragraph', {
      source: 'fixture.md'
    });
    const chunks = processor.processDocument(document);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.doc_id === document.doc_id)).toBe(true);
    expect(chunks.every((chunk, index) => chunk.metadata.chunk_index === index)).toBe(true);
    expect(chunks.every((chunk) => chunk.metadata.total_chunks === chunks.length)).toBe(true);
    expect(chunks[0]?.metadata.source).toBe('fixture.md');
    expect(typeof chunks[0]?.metadata.processed_at).toBe('string');
    expect(
      chunks.some(
        (chunk, index) =>
          index > 0 && chunks[index - 1]!.content.slice(-3) === chunk.content.slice(0, 3)
      )
    ).toBe(true);
  });

  test('processor handles short and empty documents exactly as upstream', () => {
    const processor = new DocumentProcessor(10, 2);
    expect(processor.splitText('short')).toEqual(['short']);
    expect(processor.splitText('')).toEqual(['']);
    expect(processor.processDocuments([new Document('')])).toHaveLength(1);
    // Python `separators or defaults` treats [] as the default list.
    const emptySeparators = new DocumentProcessor(3, 0, []);
    expect(emptySeparators.separators).toEqual(['\n\n', '\n', '。', '.', ' ']);
    expect(emptySeparators.splitText('a\nb\nc\nd')).toEqual(['a\n', 'b\n', 'c\nd']);
    // The upstream constructor does not validate these values eagerly.
    expect(() => new DocumentProcessor(0)).not.toThrow();
    expect(() => new DocumentProcessor(10, -1)).not.toThrow();
  });

  test('splitting and chunk ids do not split non-BMP code points', () => {
    const content = '😀'.repeat(7);
    const processor = new DocumentProcessor(3, 0, []);
    expect(processor.splitText(content)).toEqual(['😀😀😀', '😀😀😀', '😀']);

    const chunk = new DocumentChunk(content, {}, undefined, 'doc-emoji', 0);
    expect(chunk.chunk_id).toBe(md5(`doc-emoji_0_${'😀'.repeat(7)}`));
    expect(chunk.content).toBe(content);
  });

  test('merge, filter, and metadata helpers follow the Python mutation semantics', () => {
    const first = new DocumentChunk('a', { total_chunks: 1 }, 'c1', 'doc-1', 0);
    const second = new DocumentChunk('b', { total_chunks: 1 }, 'c2', 'doc-1', 1);
    const other = new DocumentChunk('long enough', {}, 'c3', 'doc-2', 0);
    const processor = new DocumentProcessor();

    const merged = processor.mergeChunks([first, second], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(first);
    expect(first.content).toBe('a\nb');
    expect(first.metadata.total_chunks).toBe(2);

    expect(processor.filterChunks([new DocumentChunk('  x  '), other], 2)).toEqual([other]);
    const withExtra = processor.addChunkMetadata([first, other], { namespace: 'demo' });
    expect(withExtra).toEqual([first, other]);
    expect(first.metadata.namespace).toBe('demo');
    expect(other.metadata.namespace).toBe('demo');
  });

  test('loadTextFile and createDocument provide source metadata and deterministic ids', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hello-agents-rag-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'note.txt');
    writeFileSync(filePath, 'loaded text', 'utf8');

    const loaded = loadTextFile(filePath);
    expect(loaded.content).toBe('loaded text');
    expect(loaded.metadata.source).toBe(filePath);
    expect(loaded.metadata.type).toBe('text_file');
    expect(typeof loaded.metadata.loaded_at).toBe('string');
    expect(loaded.doc_id).toBe(md5('loaded text'));

    const created = createDocument('inline text', { namespace: 'demo' });
    expect(created.content).toBe('inline text');
    expect(created.metadata).toEqual({ namespace: 'demo' });
  });
});
