import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import {
  deserializeObject,
  ensureDir,
  formatTime,
  getLogger,
  getProjectRoot,
  mergeDicts,
  safeImport,
  saveToFile,
  serializeObject,
  setupLogger,
  validateConfig
} from '../hello_agents/utils/index.js';

describe('learn-version utility helpers', () => {
  test('formatTime follows the upstream default and common strftime tokens', () => {
    const timestamp = new Date(2024, 0, 2, 3, 4, 5, 678);
    expect(formatTime(timestamp)).toBe('2024-01-02 03:04:05');
    expect(formatTime(timestamp, '%Y/%m/%d %I:%M:%S %p %f %%')).toBe(
      '2024/01/02 03:04:05 AM 678000 %'
    );
  });

  test('validateConfig reports every missing key', () => {
    expect(validateConfig({ present: true }, ['present'])).toBe(true);
    expect(() => validateConfig({}, ['first', 'second'])).toThrow(
      "配置缺少必需的键: ['first', 'second']"
    );
  });

  test('safeImport returns modules and named exports', async () => {
    const path = await safeImport('node:path');
    expect(typeof (path as { join: unknown }).join).toBe('function');
    expect(await safeImport('node:path', 'basename')).toBe(
      (path as { basename: unknown }).basename
    );
    await expect(safeImport('node:path', 'missing')).rejects.toThrow('无法导入 node:path.missing');
  });

  test('ensureDir creates and returns the supplied path', () => {
    const root = mkdtempSync(join(tmpdir(), 'ha-utils-'));
    try {
      const nested = join(root, 'one', 'two');
      expect(ensureDir(nested)).toBe(nested);
      expect(() => readFileSync(nested)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('getProjectRoot points at the package root', () => {
    expect(getProjectRoot().endsWith('/HelloAgents-ts')).toBe(true);
  });

  test('mergeDicts recursively merges plain objects without mutating inputs', () => {
    const left = { nested: { keep: 1, replace: 'left' }, list: [1], value: 1 };
    const right = { nested: { add: 2, replace: 'right' }, list: [2], value: 2 };
    expect(mergeDicts(left, right)).toEqual({
      nested: { keep: 1, replace: 'right', add: 2 },
      list: [2],
      value: 2
    });
    expect(left).toEqual({ nested: { keep: 1, replace: 'left' }, list: [1], value: 1 });
  });

  test('setupLogger is idempotent and getLogger returns the same instance', () => {
    const logger = setupLogger('utils-test', 'DEBUG', '%(name)s %(levelname)s %(message)s');
    expect(logger).toBe(getLogger('utils-test'));
    expect(logger.level).toBe(10);
    expect(logger.handlers).toHaveLength(1);
    setupLogger('utils-test', 'ERROR', 'ignored');
    expect(logger.level).toBe(40);
    expect(logger.handlers).toHaveLength(1);
    expect(logger.handlers[0]?.formatString).toBe('%(name)s %(levelname)s %(message)s');
  });

  test('saveToFile and load through deserializeObject preserve JSON data', () => {
    const root = mkdtempSync(join(tmpdir(), 'ha-utils-'));
    try {
      const file = join(root, 'value.json');
      const value = { unicode: '中文测试', nested: { number: 42 } };
      saveToFile(value, file);
      expect(readFileSync(file, 'utf8')).toBe(serializeObject(value));
      expect(deserializeObject(readFileSync(file))).toEqual(value);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serialization errors retain the upstream operation-specific wording', () => {
    expect(() => serializeObject({}, 'yaml')).toThrow('不支持的序列化格式: yaml');
    expect(() => deserializeObject('{}', 'yaml')).toThrow('不支持的反序列化格式: yaml');
  });
});
