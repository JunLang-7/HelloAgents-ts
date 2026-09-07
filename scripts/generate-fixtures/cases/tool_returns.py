"""Fixture case: tool return values for CalculatorTool and MemoryTool actions."""
from __future__ import annotations

import os
import tempfile
from typing import Any, Dict


def generate() -> Dict[str, Any]:
    from hello_agents.tools.builtin.calculator import CalculatorTool
    from hello_agents.tools.builtin.memory_tool import MemoryTool

    results: Dict[str, Any] = {"calculator": {}, "memory_tool": {}}

    # --- Calculator ---
    calc = CalculatorTool()
    for label, params in [
        ("simple_add", {"expression": "2 + 3 * 4"}),
        ("paren", {"expression": "(2 + 3) * 4"}),
        ("float_div", {"expression": "10 / 3"}),
        ("power", {"expression": "2 ** 10"}),
    ]:
        results["calculator"][label] = {"input": params, "output": calc.run(params)}

    # --- MemoryTool (fresh temp storage path) ---
    with tempfile.TemporaryDirectory() as tmpdir:
        from hello_agents.memory.base import MemoryConfig
        cfg = MemoryConfig(storage_path=tmpdir)
        mt = MemoryTool(memory_config=cfg)

        # add
        add_result = mt.run({
            "action": "add",
            "content": "测试记忆内容：用户偏好深色模式",
            "memory_type": "working",
            "importance": 0.8,
        })
        results["memory_tool"]["add"] = {"input": {"action": "add", "content": "测试记忆内容：用户偏好深色模式", "memory_type": "working", "importance": 0.8}, "output": add_result}

        # add episodic
        mt.run({
            "action": "add",
            "content": "昨天参加了技术方案评审会议",
            "memory_type": "episodic",
            "importance": 0.7,
        })

        # search
        search_result = mt.run({"action": "search", "query": "测试", "limit": 5})
        results["memory_tool"]["search"] = {"input": {"action": "search", "query": "测试", "limit": 5}, "output": search_result}

        # summary
        summary_result = mt.run({"action": "summary"})
        results["memory_tool"]["summary"] = {"input": {"action": "summary"}, "output": summary_result}

        # stats
        stats_result = mt.run({"action": "stats"})
        results["memory_tool"]["stats"] = {"input": {"action": "stats"}, "output": stats_result}

        # update (use first working memory id)
        wm = mt.memory_manager.memory_types["working"]
        all_mem = wm.get_all() if hasattr(wm, "get_all") else []
        if all_mem:
            mem_id = all_mem[0].id
            update_result = mt.run({"action": "update", "memory_id": mem_id, "content": "更新后的记忆内容", "importance": 0.9})
            results["memory_tool"]["update"] = {"input": {"action": "update", "memory_id": "UUID_1", "content": "更新后的记忆内容", "importance": 0.9}, "output": update_result}

            remove_result = mt.run({"action": "remove", "memory_id": mem_id})
            results["memory_tool"]["remove"] = {"input": {"action": "remove", "memory_id": "UUID_1"}, "output": remove_result}

        # forget
        forget_result = mt.run({"action": "forget", "strategy": "importance_based", "threshold": 0.1})
        results["memory_tool"]["forget"] = {"input": {"action": "forget", "strategy": "importance_based", "threshold": 0.1}, "output": forget_result}

        # consolidate
        consolidate_result = mt.run({"action": "consolidate", "from_type": "working", "to_type": "episodic", "importance_threshold": 0.7})
        results["memory_tool"]["consolidate"] = {"input": {"action": "consolidate", "from_type": "working", "to_type": "episodic", "importance_threshold": 0.7}, "output": consolidate_result}

        # clear_all
        clear_result = mt.run({"action": "clear_all"})
        results["memory_tool"]["clear_all"] = {"input": {"action": "clear_all"}, "output": clear_result}

    return results
