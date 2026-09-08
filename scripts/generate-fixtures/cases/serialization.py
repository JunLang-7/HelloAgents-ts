"""Fixture case: serialization round-trips (JSON only; pickle is intentionally
not tested — the TS side must never execute untrusted deserialization)."""
from __future__ import annotations

from typing import Any, Dict


def generate() -> Dict[str, Any]:
    from hello_agents.utils.serialization import serialize_object, deserialize_object
    from hello_agents.core.message import Message
    from hello_agents.core.config import Config

    results: Dict[str, Any] = {}

    # Plain dict round-trip
    plain = {"key": "value", "number": 42, "nested": {"a": [1, 2, 3]}, "unicode": "中文测试"}
    serialized = serialize_object(plain, format="json")
    deserialized = deserialize_object(serialized, format="json")
    results["plain_dict_roundtrip"] = {
        "input": plain,
        "serialized": serialized,
        "deserialized": deserialized,
    }

    # Config to_dict
    cfg = Config()
    results["config_to_dict"] = cfg.model_dump()

    # Message construction
    msg = Message(role="user", content="hello world")
    results["message_construction"] = {
        "input": {"role": "user", "content": "hello world"},
        "output": msg.model_dump(),
    }

    # Unsupported format raises
    try:
        serialize_object({}, format="yaml")
        results["unsupported_format"] = {"input": {"format": "yaml"}, "output": None, "error": None}
    except ValueError as e:
        results["unsupported_format"] = {"input": {"format": "yaml"}, "output": None, "error": str(e)}

    return results
