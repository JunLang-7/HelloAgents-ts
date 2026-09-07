"""Fixture case: exception and error-feedback paths."""
from __future__ import annotations

import tempfile
from typing import Any, Dict


def generate() -> Dict[str, Any]:
    from hello_agents.tools.builtin.calculator import CalculatorTool
    from hello_agents.tools.builtin.memory_tool import MemoryTool
    from hello_agents.memory.base import MemoryConfig

    results: Dict[str, Any] = {}

    # MemoryTool: missing action → validation failure
    with tempfile.TemporaryDirectory() as tmpdir:
        cfg = MemoryConfig(storage_path=tmpdir)
        mt = MemoryTool(memory_config=cfg)

        results["missing_action"] = {
            "input": {},
            "output": mt.run({}),
        }
        results["unknown_action"] = {
            "input": {"action": "nonexistent_action"},
            "output": mt.run({"action": "nonexistent_action"}),
        }
        results["update_missing_id"] = {
            "input": {"action": "update", "memory_id": "nonexistent-id"},
            "output": mt.run({"action": "update", "memory_id": "nonexistent-id"}),
        }
        results["remove_missing_id"] = {
            "input": {"action": "remove", "memory_id": "nonexistent-id"},
            "output": mt.run({"action": "remove", "memory_id": "nonexistent-id"}),
        }
        results["empty_search"] = {
            "input": {"action": "search", "query": "完全不存在的查询词xyz"},
            "output": mt.run({"action": "search", "query": "完全不存在的查询词xyz"}),
        }

    # Calculator: invalid expression
    calc = CalculatorTool()
    results["calculator_invalid"] = {
        "input": {"expression": "2 + "},
        "output": calc.run({"expression": "2 + "}),
    }
    results["calculator_unsafe"] = {
        "input": {"expression": "__import__('os').system('echo hack')"},
        "output": calc.run({"expression": "__import__('os').system('echo hack')"}),
    }

    return results
