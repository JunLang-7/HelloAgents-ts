/** JSON serialization helpers corresponding to hello_agents.utils.serialization. */

import { readFileSync, writeFileSync } from 'node:fs';
import type { PathLike } from 'node:fs';

export type SerializationFormat = 'json';

function assertFormat(format: string): asserts format is SerializationFormat {
  if (format !== 'json') {
    // Pickle is intentionally not exposed: Python pickle is not portable to
    // TypeScript and evaluating arbitrary pickle bytes would be unsafe.
    throw new Error(`不支持的序列化格式: ${format}`);
  }
}

/** Serialize a JSON-compatible value using Python's two-space pretty format. */
export function serializeObject(obj: unknown, format = 'json'): string {
  assertFormat(format);
  const data = JSON.stringify(obj, null, 2);
  if (data === undefined) throw new TypeError('对象无法序列化为 JSON');
  return data;
}

/** Deserialize a JSON string (or UTF-8 bytes) into a JavaScript value. */
export function deserializeObject(data: string | Uint8Array, format = 'json'): unknown {
  assertFormat(format);
  return JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
}

/** Save an object to a UTF-8 JSON file. */
export function saveToFile(obj: unknown, filepath: PathLike, format = 'json'): void {
  assertFormat(format);
  writeFileSync(filepath, serializeObject(obj, format), 'utf8');
}

/** Load and deserialize an object from a UTF-8 JSON file. */
export function loadFromFile(filepath: PathLike, format = 'json'): unknown {
  assertFormat(format);
  return deserializeObject(readFileSync(filepath), format);
}

// Python-compatible spellings.
export const serialize_object = serializeObject;
export const deserialize_object = deserializeObject;
export const save_to_file = saveToFile;
export const load_from_file = loadFromFile;
