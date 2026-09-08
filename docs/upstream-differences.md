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
- **TS:** JSON helpers are implemented; `pickle` is rejected as unsupported.
- **Status:** kept (approved)
- **Reason:** Python pickle is runtime-specific and unsafe to evaluate in a TypeScript package; JSON preserves the portable behavior.

### DIFF-016 — Missing-required-parameter validation

- **Area:** `tools/validation`
- **Upstream:** `MemoryTool.run` manually checks for a missing `action` and returns `❌ 参数验证失败：缺少必需的参数`.
- **TS:** The zod `inputSchema` rejects at the `Tool.execute` boundary with `工具 'memory' 参数无效: action`.
- **Status:** kept (approved)
- **Reason:** TS uses zod as a single validation layer instead of per-tool manual checks. Both return an error result (`status: "error"`); only the wording differs. The fixture test asserts the error status, not the exact text.

### DIFF-017 — Perceptual memory update re-embedding

- **Area:** `memory/types/perceptual`
- **Upstream:** `PerceptualMemory.update()` re-embeds via `self.vector_store.add_vectors`, but `base.py` has no `vector_store` attribute (only the `vector_stores` dict) — the `AttributeError` is swallowed by the bare `except`, so re-embedding never actually happens.
- **TS:** `update()` re-embeds correctly through `getVectorStoreForModality()` (upstream bug fixed per obvious intent). `perceptions`/`modalityIndex` are intentionally **not** updated on a modality change, matching upstream exactly — `getByModality()` keeps serving from the same stale index on both sides.
- **Status:** kept (approved)
- **Reason:** Fixing the dead re-embed is a deliberate upstream-bug fix; keeping index behavior identical to upstream preserves teaching fidelity for `getByModality()`. `remove()`/`clear()` now delete vectors from both per-modality stores and the fallback `vectorStore`, so the revived re-embed cannot leak.

### DIFF-018 — DashScope SDK → REST-only (embeddings)

- **Area:** `memory/embedding`
- **Upstream:** `DashScopeEmbedding` uses the official `dashscope` SDK; `base_url` is optional and the SDK falls back to the hosted endpoint.
- **TS:** No official TS SDK is used. Without `base_url`, construction throws an explicit error ("DashScope 必须提供 base_url（EMBED_BASE_URL）") instead of silently degrading; with a `base_url`, it calls the OpenAI-compatible `POST {base_url}/embeddings`.
- **Status:** kept (approved)
- **Reason:** The OpenAI-compatible endpoint is the documented public contract for DashScope text-embedding; requiring an explicit URL keeps the failure visible rather than silently defaulting to a hard-coded host.

### DIFF-019 — sentence-transformers → transformers.js (local embeddings)

- **Area:** `memory/embedding`
- **Upstream:** `LocalTransformerEmbedding` uses `sentence-transformers` (Python).
- **TS:** Uses `@huggingface/transformers` (feature-extraction + mean pooling + normalize), loaded on demand via dynamic import; when the package is not installed it throws with install instructions instead of failing obscurely.
- **Status:** kept (approved)
- **Reason:** `@huggingface/transformers` is the maintained browser/Node equivalent of `sentence-transformers` with the same ONNX runtime and model hub.

### DIFF-020 — Async embedding encoders

- **Area:** `memory/embedding`
- **Upstream:** All embedders are synchronous (`encode()` returns a list).
- **TS:** `encode()` returns `number[] | number[][] | Promise<...>` — DashScope and local-transformer backends are async (network/model runtime). `toTextEmbedder()` accepts only synchronously encodable models (TF-IDF) and throws for async ones; `createEmbeddingModelWithFallback` is `async`.
- **Status:** kept (approved)
- **Reason:** Node model/network backends are inherently async; the sync `TextEmbedder` port (used by memory types) is satisfied by TF-IDF, while async models are used through the async-aware APIs.

### DIFF-021 — Qdrant client lifecycle

- **Area:** `memory/storage/qdrant`
- **Upstream:** `QdrantVectorStore` creates the client eagerly in `__init__` and exposes no `close()`; the Qdrant SDK manages its own HTTP session.
- **TS:** `@qdrant/js-client-rest` has no `close()`; connection is established lazily in `ensureInitialized()`. `QdrantConnectionManager` keeps a per-config singleton and `resetForTesting()` clears it.
- **Status:** kept (approved)
- **Reason:** js-client-rest has no session to close; lazily connecting defers failures until first use (consistent with the async adapter design, DIFF-024).

### DIFF-022 — Qdrant collection info stats

- **Area:** `memory/storage/qdrant`
- **Upstream:** `get_collection_info()` reads `vectors_count` from the collection info response.
- **TS:** The JS `CollectionInfo` type exposes no top-level `vectors_count`; `points_count` is used to populate the count in `getCollectionInfo()`/`getCollectionStats()`.
- **Status:** kept (approved)
- **Reason:** The JS client's collection info schema differs; `points_count` is the closest equivalent field.

### DIFF-023 — Neo4j client driver

- **Area:** `memory/storage/neo4j`
- **Upstream:** `Neo4jGraphStore` uses `neo4j` (Python driver) with `session(database=...)`.
- **TS:** Uses `neo4j-driver` (JS), loaded on demand via dynamic import; connection-pool config (`max_connection_lifetime` / `max_connection_pool_size` / `connection_acquisition_timeout`) maps 1:1 to the driver config.
- **Status:** kept (approved)
- **Reason:** `neo4j-driver` is the official JS client; dynamic import keeps the heavy dependency out of the base package until the store is actually used.

