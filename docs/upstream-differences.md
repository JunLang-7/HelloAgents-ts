# Upstream Differences Registry

**Upstream authority:** [`jjyaoao/HelloAgents` `3927c6d1decb37737c4c1344fde00ccef55ab1f3`](https://github.com/jjyaoao/HelloAgents/tree/3927c6d1decb37737c4c1344fde00ccef55ab1f3) (`learn_version`, Python 0.2.9)

This document records every known difference between the upstream Python
implementation and this TypeScript port. Each entry is also registered in
[`tests/fixture-harness/compat-registry.ts`](../tests/fixture-harness/compat-registry.ts)
and enforced by the release gate (`scripts/release-gate.ts`).

## Status definitions

| Status          | Meaning                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **fixed**       | Upstream has a bug; TS port corrects it. Behavior matches intent, not literal upstream code.                             |
| **kept**        | Intentional divergence from upstream. Requires maintainer approval ( `approved: true` in registry) to pass release gate. |
| **unsupported** | Not portable to TS or deliberately excluded. Documented with reason.                                                     |

## Registry

### DIFF-001 — Episodic memory `get_all()` metadata access

- **Area:** `memory/types/episodic`
- **Upstream:** `get_all()` accesses `episode.metadata` which may be `undefined`, causing `AttributeError` swallowed by callers.
- **TS:** `metadata` defaults to `{}` so `get_all()` never throws.
- **Status:** fixed
- **Reason:** Upstream bug; TS follows the documented `Episode` schema.

### DIFF-002 — Episodic memory `find_patterns` cache

- **Area:** `memory/types/episodic`
- **Upstream:** Uses `timedelta.hours` which does not exist (`AttributeError`); pattern cache never activates.
- **TS:** 1-hour cache semantics implemented correctly.
- **Status:** fixed
- **Reason:** Upstream bug; `timedelta` has no `.hours` attribute.

### DIFF-003 — Semantic memory update/remove return value

- **Area:** `memory/types/semantic`
- **Upstream:** Success return value is incorrectly nested (`return {success: {success: true}}`).
- **TS:** Returns boolean directly.
- **Status:** fixed
- **Reason:** Upstream bug; return type annotation says `bool`.

### DIFF-004 — Perceptual memory `update()` wrong store

- **Area:** `memory/types/perceptual`
- **Upstream:** `update()` uses `self.vector_store` instead of the modality-specific store.
- **TS:** Uses `_get_vector_store_for_modality(modality)`.
- **Status:** fixed
- **Reason:** Upstream bug; cross-modal updates would corrupt the text store.

### DIFF-005 — MemoryTool `auto_record_conversation` kwargs

- **Area:** `tools/builtin/memory_tool`
- **Upstream:** Passes `type=`/`conversation_id=` kwargs to `_add_memory` which doesn't accept them; `try/except` swallows into "添加失败".
- **TS:** Writes metadata correctly; records working + conditional episodic.
- **Status:** fixed
- **Reason:** Upstream bug; conversations were never actually recorded.

### DIFF-006 — Perceptual memory hash vector PRNG

- **Area:** `memory/types/perceptual`
- **Upstream:** Uses `random.Random(seed)` (MT19937) for deterministic hashing.
- **TS:** Uses `mulberry32` PRNG with same seed; deterministic but different numeric values.
- **Status:** kept (approved)
- **Reason:** MT19937 not available in TS stdlib; mulberry32 is the standard deterministic substitute. Hash vectors are internal, not user-facing.

### DIFF-007 — Semantic memory NER (spaCy)

- **Area:** `memory/types/semantic`
- **Upstream:** Uses spaCy for NER entity extraction when available.
- **TS:** `extractEntities` always returns `[]` (model-missing fallback path).
- **Status:** unsupported
- **Reason:** spaCy is Python-only; TS port uses upstream's own model-missing degradation path.

### DIFF-008 — A2A protocol placeholders

- **Area:** `protocols/a2a`
- **Upstream:** `A2ATool.create_message` / `parse_message` are placeholder methods that raise `NotImplementedError`.
- **TS:** Same placeholder behavior — throws with descriptive message.
- **Status:** kept (approved)
- **Reason:** Upstream itself marks these as TODO; faithful port preserves the placeholder.

### DIFF-009 — TF-IDF embedder fallback

- **Area:** `memory/embedding`
- **Upstream:** `_build_embedder` passes `model_name` kwarg to `TFIDFEmbedding` which doesn't accept it, so TF-IDF fallback silently fails.
- **TS:** No TS embedding module exists yet (tracked in #84). The Python fixture generator works around the upstream bug by constructing and fitting `TFIDFEmbedding` directly; the TS #84 implementation must not replicate this bug.
- **Status:** unsupported (approved)
- **Reason:** This records an upstream bug as forward guidance for #84; there is no TS behaviour to compare yet.

### DIFF-010 — Qdrant eager connection

- **Area:** `memory/storage`
- **Upstream:** `QdrantVectorStore` constructor connects to `localhost:6333` eagerly; fails hard if no server.
- **TS:** `VectorStorePort` is an interface; default in-memory store never connects.
- **Status:** kept (approved)
- **Reason:** TS port uses port/adapter pattern (#84); eager connection is an upstream design smell.

### DIFF-011 — Config tracing extensions

- **Area:** `core/config`
- **Upstream:** `Config` has 7 fields.
- **TS:** `Config` extends upstream with tracing fields (`trace_enabled`, `trace_sanitize`, `trace_html_include_raw_response`).
- **Status:** kept (approved)
- **Reason:** TS port added observability tracing as a superset; upstream-compatible fields are identical.

### DIFF-012 — CalculatorTool parameter schema

- **Area:** `tools/builtin/calculator`
- **Upstream:** Declares one required parameter `input` (string).
- **TS:** Uses zod schema accepting both `input` and `expression` (both optional); `getParameters()` returns `[]`.
- **Status:** kept (approved)
- **Reason:** TS port uses zod for validation instead of manual parameter declarations; both input names accepted.

### DIFF-013 — Message constructor argument order

- **Area:** `core/message`
- **Upstream:** `Message(role, content)` — role first.
- **TS:** `Message(content, role, options?)` — content first.
- **Status:** kept (approved)
- **Reason:** TS port follows JS convention of data-first; `toJSON()` output is identical after normalization.

### DIFF-014 — Calculator expression evaluator

- **Area:** `tools/builtin/calculator`
- **Upstream:** Uses Python `ast` module; error messages like `invalid syntax (<unknown>, line 1)`.
- **TS:** Uses JS expression evaluator; error messages differ in format.
- **Status:** kept (approved)
- **Reason:** Different language runtimes; success results match exactly, error semantics match (both reject invalid/unsafe input).

### DIFF-015 — Serialization helpers

- **Area:** `utils/serialization`
- **Upstream:** `serialize_object`/`deserialize_object` support `json` and `pickle` formats.
- **TS:** Not yet implemented (tracked in issue #80).
- **Status:** unsupported
- **Reason:** Serialization helpers are part of issue #80 scope; pickle intentionally not portable.

### DIFF-016 — Missing-required-parameter validation

- **Area:** `tools/validation`
- **Upstream:** `MemoryTool.run` manually checks for a missing `action` and returns `❌ 参数验证失败：缺少必需的参数`.
- **TS:** The zod `inputSchema` rejects at the `Tool.execute` boundary with `工具 'memory' 参数无效: action`.
- **Status:** kept (approved)
- **Reason:** TS uses zod as a single validation layer instead of per-tool manual checks. Both return an error result (`status: "error"`); only the wording differs. The fixture test asserts the error status, not the exact text.

## Fixture normalization rules

Generated fixtures (`tests/fixtures/generated/*.json`) apply these
normalizations so that TS and Python outputs can be compared exactly:

| Rule       | Implementation                                                                    |
| ---------- | --------------------------------------------------------------------------------- |
| **TIME**   | ISO-8601 datetimes and `session_YYYYMMDD_HHMMSS` IDs → `"TIME"`                   |
| **UUID**   | UUID v4 → `"UUID_<n>"` (1-based, per-case); `ID: <8hex>...` → `"ID: UUID_<n>..."` |
| **FLOAT**  | Round to 4 decimal places (round-half-to-even / banker's rounding)                |
| **RAND**   | Fixed seed 42 (`random.seed(42)`, `np.random.seed(42)`)                           |
| **ORDER**  | Non-deterministic lists sorted by stable key                                      |
| **STREAM** | Streaming chunks collected and concatenated                                       |

Python side: `scripts/generate-fixtures/normalizers.py`
TS side: `tests/fixture-harness/normalizer.ts`

Both MUST be updated together.

### FLOAT tie caveat

Both sides use banker's rounding (round-half-to-even) to 4 decimals. At an
exact 4-decimal `.5` tie (e.g. `0.12345`), multiplying by 10000 introduces
IEEE-754 error that can point the opposite way from CPython's
decimal-correct rounding, so the two runtimes may diverge on such values.
All current fixtures avoid ties (importance/decay/threshold values have at
most four non-tied digits). Fixture cases MUST NOT construct values whose
4-decimal boundary is an exact `.5` tie.

## Coverage gaps

- **Vector / hybrid retrieval path.** The Python fixture generator replaces
  Qdrant and Neo4j with in-memory mocks whose `search_similar` always returns
  `[]`, forcing every search down the keyword fallback. Therefore the vector
  similarity and hybrid retrieval code paths have **zero fixture coverage**.
  They can only be exercised once the TS embedding/vector layer exists
  (#84); vector-path fixtures are deferred until then and must be added as
  part of that issue.
