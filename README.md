# HelloAgents TypeScript — Learn Version

[English](README.md) | [简体中文](README_CN.md)

> 📚 **`learn-version` (0.2.0)** — a teaching-oriented TypeScript port of the
> Python [`learn_version`](https://github.com/jjyaoao/HelloAgents/tree/learn_version)
> branch, aligned with the
> [Datawhale Hello-Agents tutorial](https://github.com/datawhalechina/hello-agents).
> This line is maintained separately from the production-oriented `1.x` line and
> is published on npm under the **`learn`** tag.

[![Bun 1.4+](https://img.shields.io/badge/bun-1.4%2B-f9f1e1.svg)](https://bun.sh/)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org/)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)

HelloAgents TypeScript (Learn Version) is a faithful, teaching-first
TypeScript reimplementation of the Python tutorial branch. Each module keeps a
traceable upstream file (`docs/learn-v0.2.0-compatibility-matrix.md`) and
records deliberate deviations in `docs/upstream-differences.md` (DIFF registry).
It is **Bun-first** and Node.js 22+ compatible.

- 🐍 **Python original (tutorial)**: [HelloAgents](https://github.com/jjyaoao/HelloAgents) `learn_version`
- 🐹 **Go reference**: [HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go)

## Quick Start

### Installation

```bash
bun add @junlang-7/helloagents@learn
```

Or with npm:

```bash
npm install @junlang-7/helloagents@learn
```

> The `@learn` dist-tag always points at the latest teaching-version build
> (`0.2.x`). The plain `latest` tag belongs to the separate `1.x` production
> line.

### Minimal Agent (mock by default)

Examples run in **mock / dry-run mode by default** — no API key required. Real
API calls are opt-in: set `OPENAI_API_KEY` (or `LLM_API_KEY`) and
`HELLOAGENTS_REAL_API=1`, or simply construct `HelloAgentsLLM` with explicit
options.

```ts
import { HelloAgentsLLM, SimpleAgent } from '@junlang-7/helloagents';

const llm = new HelloAgentsLLM(); // reads LLM_* env vars; mock adapter by default
const agent = new SimpleAgent({ name: 'assistant', llm });

console.log(await agent.run('你好，请介绍一下自己'));
```

### Environment Variables

Create a `.env` file (template: [`.env.example`](.env.example)) or export in
your shell. The framework auto-selects the provider adapter from `LLM_BASE_URL`
(OpenAI-compatible / Anthropic / Gemini).

```bash
LLM_MODEL_ID=your-model-name
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_TIMEOUT=60
```

### Optional Dependencies (load-on-use)

Nothing beyond Bun/Node.js is required to import the package. Heavier backends
are **probed at use and never fail the import**:

| Capability             | Dependency                           | Notes                                                                      |
| ---------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| Semantic memory / RAG  | Qdrant + Neo4j servers               | used only when `QDRANT_URL` / `NEO4J_URI` are configured                   |
| BFCL evaluation        | `bfcl` CLI                           | gated on `bfcl --version >= 0.4.0`                                         |
| RL training (SFT/GRPO) | Python: `trl`/`torch`/`transformers` | bridged via a Python interpreter; missing backend returns install guidance |
| HF model download      | `HF_TOKEN` (optional)                | needed only for real training runs                                         |

## Teaching Examples (Chapter 07–11 + Function Calling)

Every upstream example has a traceable TypeScript counterpart:

| Upstream (Python, baseline `3927c6d`)        | TypeScript example                                                                                                                                           | Runs by default                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `examples/agent/function_call_agent_demo.py` | [`examples/function-call-agent-demo.ts`](examples/function-call-agent-demo.ts)                                                                               | mock LLM, real API opt-in                               |
| `examples/chapter07_basic_setup.py`          | [`examples/chapter07-basic-setup.ts`](examples/chapter07-basic-setup.ts)                                                                                     | mock LLM, real API opt-in                               |
| `examples/chapter08_memory_rag.py`           | [`examples/chapter08-memory.ts`](examples/chapter08-memory.ts)                                                                                               | in-memory; Qdrant/Neo4j segments opt-in                 |
| `examples/chapter09_context_engineering.py`  | [`examples/chapter09_context_engineering.ts`](examples/chapter09_context_engineering.ts)                                                                     | SQLite memory; RAG segment opt-in                       |
| `examples/chapter10_protocols.py`            | [`examples/chapter10-mcp.ts`](examples/chapter10-mcp.ts) + [`chapter10-a2a.ts`](examples/chapter10-a2a.ts) + [`chapter10-anp.ts`](examples/chapter10-anp.ts) | local transport, no external servers                    |
| `examples/chapter11_RL.py`                   | [`examples/chapter11-rl.ts`](examples/chapter11-rl.ts)                                                                                                       | datasets/rewards pure; training requires Python backend |

Run any example with:

```bash
bun run examples/chapter07-basic-setup.ts
```

## Module Structure

```text
hello_agents/
├── agents/        # SimpleAgent, ReActAgent, ReflectionAgent, PlanAndSolveAgent,
│                  #   FunctionCallAgent, ToolAwareSimpleAgent
├── context/       # ContextBuilder, HistoryManager, TokenCounter, truncators
├── core/          # HelloAgentsLLM, Agent base, Config, SessionStore, streaming
├── evaluation/    # BFCL / GAIA / data-generation benchmarks
├── memory/        # Working/Episodic/Semantic/Perceptual memory, RAG, embedding
├── protocols/     # MCP, A2A, ANP (import-safe; adapters load-on-use)
├── rl/            # GSM8K datasets, math rewards, training backends (SFT/GRPO)
├── tools/         # Tool/ToolResponse, ToolRegistry, ToolChain, builtins
├── utils/         # logging, serialization, helpers
└── index.ts       # root teaching barrel
```

## Version Strategy

- **`learn-version` / npm `learn` tag (0.2.0)**: teaching line. PRs land on
  `learn-version`; `main` is not a merge target for this line.
- **`main` / npm `latest` (1.x)**: separate production-oriented line.
- Compatibility is enforced by `tests/learn-fixture-gate.test.ts` and
  `scripts/release-gate.ts`: every "Implemented" matrix row must be backed by
  real test evidence, and every kept deviation must be registered in the DIFF
  registry.

## Documentation

- [Learn version scope](docs/learn-version-scope.md)
- [Compatibility matrix](docs/learn-v0.2.0-compatibility-matrix.md)
- [Upstream differences (DIFF registry)](docs/upstream-differences.md)
- [Configuration](docs/configuration.md)
- [Migration from Python](docs/migration-from-python.md)
- [Context engineering guide](docs/context-engineering-guide.md)
- [Custom tools](docs/custom-tools.md)
- [Function calling architecture](docs/function-calling-architecture.md)

## Contributing & License

See [CONTRIBUTING](docs/ci-integration.md) notes; the repository is licensed
under CC BY-NC-SA 4.0 (see [LICENSE](LICENSE)).
