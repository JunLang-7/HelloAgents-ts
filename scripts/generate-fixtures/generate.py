#!/usr/bin/env python3
"""Generate Python→TypeScript comparison fixtures from the pinned upstream
commit (3927c6d1decb37737c4c1344fde00ccef55ab1f3).

Usage:
    cd scripts/generate-fixtures
    .venv/bin/python generate.py [--output ../../tests/fixtures/generated]

The generated JSON files are committed to the repo so that CI runs offline with
no Python and no network. Re-run this script only when the upstream pinned SHA
changes or a new fixture case is added.

Environment:
    - Python 3.12+ venv with requirements.txt installed
    - No API keys, no network, no external services required
    - Qdrant/Neo4j are mocked (see mocks.py)
    - Embedding uses a pre-fitted TF-IDF model (deterministic)
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

# Ensure the generator dir is on sys.path for bootstrap/mocks/normalizers/cases.
_GEN_DIR = Path(__file__).resolve().parent
if str(_GEN_DIR) not in sys.path:
    sys.path.insert(0, str(_GEN_DIR))

import bootstrap  # noqa: E402
import mocks  # noqa: E402
from normalizers import normalize_case, to_json  # noqa: E402

UPSTREAM_SHA = "3927c6d1decb37737c4c1344fde00ccef55ab1f3"

CASES = [
    "defaults",
    "tool_returns",
    "exceptions",
    "serialization",
    "messages",
]

# Source manifest: which upstream files each case exercises.
SOURCE_MANIFEST: Dict[str, list[str]] = {
    "defaults": [
        "hello_agents/core/config.py",
        "hello_agents/memory/base.py",
        "hello_agents/tools/builtin/memory_tool.py",
        "hello_agents/tools/builtin/calculator.py",
    ],
    "tool_returns": [
        "hello_agents/tools/builtin/memory_tool.py",
        "hello_agents/tools/builtin/calculator.py",
        "hello_agents/memory/manager.py",
        "hello_agents/memory/types/working.py",
        "hello_agents/memory/types/episodic.py",
    ],
    "exceptions": [
        "hello_agents/tools/builtin/memory_tool.py",
        "hello_agents/tools/builtin/calculator.py",
    ],
    "serialization": [
        "hello_agents/utils/serialization.py",
        "hello_agents/core/message.py",
        "hello_agents/core/config.py",
    ],
    "messages": [
        "hello_agents/core/message.py",
    ],
}


def _setup_embedder() -> None:
    """Pre-fit a deterministic TF-IDF embedder and inject it as the singleton.

    Upstream's _build_embedder passes model_name to TFIDFEmbedding which doesn't
    accept it (upstream bug), so we construct and fit one directly.
    """
    from hello_agents.memory.embedding import TFIDFEmbedding
    import hello_agents.memory.embedding as emb_mod

    embedder = TFIDFEmbedding()
    embedder.fit([
        "hello world test memory content",
        "agent tool framework system",
        "working episodic semantic perceptual memory type",
        "user preference dark mode settings",
        "yesterday meeting review technical plan",
        "search query retrieve relevant information",
        "update remove forget consolidate clear action",
    ])
    emb_mod._embedder = embedder


def generate_all(output_dir: Path) -> Dict[str, Any]:
    mocks.install_mocks()
    _setup_embedder()

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest: Dict[str, Any] = {
        "upstream_sha": UPSTREAM_SHA,
        "generated_at": "TIME",
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}",
        "normalization": {
            "time": "ISO-8601 datetimes and session_YYYYMMDD_HHMMSS → TIME",
            "uuid": "UUID v4 → UUID_<n> (1-based, per-case)",
            "float": "round to 4 decimal places",
            "random_seed": 42,
            "order": "non-deterministic lists sorted by stable key",
            "stream": "chunks collected and concatenated",
        },
        "cases": {},
    }

    for case_name in CASES:
        print(f"  generating {case_name} ...", file=sys.stderr)
        module = importlib.import_module(f"cases.{case_name}")
        raw = module.generate()
        normalized = normalize_case(raw)

        out_file = output_dir / f"{case_name}.json"
        out_file.write_text(to_json(normalized) + "\n", encoding="utf-8")

        manifest["cases"][case_name] = {
            "file": f"{case_name}.json",
            "sources": SOURCE_MANIFEST.get(case_name, []),
        }

    manifest_file = output_dir / "manifest.json"
    manifest_file.write_text(to_json(manifest) + "\n", encoding="utf-8")
    print(f"  wrote manifest and {len(CASES)} fixture files to {output_dir}", file=sys.stderr)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate upstream-comparison fixtures")
    parser.add_argument(
        "--output",
        type=Path,
        default=_GEN_DIR.parent.parent / "tests" / "fixtures" / "generated",
        help="Output directory for generated JSON fixtures",
    )
    args = parser.parse_args()
    generate_all(args.output.resolve())


if __name__ == "__main__":
    main()
