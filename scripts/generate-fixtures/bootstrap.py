"""Bootstrap: pre-populate package entries whose __init__.py pulls heavy
optional dependencies (huggingface_hub, datasets, etc.) so that the specific
submodules needed for fixture generation can be imported offline.

Packages NOT pre-populated (memory, memory.types, memory.storage, core, utils)
run their real __init__.py — those only need pydantic + numpy + stdlib.
"""
import sys
import types
import os

_UPSTREAM_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".upstream-ref")
_HA = os.path.join(_UPSTREAM_ROOT, "hello_agents")


def _mk_pkg(name: str, path: str) -> types.ModuleType:
    mod = types.ModuleType(name)
    mod.__path__ = [path]
    mod.__file__ = os.path.join(path, "__init__.py")
    sys.modules[name] = mod
    return mod


def bootstrap() -> None:
    if "hello_agents" in sys.modules:
        return
    if _UPSTREAM_ROOT not in sys.path:
        sys.path.insert(0, _UPSTREAM_ROOT)
    # Top-level pulls agents → tools → evaluation → huggingface_hub.
    _mk_pkg("hello_agents", _HA)
    # tools/__init__ pulls search_tool → builtin/__init__ → gaia → evaluation.
    _mk_pkg("hello_agents.tools", os.path.join(_HA, "tools"))
    # builtin/__init__ pulls gaia_evaluation_tool → evaluation.
    _mk_pkg("hello_agents.tools.builtin", os.path.join(_HA, "tools", "builtin"))


bootstrap()
