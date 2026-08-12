import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CalculatorTool,
  EditTool,
  GlobTool,
  GrepTool,
  ReadTool,
  ToolErrorCode,
  ToolRegistry,
  WriteTool
} from '../src/index.js';

describe('CalculatorTool', () => {
  test('matches Python V1 arithmetic/functions and rejects non-whitelisted syntax', async () => {
    const tool = new CalculatorTool();
    expect(await tool.execute({ input: 'sqrt(16) + sin(pi / 2)' })).toMatchObject({
      text: '计算结果: 5',
      data: { result: 5, result_str: '5' }
    });
    expect((await tool.execute({ input: 'round(2.5) + round(3.5)' })).data).toMatchObject({
      result: 6
    });
    expect((await tool.execute({ input: '-2**2 + 2**-2' })).data).toMatchObject({ result: -3.75 });
    expect((await tool.execute({ input: 'process.exit()' })).errorInfo?.code).toBe(
      ToolErrorCode.INVALID_FORMAT
    );
    expect((await tool.execute({ input: '' })).errorInfo?.code).toBe(ToolErrorCode.INVALID_PARAM);
  });
});

describe('workspace file tools', () => {
  test('enforces workspace boundaries, caches reads, and refuses optimistic-lock conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-files-'));
    const outside = join(tmpdir(), `helloagents-outside-${randomUUID()}.txt`);
    try {
      const registry = new ToolRegistry();
      const write = new WriteTool({ workspaceRoot: root, registry });
      const read = new ReadTool({ workspaceRoot: root, registry });
      const edit = new EditTool({ workspaceRoot: root, registry });
      expect((await write.execute({ path: '../escape.txt', content: 'no' })).errorInfo?.code).toBe(
        ToolErrorCode.ACCESS_DENIED
      );
      await writeFile(outside, 'secret', 'utf8');
      await symlink(outside, join(root, 'linked.txt'));
      expect((await read.execute({ path: 'linked.txt' })).errorInfo?.code).toBe(
        ToolErrorCode.ACCESS_DENIED
      );
      await write.execute({ path: 'note.txt', content: 'alpha\nbeta\n' });
      const loaded = await read.execute({ path: 'note.txt' });
      expect(loaded.data).toMatchObject({ content: 'alpha\nbeta\n', total_lines: 2 });
      const cached = registry.getReadMetadata('note.txt');
      expect(cached).toMatchObject({ file_size_bytes: 11, file_hash: expect.any(String) });
      await writeFile(join(root, 'note.txt'), 'changed\n', 'utf8');
      const conflict = await edit.execute({
        path: 'note.txt',
        old_string: 'changed',
        new_string: 'new',
        file_mtime_ms: cached?.file_mtime_ms
      });
      expect(conflict.errorInfo?.code).toBe(ToolErrorCode.CONFLICT);
    } finally {
      await rm(outside, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test('performs exact unique edits, returns errors for zero/multiple matches, and supports glob/grep', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-files-'));
    try {
      const write = new WriteTool({ workspaceRoot: root });
      const edit = new EditTool({ workspaceRoot: root });
      await write.execute({ path: 'src/a.txt', content: 'one\ntwo\n' });
      await write.execute({ path: 'src/b.txt', content: 'two\ntwo\n' });
      await writeFile(join(root, 'src/binary.bin'), Buffer.from([0x61, 0x00, 0x62]));
      expect(
        (await edit.execute({ path: 'src/a.txt', old_string: 'two', new_string: 'three' })).data
      ).toMatchObject({ modified: true });
      expect(await readFile(join(root, 'src/a.txt'), 'utf8')).toBe('one\nthree\n');
      expect(
        (await edit.execute({ path: 'src/a.txt', old_string: 'missing', new_string: 'x' }))
          .errorInfo?.code
      ).toBe(ToolErrorCode.INVALID_PARAM);
      expect(
        (await edit.execute({ path: 'src/b.txt', old_string: 'two', new_string: 'x' })).errorInfo
          ?.code
      ).toBe(ToolErrorCode.INVALID_PARAM);
      expect(
        (await new GlobTool({ workspaceRoot: root }).execute({ pattern: 'src/*.txt' })).data
      ).toMatchObject({ matches: ['src/a.txt', 'src/b.txt'] });
      expect(
        (await new GrepTool({ workspaceRoot: root }).execute({ pattern: 'three', path: 'src' }))
          .data
      ).toMatchObject({ matches: [{ path: 'src/a.txt', line: 2, text: 'three' }] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects binary content and returns a partial response for large reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helloagents-files-'));
    try {
      await writeFile(join(root, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]));
      await writeFile(join(root, 'large.txt'), '0123456789'.repeat(20), 'utf8');
      const reader = new ReadTool({ workspaceRoot: root, maxReadBytes: 32 });
      expect((await reader.execute({ path: 'binary.bin' })).errorInfo?.code).toBe(
        ToolErrorCode.BINARY_FILE
      );
      const partial = await reader.execute({ path: 'large.txt' });
      expect(partial.status).toBe('partial');
      expect(partial.data).toMatchObject({ truncated: true, file_size_bytes: 200 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
