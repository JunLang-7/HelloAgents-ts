/**
 * TS equivalent of scripts/generate-fixtures/normalizers.py.
 * Every rule here MUST match the Python side exactly — if you change one,
 * change both and re-run the generator.
 *
 * Rules:
 * - TIME:   ISO-8601 datetimes and session_YYYYMMDD_HHMMSS → "TIME"
 * - UUID:   UUID v4 → "UUID_<n>" (1-based, per-call fresh map)
 * - FLOAT:  round to 4 decimal places
 * - RAND:   seed 42 (caller must seed any RNG before producing values)
 * - ORDER:  non-deterministic lists sorted by stable key (caller responsibility)
 * - STREAM: chunks collected and concatenated (caller responsibility)
 */

const ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const SESSION_RE = /session_\d{8}_\d{6}/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const UUID_SHORT_RE = /\bID:\s*([0-9a-f]{8})\.\.\./gi;

export const FIXTURE_SEED = 42;

export function normalizeValue(value: unknown, uuidMap: Map<string, string> = new Map()): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : Math.round(value * 10000) / 10000;
  }
  if (typeof value === 'string') {
    return normalizeString(value, uuidMap);
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeValue(v, uuidMap));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeValue(v, uuidMap);
    }
    return out;
  }
  return String(value);
}

function normalizeString(text: string, uuidMap: Map<string, string>): string {
  const uuidSub = (match: string): string => {
    const raw = match.toLowerCase();
    if (!uuidMap.has(raw)) {
      uuidMap.set(raw, `UUID_${uuidMap.size + 1}`);
    }
    return uuidMap.get(raw)!;
  };
  text = text.replace(UUID_RE, uuidSub);
  text = text.replace(UUID_SHORT_RE, () => `ID: UUID_${uuidMap.size + 1}...`);
  text = text.replace(ISO_RE, 'TIME');
  text = text.replace(SESSION_RE, 'TIME');
  return text;
}

/** Normalize a complete fixture case (fresh UUID map per call). */
export function normalizeCase(data: unknown): unknown {
  return normalizeValue(data, new Map());
}
