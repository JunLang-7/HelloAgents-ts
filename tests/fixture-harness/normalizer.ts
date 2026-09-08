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

/**
 * Round half to even ("banker's rounding") to match Python's round(x, 4).
 * JS Math.round uses round-half-away-from-zero which diverges at exact .5
 * ties; this mirrors CPython semantics, including negative numbers.
 *
 * Known limit: at an exact 4-decimal tie (e.g. 0.12345) multiplying by 10000
 * introduces IEEE-754 error that can point the opposite way from CPython's
 * decimal-correct rounding. All current fixtures avoid such ties (importance,
 * decay, threshold values have <=4 non-tied digits). Fixture cases MUST NOT
 * construct values whose 4-decimal boundary is an exact .5 tie.
 */
function round4(value: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10000;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  let rounded: number;
  if (Math.abs(frac - 0.5) < 1e-9) {
    // Exact tie: pick the even neighbour.
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(scaled);
  }
  return rounded / factor;
}

export function normalizeValue(value: unknown, uuidMap: Map<string, string> = new Map()): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : round4(value);
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
