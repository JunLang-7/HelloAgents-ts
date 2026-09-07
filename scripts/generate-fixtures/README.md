# Fixture Generator

Generate Python→TypeScript comparison fixtures from the pinned upstream commit
[`3927c6d1decb37737c4c1344fde00ccef55ab1f3`](https://github.com/jjyaoao/HelloAgents/tree/3927c6d1decb37737c4c1344fde00ccef55ab1f3).

## Purpose

Issue #82 requires a reproducible mechanism for comparing the TS port against
upstream Python behavior. This generator runs the upstream code with fixed
inputs, normalizes non-deterministic values, and writes JSON fixtures that the
TS test suite (`tests/learn-fixture-gate.test.ts`) consumes.

## Quick start

```bash
cd scripts/generate-fixtures

# 1. Create venv and install deps (one-time)
uv venv .venv --python 3.12
VIRTUAL_ENV=.venv uv pip install -r requirements.txt

# 2. Clone upstream at pinned SHA (one-time, already in .upstream-ref)
#    (The repo ships with .upstream-ref as a shallow clone; to refresh:)
rm -rf .upstream-ref
git init .upstream-ref
cd .upstream-ref
git remote add origin https://github.com/jjyaoao/HelloAgents.git
git fetch --depth 1 origin 3927c6d1decb37737c4c1344fde00ccef55ab1f3
git checkout FETCH_HEAD
cd ..

# 3. Generate fixtures
.venv/bin/python generate.py
```

Output goes to `../../tests/fixtures/generated/` (committed to the repo).

## How it works

1. **`bootstrap.py`** — Pre-populates `sys.modules` for `hello_agents`,
   `hello_agents.tools`, and `hello_agents.tools.builtin` to bypass their
   heavy `__init__.py` chains (which pull in `huggingface_hub`, `datasets`,
   evaluation modules, etc.). Sub-packages like `hello_agents.memory` run
   their real `__init__.py`.

2. **`mocks.py`** — Replaces `QdrantVectorStore`, `QdrantConnectionManager`,
   and `Neo4jGraphStore` with in-memory mocks so generation runs offline with
   no external services. Mock vector search returns empty results, forcing
   upstream's keyword fallback path (deterministic).

3. **Embedder** — A pre-fitted `TFIDFEmbedding` (scikit-learn) is injected as
   the global singleton. Upstream's `_build_embedder` has a bug where it
   passes `model_name` to `TFIDFEmbedding` (which doesn't accept it), so we
   construct and fit one directly.

4. **`normalizers.py`** — Applies normalization rules (TIME, UUID, FLOAT,
   RAND seed 42) so Python and TS outputs are comparable.

5. **`cases/*.py`** — Each case module defines a `generate()` function that
   exercises specific upstream modules and returns raw results.

6. **`generate.py`** — Runs all cases, normalizes output, writes JSON +
   `manifest.json` with source provenance.

## Fixture cases

| Case            | Upstream sources                                                                                                                          | Covers                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `defaults`      | `core/config.py`, `memory/base.py`, `tools/builtin/memory_tool.py`, `tools/builtin/calculator.py`                                         | Config, MemoryConfig, tool parameter defaults                                                      |
| `tool_returns`  | `tools/builtin/memory_tool.py`, `tools/builtin/calculator.py`, `memory/manager.py`, `memory/types/working.py`, `memory/types/episodic.py` | Calculator results, MemoryTool add/search/stats/summary/update/remove/forget/consolidate/clear_all |
| `exceptions`    | `tools/builtin/memory_tool.py`, `tools/builtin/calculator.py`                                                                             | Missing action, unknown action, nonexistent ID, invalid expression, unsafe expression              |
| `serialization` | `utils/serialization.py`, `core/message.py`, `core/config.py`                                                                             | JSON round-trips, Config to_dict, Message construction                                             |
| `messages`      | `core/message.py`                                                                                                                         | Message roles, metadata, round-trip                                                                |

## Adding a new fixture case

1. Create `cases/<name>.py` with a `generate() -> dict` function.
2. Add `<name>` to the `CASES` list in `generate.py`.
3. Add source paths to `SOURCE_MANIFEST` in `generate.py`.
4. Re-run `.venv/bin/python generate.py`.
5. Add corresponding assertions in `tests/learn-fixture-gate.test.ts`.

## Dependencies

See `requirements.txt`. All packages are pure Python with pre-built wheels;
no compilation required. The generator runs offline after the initial
`uv pip install`.

## Reproducibility

- Upstream SHA is pinned in `generate.py` (`UPSTREAM_SHA`) and in
  `.upstream-ref` (shallow clone at that commit).
- RNG seed is fixed at 42 (`normalizers.SEED`).
- TF-IDF embedder is fitted with a fixed corpus in `generate.py`.
- Storage uses temporary directories (cleaned up after each case).
- Output JSON is sorted by key (`sort_keys=True`) for deterministic diffs.

## CI integration

The generated fixtures are committed to the repo. CI does **not** run the
Python generator — it only runs the TS fixture gate test
(`tests/learn-fixture-gate.test.ts`) and the release gate
(`scripts/release-gate.ts`). To regenerate fixtures (e.g., when the upstream
pinned SHA changes), run locally and commit the updated JSON.
