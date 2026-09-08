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
    ts: 'JSON serialization helpers are implemented; pickle is unsupported',
    status: 'kept',
    approved: true,
    reason:
      'Python pickle is runtime-specific and unsafe to evaluate in a TypeScript package; JSON preserves the portable behavior'
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
  },
  {
    id: 'DIFF-018',
    area: 'memory/embedding',
    upstream:
      'DashScopeEmbedding uses the official dashscope SDK; base_url optional, SDK falls back to the hosted endpoint',
    ts: 'No official TS SDK; without base_url construction throws an explicit error; with base_url calls OpenAI-compatible POST {base_url}/embeddings',
    status: 'kept',
    approved: true,
    reason:
      'OpenAI-compatible endpoint is the documented public contract for DashScope text-embedding; requiring an explicit URL keeps failure visible.'
  },
  {
    id: 'DIFF-019',
    area: 'memory/embedding',
    upstream: 'LocalTransformerEmbedding uses sentence-transformers (Python)',
    ts: 'Uses @huggingface/transformers (feature-extraction + mean pooling + normalize), loaded on demand; throws install instructions when missing',
    status: 'kept',
    approved: true,
    reason:
      '@huggingface/transformers is the maintained browser/Node equivalent with the same ONNX runtime and model hub.'
  },
  {
    id: 'DIFF-020',
    area: 'memory/embedding',
    upstream: 'All embedders synchronous; encode() returns a list',
    ts: 'encode() returns number[] | number[][] | Promise<...>; toTextEmbedder accepts only synchronously encodable models (TF-IDF), async models throw; createEmbeddingModelWithFallback is async',
    status: 'kept',
    approved: true,
    reason:
      'Node model/network backends are inherently async; the sync TextEmbedder port is satisfied by TF-IDF while async models go through async-aware APIs.'
  },
  {
    id: 'DIFF-021',
    area: 'memory/storage/qdrant',
    upstream: 'QdrantVectorStore creates the client eagerly in __init__; no close()',
    ts: '@qdrant/js-client-rest has no close(); connection is lazy in ensureInitialized(); QdrantConnectionManager keeps a per-config singleton with resetForTesting()',
    status: 'kept',
    approved: true,
    reason:
      'js-client-rest has no session to close; lazy connection defers failures until first use.'
  },
  {
    id: 'DIFF-022',
    area: 'memory/storage/qdrant',
    upstream: 'get_collection_info() reads vectors_count from the response',
    ts: 'JS CollectionInfo exposes no top-level vectors_count; points_count is used to populate the count',
    status: 'kept',
    approved: true,
    reason: 'The JS client collection info schema differs; points_count is the closest equivalent.'
  },
  {
    id: 'DIFF-023',
    area: 'memory/storage/neo4j',
    upstream: 'Neo4jGraphStore uses the Python neo4j driver with session(database=...)',
    ts: 'Uses neo4j-driver (JS), loaded on demand; pool config (max_connection_lifetime / max_connection_pool_size / connection_acquisition_timeout) maps 1:1',
    status: 'kept',
    approved: true,
    reason:
      'neo4j-driver is the official JS client; dynamic import keeps the heavy dependency out of the base package.'
  },
  {
    id: 'DIFF-024',
    area: 'memory/storage',
    upstream: 'QdrantVectorStore/Neo4jGraphStore used directly by memory types',
    ts: 'QdrantVectorStore/Neo4jGraphStore are async classes and do NOT implement the sync VectorStorePort/GraphStorePort; SQLite (sync) and TF-IDF (sync) are the injectable backends',
    status: 'kept',
    approved: true,
    reason:
      'Network backends return promises; sync ports are satisfied by local backends. Wiring async adapters into memory types is out of scope for #84.'
  },
  {
    id: 'DIFF-025',
    area: 'memory/storage/neo4j',
    upstream: 'session.run(...) returns a result with .single() / .records()',
    ts: 'neo4j-driver 6.x session.run returns a thenable Result with no .single/.records; driver.executeQuery(query, params, { database }) used; delete counts via DETACH DELETE ... RETURN count(n)',
    status: 'kept',
    approved: true,
    reason:
      'executeQuery is the stable public API in 6.x; count-return avoids private counter fields.'
  },
  {
    id: 'DIFF-026',
    area: 'memory/storage/qdrant',
    upstream: 'Python client timeout in seconds (default 30)',
    ts: '@qdrant/js-client-rest interprets timeout in milliseconds; the store multiplies configured seconds by 1000',
    status: 'kept',
    approved: true,
    reason: 'JS client API unit differs; the public config keeps upstream second semantics.'
  },
  {
    id: 'DIFF-027',
    area: 'memory/storage/neo4j',
    upstream: 'Python driver converts ints natively; Cypher LIMIT accepts them',
    ts: 'Plain JS numbers serialize as floats under bun (LIMIT 50.0 errors); integer params wrapped with neo4j.int(); driver timeouts converted from seconds to milliseconds',
    status: 'kept',
    approved: true,
    reason:
      'Runtime serialization differences; explicit int() wrapping and unit conversion keep the public config upstream-faithful.'
  },
  {
    id: 'DIFF-028',
    area: 'memory/storage/neo4j',
    upstream:
      'Python interpolates relationship_type / relationship_types directly into Cypher (trusted internal API)',
    ts: 'Neo4jGraphStore is a public entry point: relationship types validated against a strict identifier whitelist before interpolation, rejecting values that could alter query structure',
    status: 'kept',
    approved: true,
    reason:
      'Hardening only; all valid identifiers behave exactly as upstream, invalid ones fail fast with a clear error.'
  },
  {
    id: 'DIFF-029',
    area: 'memory/storage/neo4j',
    upstream:
      'Python interpolates max_depth directly into the variable-length pattern (*1..{max_depth}) with no bounds; trusted internal API',
    ts: 'findRelatedEntities constrains max_depth to a finite safe integer in 1..25 before interpolation, rejecting strings, 0/negative/non-integer values and unbounded depths',
    status: 'kept',
    approved: true,
    reason:
      'Hardening only; all in-range integer values behave exactly as upstream, out-of-range ones fail fast.'
  }
];

export function findDiff(id: string): CompatDiff | undefined {
  return COMPAT_DIFFS.find((d) => d.id === id);
}

export function unapprovedKeptDiffs(): CompatDiff[] {
  return COMPAT_DIFFS.filter((d) => d.status === 'kept' && !d.approved);
}
