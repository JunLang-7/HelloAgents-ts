import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _approx_token_len,
  htmlToMarkdown,
  loadAndChunkTexts,
  load_and_chunk_texts,
  NATIVE_TEXT_EXTENSIONS,
  UNSUPPORTED_DOCUMENT_EXTENSIONS
} from '../hello_agents/memory/rag/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

describe('RAG native loader', () => {
  test('supports text, markdown, JSON, CSV, HTML, and source files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hello-agents-rag-loader-'));
    temporaryDirectories.push(directory);
    const files = [
      ['note.txt', 'plain text body'],
      ['guide.md', '# Guide\n\nMarkdown body'],
      ['data.json', '{"name":"agents"}'],
      ['rows.csv', 'name,value\nhello,1'],
      ['page.html', '<h1>HTML heading</h1><p>HTML body &amp; detail.</p>'],
      ['sample.ts', 'export const answer = 42;']
    ] as const;
    const paths = files.map(([name, content]) => {
      const path = join(directory, name);
      writeFileSync(path, content, 'utf8');
      return path;
    });

    const chunks = loadAndChunkTexts(paths, { chunkSize: 800, chunkOverlap: 0, namespace: 'demo' });
    expect(chunks).toHaveLength(files.length);
    expect(chunks.map((chunk) => chunk.metadata.file_ext)).toEqual([
      '.txt',
      '.md',
      '.json',
      '.csv',
      '.html',
      '.ts'
    ]);
    expect(chunks.map((chunk) => chunk.metadata.namespace)).toEqual(
      Array(files.length).fill('demo')
    );
    expect(chunks.find((chunk) => chunk.metadata.file_ext === '.html')?.content).toContain(
      'HTML body'
    );
    expect(chunks.find((chunk) => chunk.metadata.file_ext === '.html')?.metadata.heading_path).toBe(
      'HTML heading'
    );
    for (const chunk of chunks) {
      expect(chunk.id).toBe(
        md5(
          `${chunk.metadata.doc_id}|${chunk.metadata.start}|${chunk.metadata.end}|${chunk.metadata.content_hash}`
        )
      );
      expect(chunk.metadata.lang).toBe('unknown');
      expect(chunk.metadata.external).toBe(true);
      expect(chunk.metadata.format).toBe('markdown');
    }
  });

  test('skips missing, binary/optional, unknown, and unreadable paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hello-agents-rag-skip-'));
    temporaryDirectories.push(directory);
    const pdf = join(directory, 'manual.pdf');
    const unknown = join(directory, 'payload.bin');
    writeFileSync(pdf, 'not decoded as PDF', 'utf8');
    writeFileSync(unknown, 'unknown format', 'utf8');

    expect(UNSUPPORTED_DOCUMENT_EXTENSIONS.has('.pdf')).toBe(true);
    expect(NATIVE_TEXT_EXTENSIONS.has('.ts')).toBe(true);
    expect(loadAndChunkTexts([join(directory, 'missing.txt'), pdf, unknown])).toEqual([]);
  });

  test('deduplicates normalized content globally and preserves source order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hello-agents-rag-dedup-'));
    temporaryDirectories.push(directory);
    const first = join(directory, 'first.txt');
    const second = join(directory, 'second.md');
    writeFileSync(first, 'same body', 'utf8');
    writeFileSync(second, 'same body', 'utf8');

    const chunks = load_and_chunk_texts([first, second], 800, 0, 'dedup', 'fixture');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.metadata.source_path).toBe(first);
    expect(chunks[0]?.metadata.source).toBe('fixture');
  });

  test('heading paths, token approximation, and code points are deterministic', () => {
    expect(_approx_token_len('中文测试 hello world')).toBe(7);
    expect(htmlToMarkdown('<h2>Section</h2><p>Body</p>')).toBe('## Section\n\nBody');

    const directory = mkdtempSync(join(tmpdir(), 'hello-agents-rag-unicode-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'emoji.txt');
    writeFileSync(path, '😀😀😀😀', 'utf8');
    const chunks = loadAndChunkTexts([path], 2, 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('😀😀😀😀');
    // The source implementation advances its final line cursor by `len(line) + 1`.
    expect(chunks[0]?.metadata.end).toBe(5);
  });
});