### DIFF-024 — Async network stores do not implement the sync ports

- **Area:** `memory/storage`
- **Upstream:** `QdrantVectorStore`/`Neo4jGraphStore` are used directly by memory types.
- **TS:** `QdrantVectorStore`/`Neo4jGraphStore` are async classes and do **not** `implements` the synchronous `VectorStorePort`/`GraphStorePort` (#73). SQLite (sync) and TF-IDF (sync) are the injectable backends for the memory types; the async stores satisfy the #84 public-interface acceptance on their own.
- **Status:** kept (approved)
- **Reason:** Network backends return promises; the sync ports are satisfied by the local backends. Wiring async adapters into memory types is out of scope for #84.

### DIFF-025 — Neo4j driver `executeQuery` API

- **Area:** `memory/storage/neo4j`
- **Upstream:** `session.run(...)` returns a result with `.single()` / `.records()`.
- **TS:** `neo4j-driver` 6.x `session.run` returns a thenable `Result` with no `.single`/`.records`; the recommended `driver.executeQuery(query, params, { database })` is used instead. Delete counts use `DETACH DELETE ... RETURN count(n)` rather than the private `counters.nodes_deleted`.
- **Status:** kept (approved)
- **Reason:** `executeQuery` is the stable public API in 6.x; the count-return idiom avoids private counter fields.

### DIFF-026 — Qdrant client timeout unit

- **Area:** `memory/storage/qdrant`
- **Upstream:** Python client `timeout` is in seconds (default 30).
- **TS:** `@qdrant/js-client-rest` interprets `timeout` in **milliseconds**; the TS store multiplies the configured seconds by 1000 before constructing the client.
- **Status:** kept (approved)
- **Reason:** The JS client API unit differs; the public config keeps the upstream second semantics.

### DIFF-027 — Neo4j driver numeric parameters

- **Area:** `memory/storage/neo4j`
- **Upstream:** Python driver converts ints natively; Cypher `LIMIT` accepts them.
- **TS:** Under bun, plain JS numbers in query params serialize as floats (`LIMIT 50.0` errors); integer params are wrapped with `neo4j.int()`. Driver timeouts (`maxConnectionLifetime`, `connectionAcquisitionTimeout`) are seconds upstream but milliseconds in `neo4j-driver`, converted at construction.
- **Status:** kept (approved)
- **Reason:** Runtime serialization differences; explicit `int()` wrapping and unit conversion keep the public config upstream-faithful.

### DIFF-028 — Cypher relationship-type identifier validation

- **Area:** `memory/storage/neo4j`
- **Upstream:** Python interpolates `relationship_type` / `relationship_types` directly into Cypher (`MERGE (from)-[r:{type}]->(to)`), treating it as an internal trusted API.
- **TS:** `Neo4jGraphStore` is a public entry point, so `addRelationship` and `findRelatedEntities` validate every relationship type against a strict identifier whitelist (`^[A-Za-z_][A-Za-z0-9_]*$`) before interpolation, rejecting values that could alter query structure.
- **Status:** kept (approved)
- **Reason:** Hardening only; all valid identifiers behave exactly as upstream.

### DIFF-029 — Cypher pattern-depth validation

- **Area:** `memory/storage/neo4j`
- **Upstream:** Python interpolates `max_depth` directly into the variable-length pattern (`*1..{max_depth}`) with no bounds; trusted internal API.
- **TS:** `Neo4jGraphStore` is a public entry point, so `findRelatedEntities` constrains `max_depth` to a finite safe integer in `1..25` before interpolation. Strings cannot alter the query text; `0`/negative/non-integer values fail fast instead of producing an invalid pattern; unbounded values cannot trigger pathological traversals.
- **Status:** kept (approved)
- **Reason:** Hardening only; all in-range integer values behave exactly as upstream.

## Known upstream dead-parameter semantics (verified, not differences)

These parameters are **declared and passed but never consumed** on both sides;
TS replicates upstream exactly and must not "fix" them into filters:

- `min_importance` — threaded `memory_tool → MemoryManager.retrieve_memories → type.retrieve`, then discarded by every type's `**kwargs`. A repo-wide search finds zero consumption sites in `hello_agents/memory/types/`.
- `time_range` — accepted by `retrieve_memories` but **not** forwarded to instances; only `EpisodicMemory.retrieve` reads it from kwargs when called directly (manager path never passes it).
- `metadata` on MemoryTool add/update — upstream `run()` never reads a user-supplied `metadata` key (`validate_parameters` checks only required params). TS removed the zod declaration so the tool schema does not promise unsupported functionality; `.passthrough()` still accepts and ignores it, exactly like upstream.

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
  - **#84 update:** the vector/hybrid paths are now exercised directly by
    `tests/memory-backends.test.ts` (real SQLite + TF-IDF injected into the
    memory types) and by `tests/storage-integration.test.ts` (real Qdrant
    1.19.1 / Neo4j 5.14 over Docker, opt-in). Fixture-level vector coverage
    remains deferred; see the matrix's "Real-service integration" note.
