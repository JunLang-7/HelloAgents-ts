"""Fixture case: message construction traces and prompt templates."""
from __future__ import annotations

from typing import Any, Dict


def generate() -> Dict[str, Any]:
    from hello_agents.core.message import Message

    results: Dict[str, Any] = {}

    # Basic message roles
    for role in ["system", "user", "assistant", "tool"]:
        msg = Message(role=role, content=f"test content for {role}")
        results[f"message_{role}"] = msg.model_dump()

    # Message with metadata
    msg_meta = Message(role="user", content="with metadata", metadata={"source": "test", "tokens": 5})
    results["message_with_metadata"] = msg_meta.model_dump()

    # Message serialization round-trip
    data = msg_meta.model_dump()
    results["message_roundtrip"] = {"input": data, "output": data}

    return results
