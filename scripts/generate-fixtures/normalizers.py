"""Normalization rules shared by the Python fixture generator and the TS
fixture harness. Every rule here MUST have an exact equivalent in
tests/fixture-harness/normalizer.ts.

Rules:
- TIME:   any ISO-8601 datetime (with or without timezone/microseconds) and
          any ``session_YYYYMMDD_HHMMSS`` id are replaced with ``"TIME"``.
- UUID:   UUID v4 hex strings are replaced with ``"UUID_<n>"`` where n is the
          1-based order of first appearance within a single fixture case.
- FLOAT:  floats are rounded to 4 decimal places; integers stay integers.
- RAND:   Python ``random`` and ``numpy.random`` are seeded to 42 before each
          case; TS side must use the same seed for any random-equivalent code.
- ORDER:  lists whose order is non-deterministic (e.g. set iteration) are
          sorted by a stable key before comparison.
- STREAM: streaming chunks are collected and concatenated before normalization.
"""
from __future__ import annotations

import datetime as _dt
import json
import random
import re
from typing import Any

import numpy as np

SEED = 42

_ISO_RE = re.compile(
    r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"
)
_SESSION_RE = re.compile(r"session_\d{8}_\d{6}")
_UUID_RE = re.compile(
    r"\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b",
    re.IGNORECASE,
)
# Upstream memory_tool.add truncates id to first 8 chars: "ID: ed845424..."
_UUID_SHORT_RE = re.compile(r"\bID:\s*([0-9a-f]{8})\.\.\.", re.IGNORECASE)


def seed_rngs() -> None:
    """Seed all RNGs to the fixed value before a fixture case."""
    random.seed(SEED)
    np.random.seed(SEED)


def normalize_value(value: Any, uuid_map: dict[str, str] | None = None) -> Any:
    """Recursively normalize a JSON-serializable value."""
    if uuid_map is None:
        uuid_map = {}
    # numpy 2.x scalars: np.float64 subclasses float, but np.int64 no longer
    # subclasses int — convert all numpy scalars to native Python first.
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, np.ndarray):
        return [normalize_value(v, uuid_map) for v in value.tolist()]
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            # banker's rounding (round-half-to-even); the TS normalizer mirrors
            # it. Limit: an exact 4-decimal .5 tie may diverge across runtimes
            # due to IEEE-754 representation — fixture cases must avoid ties.
            return round(value, 4)
        return value
    if isinstance(value, str):
        return _normalize_string(value, uuid_map)
    if isinstance(value, (list, tuple)):
        return [normalize_value(v, uuid_map) for v in value]
    if isinstance(value, dict):
        return {k: normalize_value(v, uuid_map) for k, v in value.items()}
    # datetime/date and any other non-primitive: stringify THEN re-run string
    # normalization so TIME/UUID rules still apply (pydantic model_dump()
    # returns datetime objects, not strings, which would otherwise leak raw
    # timestamps into fixtures and break reproducibility).
    if isinstance(value, (_dt.datetime, _dt.date)):
        return _normalize_string(str(value), uuid_map)
    return _normalize_string(str(value), uuid_map)


def _normalize_string(text: str, uuid_map: dict[str, str]) -> str:
    # UUIDs first (they contain hex that could match other patterns).
    def _uuid_sub(match: re.Match[str]) -> str:
        raw = match.group(0).lower()
        if raw not in uuid_map:
            uuid_map[raw] = f"UUID_{len(uuid_map) + 1}"
        return uuid_map[raw]

    text = _UUID_RE.sub(_uuid_sub, text)
    text = _UUID_SHORT_RE.sub(lambda m: f"ID: UUID_{len(uuid_map) + 1}...", text)
    text = _ISO_RE.sub("TIME", text)
    text = _SESSION_RE.sub("TIME", text)
    return text


def normalize_case(case_data: Any) -> Any:
    """Normalize a complete fixture case (fresh UUID map per case).

    Note: RNG seeding is NOT done here — normalization consumes already-produced
    values, so seeding at this point is too late. Callers MUST invoke
    seed_rngs() BEFORE running the case's generate() function.
    """
    return normalize_value(case_data, {})


def to_json(data: Any) -> str:
    """Serialize normalized data to stable JSON."""
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True, default=str)


def now_iso() -> str:
    """Return a normalized timestamp placeholder (for meta.generated_at)."""
    return "TIME"
