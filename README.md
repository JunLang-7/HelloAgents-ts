# HelloAgents TypeScript — Learn Version

[English](README.md) | [简体中文](README_CN.md)

> 🚧 **`learn-version` development branch (`0.2.0`)** — a teaching-oriented TypeScript port of the Python [`learn_version`](https://github.com/jjyaoao/HelloAgents/tree/learn_version) branch. This line is maintained separately from the production-oriented `1.x` line and is published with the npm `learn` tag.
>
> The teaching-version port is complete: the module inventory below is ported from the upstream `learn_version` branch (baseline `3927c6d`), with per-module traceability in [`docs/learn-v0.2.0-compatibility-matrix.md`](docs/learn-v0.2.0-compatibility-matrix.md) and approved deviations in [`docs/upstream-differences.md`](docs/upstream-differences.md).

> 🤖 Teaching-friendly Multi-Agent Framework — lightweight abstractions aligned with the Datawhale Hello-Agents tutorial.

[![Bun 1.3+](https://img.shields.io/badge/bun-1.3%2B-f9f1e1.svg)](https://bun.sh/)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org/)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)

HelloAgents TypeScript (Learn Version) is a faithful, teaching-first
TypeScript port of the Python
[HelloAgents `learn_version`](https://github.com/jjyaoao/HelloAgents) branch,
with [HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go) as a
cross-language reference. Bun-first, Node.js 22+-compatible. It ports the
teaching modules: agents (SimpleAgent/ReActAgent/ReflectionAgent/
PlanAndSolveAgent/FunctionCallAgent), tools (ToolRegistry/ToolChain), memory
(four types + RAG), context engineering, evaluation benchmarks, protocols
(MCP/A2A/ANP), and RL training (SFT/GRPO). Per-module traceability lives in the
[compatibility matrix](docs/learn-v0.2.0-compatibility-matrix.md); approved
deviations in the [DIFF registry](docs/upstream-differences.md). 1.x-only
capabilities (SessionStore, TaskTool, Skills, CircuitBreaker, TodoWrite,
DevLog, file tools, SSE helpers, real provider adapters) are out of scope for
Learn 0.2.0 and are **not** exported.

## 📌 Version Notes

- 🐍 **Python Original**: [HelloAgents](https://github.com/jjyaoao/HelloAgents), paired with the [Datawhale Hello-Agents tutorial](https://github.com/datawhalechina/hello-agents).
- 🚀 **TypeScript Implementation**: this repository, with a public ESM package for Bun and Node.js.
- 🐹 **Go Implementation**: [HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go), used as a cross-language structural reference.
- 📦 **Historical Python Releases**: [Releases](https://github.com/jjyaoao/HelloAgents/releases) provides Python releases from v0.1.1 through v0.2.9.

## 🚀 Quick Start

### Installation

```bash
bun add @junlang-7/helloagents@learn
```

The published ESM package also works with Node.js:

```bash
npm install @junlang-7/helloagents@learn
```

### Basic Usage

```ts
import { CalculatorTool, HelloAgentsLLM, ReActAgent, ToolRegistry } from '@junlang-7/helloagents';

const llm = new HelloAgentsLLM();
const registry = new ToolRegistry().register(new CalculatorTool());
const agent = new ReActAgent({
  name: 'assistant',
  llm,
  toolRegistry: registry
});

console.log(await agent.run('What is sqrt(144)?'));
```

### Environment Configuration

Create a `.env` file, or export the variables in your shell. A complete
template is available at [`.env.example`](.env.example).

```bash
LLM_MODEL_ID=your-model-name
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_TIMEOUT=60
```

```ts
// Provider adapter selection is automatic from LLM_BASE_URL.
const llm = new HelloAgentsLLM();
```

> 💡 **Smart Detection**: the framework selects the appropriate adapter from the Base URL; no manual provider selection is required.

### Supported LLM Providers

The framework supports major LLM services through **three adapters**.

#### 1. OpenAI-Compatible Adapter (Default)

Supports every service with an OpenAI-compatible interface:

| Provider Type        | Example Services                  | Configuration Example                   |
| -------------------- | --------------------------------- | --------------------------------------- |
| **Cloud API**        | OpenAI, DeepSeek, Qwen, Kimi, GLM | `LLM_BASE_URL=https://api.deepseek.com` |
| **Local Inference**  | vLLM, Ollama, SGLang              | `LLM_BASE_URL=http://localhost:8000`    |
| **Other Compatible** | Any OpenAI-format endpoint        | `LLM_BASE_URL=https://your-endpoint`    |

#### 2. Anthropic Adapter

| Provider   | Detection Condition                 | Configuration Example                    |
| ---------- | ----------------------------------- | ---------------------------------------- |
| **Claude** | `base_url` contains `anthropic.com` | `LLM_BASE_URL=https://api.anthropic.com` |

#### 3. Gemini Adapter

| Provider          | Detection Condition                                          | Configuration Example                                    |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| **Google Gemini** | `base_url` contains `googleapis.com` or `generativelanguage` | `LLM_BASE_URL=https://generativelanguage.googleapis.com` |

> 💡 **Auto-Adaptation**: the framework selects an adapter from `base_url`; no manual configuration is required.

## 📚 Teaching Examples (Chapter 07–11 + Function Calling)

Every upstream example has a traceable TypeScript counterpart (manifest: [`examples/upstream-example-manifest.json`](examples/upstream-example-manifest.json)):

| Upstream (Python, baseline `3927c6d`)        | TypeScript example                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `examples/agent/function_call_agent_demo.py` | [`examples/function-call-agent-demo.ts`](examples/function-call-agent-demo.ts)                                                                               |
| `examples/chapter07_basic_setup.py`          | [`examples/chapter07-basic-setup.ts`](examples/chapter07-basic-setup.ts)                                                                                     |
| `examples/chapter08_memory_rag.py`           | [`examples/chapter08-memory.ts`](examples/chapter08-memory.ts)                                                                                               |
| `examples/chapter09_context_engineering.py`  | [`examples/chapter09_context_engineering.ts`](examples/chapter09_context_engineering.ts)                                                                     |
| `examples/chapter10_protocols.py`            | [`examples/chapter10-mcp.ts`](examples/chapter10-mcp.ts) + [`chapter10-a2a.ts`](examples/chapter10-a2a.ts) + [`chapter10-anp.ts`](examples/chapter10-anp.ts) |
| `examples/chapter11_RL.py`                   | [`examples/chapter11-rl.ts`](examples/chapter11-rl.ts)                                                                                                       |

Examples run in **mock / dry-run mode by default** (no API key needed); real API calls are opt-in (`OPENAI_API_KEY` / `HELLOAGENTS_REAL_API=1`).

## 🏗️ Project Structure

```text
hello_agents/
├── agents/        # SimpleAgent, ReActAgent, ReflectionAgent, PlanAndSolveAgent,
│                  #   FunctionCallAgent, ToolAwareSimpleAgent
├── context/       # ContextBuilder, HistoryManager, TokenCounter, truncators
├── core/          # HelloAgentsLLM, Agent base class, Config, Message
├── evaluation/    # BFCL / GAIA / data-generation benchmarks
├── memory/        # Working/Episodic/Semantic/Perceptual memory, RAG, embedding
├── protocols/     # MCP, A2A, ANP (import-safe; adapters load-on-use)
├── rl/            # GSM8K datasets, math rewards, training backends (SFT/GRPO)
├── tools/         # Tool/ToolResponse, ToolRegistry, ToolChain, builtin tools
├── utils/         # logging, serialization, helpers
└── index.ts       # root barrel
```

> Learn 0.2.0 exports only the teaching modules above. 1.x leftover files
> (`session-store.ts`, `task-tool.ts`, `skill-tool.ts`, `circuit-breaker.ts`,
> `todo-write-tool.ts`, `dev-log-tool.ts`, `file-tools.ts`, SSE streaming
> helpers, …) are out of scope and not exported by this line (see the
> [compatibility matrix](docs/learn-v0.2.0-compatibility-matrix.md); #81
> enforces entrypoint separation).

```

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork this repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) - see [LICENSE](LICENSE) for details.

**License Key Points**:

- ✅ **Attribution**: you must give appropriate credit to the original author.
- ✅ **ShareAlike**: modified works must use the same license.
- ⚠️ **NonCommercial**: commercial use is not permitted.

For commercial use, contact the maintainers for authorization.

## 🙏 Acknowledgements

- [HelloAgents Python](https://github.com/jjyaoao/HelloAgents) for the original implementation.
- [Datawhale Hello-Agents tutorial](https://github.com/datawhalechina/hello-agents) for the open-source tutorial.
- [HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go) for the Go implementation.

## 📚 Documentation Resources

Learn-version specific:

- **[Learn version scope](docs/learn-version-scope.md)** — scope of the 0.2.0 teaching line
- **[Compatibility matrix](docs/learn-v0.2.0-compatibility-matrix.md)** — per-module upstream traceability
- **[Upstream differences (DIFF registry)](docs/upstream-differences.md)** — approved deviations
- **[Migration from Python](docs/migration-from-python.md)** — how teaching APIs map to the Python original
- **[Releasing](docs/releasing.md)** — `learn` tag publishing

Guides for the teaching modules:

- **[Configuration](docs/configuration.md)** — LLM env vars and provider adapters
- **[Context engineering](docs/context-engineering-guide.md)** — ContextBuilder, HistoryManager, TokenCounter
- **[Custom tools](docs/custom-tools.md)** — functional, class-based, and expandable tools
- **[Function calling architecture](docs/function-calling-architecture.md)** — LLM/Agent base class design
- **[Protocols](docs/protocols-guide.md)** — MCP, A2A, ANP usage
- **[Observability](docs/observability-guide.md)** — TraceLogger (kept as agent dependency)
- **[Async agents](docs/async-agent-guide.md)** — async agent implementations
- **[Logging system](docs/logging-system-guide.md)** — logging architecture
- **[Architecture](docs/architecture.md)** — overall design
- **[CI integration](docs/ci-integration.md)** — quality gates
- **[Compatibility contract](docs/compatibility-contract.md)** — what the line promises


---

<div align="center">

**HelloAgents TypeScript** - Making agent development simple and powerful
</div>
```
