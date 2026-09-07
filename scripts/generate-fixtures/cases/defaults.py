"""Fixture case: default values for Config, MemoryConfig, tool parameters."""
from __future__ import annotations

import tempfile
from typing import Any, Dict


def generate() -> Dict[str, Any]:
    from hello_agents.core.config import Config
    from hello_agents.memory.base import MemoryConfig
    from hello_agents.tools.builtin.memory_tool import MemoryTool
    from hello_agents.tools.builtin.calculator import CalculatorTool

    config = Config()
    memory_config = MemoryConfig()
    calc = CalculatorTool()

    # Use a throwaway storage dir so instantiating MemoryTool for its parameter
    # list never writes ./memory_data into the working tree.
    with tempfile.TemporaryDirectory() as tmpdir:
        mt = MemoryTool(memory_config=MemoryConfig(storage_path=tmpdir))
        memory_tool_parameters = [
            {"name": p.name, "type": p.type, "required": p.required, "default": p.default}
            for p in mt.get_parameters()
        ]

    return {
        "config": config.model_dump(),
        "memory_config": memory_config.model_dump(),
        "memory_tool_parameters": memory_tool_parameters,
        "memory_tool_actions": sorted(
            ["add", "search", "summary", "stats", "update", "remove", "forget", "consolidate", "clear_all"]
        ),
        "calculator_parameters": [
            {"name": p.name, "type": p.type, "required": p.required, "default": p.default}
            for p in calc.get_parameters()
        ],
    }
