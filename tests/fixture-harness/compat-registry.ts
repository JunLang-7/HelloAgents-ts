/**
 * Registry of known differences between the upstream Python HelloAgents
 * (pinned SHA 3927c6d) and this TypeScript port.
 *
 * Every entry MUST have:
 *   id:       stable identifier
 *   area:     module / feature area
 *   upstream: what upstream does (bug or design)
 *   ts:       what TS does
 *   status:   "kept" (intentional divergence, documented) | "fixed" (upstream bug, TS corrects) | "unsupported" (not portable)
 *   approved: whether a maintainer has approved this divergence (required for "kept" status to pass release gate)
 *   reason:   why this difference exists
 *
 * The release gate (scripts/release-gate.ts) reads this registry and fails if
 * any "kept" entry is unapproved, or if any fixture mismatch is not covered by
 * a registered entry.
 */

export type DiffStatus = 'kept' | 'fixed' | 'unsupported';

export interface CompatDiff {
  id: string;
  area: string;
  upstream: string;
  ts: string;
  status: DiffStatus;
  approved: boolean;
  reason: string;
}

export const COMPAT_DIFFS: CompatDiff[] = [
  {
    id: 'DIFF-001',
    area: 'memory/episodic',
    upstream:
      'get_all() accesses episode.metadata which may be undefined (AttributeError swallowed by caller)',
    ts: 'metadata defaults to {} so get_all() never throws',
    status: 'fixed',
    approved: true,
    reason: 'Upstream bug; TS follows the documented Episode schema'
  },
  {
    id: 'DIFF-002',
    area: 'memory/episodic',
    upstream:
      'find_patterns uses timedelta.hours which does not exist (AttributeError), patterns never cached',
    ts: '1-hour cache semantics implemented correctly',
    status: 'fixed',
    approved: true,
    reason: 'Upstream bug; timedelta has no .hours attribute'
  },
  {
    id: 'DIFF-003',
    area: 'memory/semantic',
    upstream:
      'update/remove success return value is incorrectly nested (return {success: {success: true}})',
    ts: 'returns boolean directly',
    status: 'fixed',
    approved: true,
    reason: 'Upstream bug; return type annotation says bool'
  },
  {
    id: 'DIFF-004',
    area: 'memory/perceptual',
    upstream: 'update() uses self.vector_store instead of the modality-specific store',
    ts: 'uses _get_vector_store_for_modality(modality)',
    status: 'fixed',
    approved: true,
    reason: 'Upstream bug; cross-modal updates would corrupt the text store'
  },
  {
    id: 'DIFF-005',
    area: 'tools/memory_tool',
    upstream:
      "auto_record_conversation passes type=/conversation_id= kwargs to _add_memory which doesn't accept them; try/except swallows into '添加失败'",
    ts: 'writes metadata correctly, records working + conditional episodic',
    status: 'fixed',
    approved: true,
    reason: 'Upstream bug; conversations were never actually recorded'
  },
  {
    id: 'DIFF-006',
    area: 'memory/perceptual',
    upstream: 'hash vectors use random.Random(seed) (MT19937) for deterministic hashing',
    ts: 'uses mulberry32 PRNG with same seed; deterministic but different numeric values',
    status: 'kept',
    approved: true,
    reason:
      'MT19937 not available in TS stdlib; mulberry32 is the standard deterministic substitute. Hash vectors are internal, not user-facing.'
  },
  {
    id: 'DIFF-007',
    area: 'memory/semantic',
    upstream: 'uses spaCy for NER entity extraction when available',
    ts: 'extractEntities always returns [] (model-missing fallback path)',
    status: 'unsupported',
    approved: true,
    reason: "spaCy is Python-only; TS port uses the upstream's own model-missing degradation path"
  },
  {
    id: 'DIFF-008',
    area: 'protocols/a2a',
    upstream:
      'A2ATool.create_message / parse_message are placeholder methods that raise NotImplementedError',
    ts: 'same placeholder behavior — throws with descriptive message',
    status: 'kept',
    approved: true,
    reason: 'Upstream itself marks these as TODO; faithful port preserves the placeholder'
  },
  {
    id: 'DIFF-009',
    area: 'memory/embedding',
    upstream:
      "_build_embedder passes model_name kwarg to TFIDFEmbedding which doesn't accept it, so TF-IDF fallback silently fails",
    ts: 'No TS embedding module yet (tracked in #84). The Python fixture generator works around the upstream bug by constructing/fitting TFIDFEmbedding directly; the TS #84 implementation must NOT replicate this bug.',
    status: 'unsupported',
    approved: true,
    reason:
      'Records an upstream bug as forward guidance for #84; no TS behavior exists to compare yet'
  },
  {
    id: 'DIFF-010',
    area: 'memory/storage',
    upstream:
      'QdrantVectorStore constructor connects to localhost:6333 eagerly; fails hard if no server',
    ts: 'VectorStorePort is an interface; default in-memory store never connects',
    status: 'kept',
    approved: true,
    reason: 'TS port uses port/adapter pattern (#84); eager connection is an upstream design smell'
  },
  {
    id: 'DIFF-011',
    area: 'core/config',
    upstream:
      'Config has 7 fields (default_model, default_provider, temperature, max_tokens, debug, log_level, max_history_length)',
    ts: 'Config extends upstream with tracing fields (trace_enabled, trace_sanitize, trace_html_include_raw_response)',
    status: 'kept',
    approved: true,
    reason:
      'TS port added observability tracing as a superset; upstream-compatible fields are identical'
  },
  {
    id: 'DIFF-012',
    area: 'tools/calculator',
    upstream: "CalculatorTool declares one required parameter 'input' (string)",
    ts: "CalculatorTool uses zod schema accepting both 'input' and 'expression' (both optional); getParameters() returns [] because params are schema-derived",
    status: 'kept',
    approved: true,
    reason:
      'TS port uses zod for validation instead of manual parameter declarations; both input names accepted'
  },
  {
    id: 'DIFF-013',
    area: 'core/message',
    upstream: 'Message(role, content) — role first',
    ts: 'Message(content, role, options?) — content first',
    status: 'kept',
    approved: true,
    reason:
      'TS port follows JS convention of data-first; toJSON() output is identical after normalization'
  },
  {
    id: 'DIFF-014',
    area: 'tools/calculator',
    upstream:
      "Expression evaluation uses Python ast module; error messages like 'invalid syntax (<unknown>, line 1)'",
    ts: 'Expression evaluation uses JS evaluator; error messages differ in format',
    status: 'kept',
    approved: true,
    reason:
      'Different language runtimes; success results match exactly, error semantics match (both reject invalid/unsafe input)'
  },
  {
    id: 'DIFF-015',
    area: 'utils/serialization',
    upstream: 'serialize_object/deserialize_object support json and pickle formats',
    ts: 'Not yet implemented (tracked in issue #80)',
    status: 'unsupported',
    approved: true,
    reason: 'Serialization helpers are part of issue #80 scope; pickle intentionally not portable'
  },
  {
    id: 'DIFF-016',
    area: 'tools/validation',
    upstream:
      "MemoryTool.run manually checks for a missing required 'action' and returns '❌ 参数验证失败：缺少必需的参数'",
    ts: "zod inputSchema rejects at the Tool.execute boundary: '工具 memory 参数无效: action'",
    status: 'kept',
    approved: true,
    reason:
      'TS uses zod as the single validation layer instead of per-tool manual checks; both return an error result, text differs by framework. Fixture test asserts error status, not exact text.'
  },
  {
    id: 'DIFF-017',
    area: 'memory/types/perceptual',
    upstream:
      'PerceptualMemory.update() re-embeds via self.vector_store.add_vectors — but base.py has no vector_store attribute (only the vector_stores dict), so it raises AttributeError that the bare except swallows: re-embedding never happens upstream',
    ts: 'update() re-embeds correctly via getVectorStoreForModality() (upstream bug fixed per obvious intent); perceptions/modalityIndex are NOT updated on modality change, matching upstream — getByModality() keeps serving from the stale index on both sides',
    status: 'kept',
    approved: true,
    reason:
      'Fixing the dead re-embed is a deliberate upstream-bug fix; keeping the index behavior identical to upstream preserves teaching fidelity for getByModality(). Vector cleanup on remove/clear covers both per-modality stores and the fallback vectorStore so the fixed re-embed cannot leak.'
  }
];

export function findDiff(id: string): CompatDiff | undefined {
  return COMPAT_DIFFS.find((d) => d.id === id);
}

export function unapprovedKeptDiffs(): CompatDiff[] {
  return COMPAT_DIFFS.filter((d) => d.status === 'kept' && !d.approved);
}
