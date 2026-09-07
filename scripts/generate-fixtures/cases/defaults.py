"""Fixture case: default values for Config, MemoryConfig, tool parameters."""
from __future__ import annotations

from typing import Any, Dict


def generate() -> Dict[str, Any]:
    from hello_agents.core.config import Config
    from hello_agents.memory.base import MemoryConfig
    from hello_agents.tools.builtin.memory_tool import MemoryTool
    from hello_agents.tools.builtin.calculator import CalculatorTool

    config = Config()
    memory_config = MemoryConfig()
    mt = MemoryTool()
    calc = CalculatorTool()

    return {
        "config": config.model_dump(),
        "memory_config": memory_config.model_dump(),
        "memory_tool_parameters": [
            {"name": p.name, "type": p.type, "required": p.required, "default": p.default}
            for p in mt.get_parameters()
        ],
        "memory_tool_actions": sorted(
            ["add", "search", "summary", "stats", "update", "remove", "forget", "consolidate", "clear_all"]
        ),
        "calculator_parameters": [
            {"name": p.name, "type": p.type, "required": p.required, "default": p.default}
            for p in calc.get_parameters()
        ],
    }
