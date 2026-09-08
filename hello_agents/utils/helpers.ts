/** General helper functions corresponding to hello_agents.utils.helpers. */

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export function formatTime(
  timestamp: Date = new Date(),
  formatString = '%Y-%m-%d %H:%M:%S'
): string {
  const replacements: Record<string, string> = {
    Y: timestamp.getFullYear().toString().padStart(4, '0'),
    y: (timestamp.getFullYear() % 100).toString().padStart(2, '0'),
    m: (timestamp.getMonth() + 1).toString().padStart(2, '0'),
    d: timestamp.getDate().toString().padStart(2, '0'),
    H: timestamp.getHours().toString().padStart(2, '0'),
    I: (timestamp.getHours() % 12 || 12).toString().padStart(2, '0'),
    M: timestamp.getMinutes().toString().padStart(2, '0'),
    S: timestamp.getSeconds().toString().padStart(2, '0'),
    f: timestamp.getMilliseconds().toString().padStart(3, '0') + '000',
    p: timestamp.getHours() < 12 ? 'AM' : 'PM',
    '%': '%'
  };
  return formatString.replace(
    /%([YymdHIMSlfp%])/g,
    (match, token: string) => replacements[token] ?? match
  );
}

export function validateConfig(
  config: Record<string, unknown>,
  requiredKeys: readonly string[]
): true {
  const missingKeys = requiredKeys.filter((key) => !(key in config));
  if (missingKeys.length > 0) {
    const pythonList = `[${missingKeys.map((key) => `'${key.replaceAll("'", "\\'")}'`).join(', ')}]`;
    throw new Error(`配置缺少必需的键: ${pythonList}`);
  }
  return true;
}

/** Dynamically import a module, optionally returning one of its named exports. */
export async function safeImport(moduleName: string, className?: string): Promise<unknown> {
  try {
    const module = (await import(moduleName)) as Record<string, unknown>;
    if (className) {
      if (!(className in module)) throw new Error(`导出不存在: ${className}`);
      return module[className];
    }
    return module;
  } catch (error) {
    throw new Error(
      `无法导入 ${moduleName}.${className ?? ''}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error
      }
    );
  }
}

export function ensureDir(path: string | URL): string {
  mkdirSync(path, { recursive: true });
  return typeof path === 'string' ? path : fileURLToPath(path);
}

/** Return the repository/package root containing the hello_agents directory. */
export function getProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

export function mergeDicts<T extends Record<string, unknown>, U extends Record<string, unknown>>(
  dict1: T,
  dict2: U
): T & U {
  const result: Record<string, unknown> = { ...dict1 };
  for (const [key, value] of Object.entries(dict2)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = mergeDicts(current, value);
    } else {
      result[key] = value;
    }
  }
  return result as T & U;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Python-compatible spellings.
export const format_time = formatTime;
export const validate_config = validateConfig;
export const safe_import = safeImport;
export const ensure_dir = ensureDir;
export const get_project_root = getProjectRoot;
export const merge_dicts = mergeDicts;
