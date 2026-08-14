# HelloAgents TypeScript

[English](README.md) | [简体中文](README_CN.md)

> 🤖 Production-Grade Multi-Agent Framework - Tool Response Protocol, Context Engineering, Session Persistence, Sub-Agent Mechanism, and 16 core capabilities.

[![Bun 1.3+](https://img.shields.io/badge/bun-1.3%2B-f9f1e1.svg)](https://bun.sh/)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org/)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)

HelloAgents TypeScript is a faithful TypeScript reimplementation of
[HelloAgents Python](https://github.com/jjyaoao/HelloAgents), with
[HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go) as a
cross-language reference. It is a Bun-first, Node.js 22+-compatible,
production-grade multi-agent framework built on the native OpenAI API. It
integrates 16 core capabilities: Tool Response Protocol (ToolResponse), Context
Engineering (HistoryManager/TokenCounter), Session Persistence (SessionStore),
Sub-Agent Mechanism (TaskTool), Optimistic Locking (file editing), Circuit
Breaker (CircuitBreaker), Skills externalization, TodoWrite progress management,
DevLog decision recording, Streaming Output (SSE), Async Lifecycle,
Observability (TraceLogger), and LLM/Agent base-class architecture.

## 📌 Version Notes

- 🐍 **Python Original**: [HelloAgents](https://github.com/jjyaoao/HelloAgents), paired with the [Datawhale Hello-Agents tutorial](https://github.com/datawhalechina/hello-agents).
- 🚀 **TypeScript Implementation**: this repository, with a public ESM package for Bun and Node.js.
- 🐹 **Go Implementation**: [HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go), used as a cross-language structural reference.
- 📦 **Historical Python Releases**: [Releases](https://github.com/jjyaoao/HelloAgents/releases) provides Python releases from v0.1.1 through v0.2.9.

## 🚀 Quick Start

### Installation

```bash
bun add @junlang-7/helloagents
```

The published ESM package also works with Node.js:

```bash
npm install @junlang-7/helloagents
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

## 🏗️ Project Structure

```text
hello-agents/
├── hello_agents/                  # Main package
│   ├── adapters/                  # LLM provider adapters
│   │   ├── openai.ts              # OpenAI-compatible adapter
│   │   ├── anthropic.ts           # Anthropic adapter
│   │   ├── gemini.ts              # Gemini adapter
│   │   ├── providers.ts           # Adapter auto-detection
│   │   └── mock.ts                # Test adapter
│   ├── core/                      # Core components
│   │   ├── llm.ts                 # LLM client and configuration
│   │   ├── agent.ts               # Agent base class and Function Calling helpers
│   │   ├── config.ts              # Configuration management
│   │   ├── session-store.ts       # Session persistence
│   │   ├── lifecycle.ts           # Async lifecycle
│   │   ├── streaming.ts           # SSE streaming output
│   │   └── message.ts             # Message definitions
│   ├── agents/                    # Agent implementations
│   │   ├── simple-agent.ts        # SimpleAgent
│   │   ├── react-agent.ts         # ReActAgent
│   │   ├── reflection-agent.ts    # ReflectionAgent
│   │   ├── plan-solve-agent.ts    # PlanSolveAgent
│   │   └── factory.ts             # Agent factory
│   ├── tools/                     # Tool system
│   │   ├── registry.ts            # Tool registry
│   │   ├── response.ts            # ToolResponse protocol
│   │   ├── circuit-breaker.ts     # Circuit breaker
│   │   ├── tool-filter.ts         # Tool filters for subagents
│   │   └── builtin/               # Built-in tools
│   │       ├── file-tools.ts      # File tools and optimistic locking
│   │       ├── task-tool.ts       # Sub-agent tool
│   │       ├── todo-write-tool.ts # Progress management
│   │       ├── dev-log-tool.ts    # Decision logging
│   │       └── skill-tool.ts      # Skills externalization
│   ├── context/                   # Context engineering
│   │   ├── history.ts             # HistoryManager
│   │   ├── token-counter.ts       # TokenCounter
│   │   ├── truncator.ts           # ObservationTruncator
│   │   └── builder.ts             # ContextBuilder
│   ├── observability/             # Observability
│   │   └── trace-logger.ts        # TraceLogger
│   └── skills/                    # Skills system
│       └── loader.ts              # SkillLoader
├── docs/                          # Documentation
├── examples/                      # Runnable examples
└── tests/                         # Test cases
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

Learn more about the 16 core capabilities of HelloAgents TypeScript.

### Infrastructure

- **[Tool Response Protocol](docs/tool-response-protocol.md)** - ToolResponse unified return format
- **[Context Engineering](docs/context-engineering-guide.md)** - HistoryManager, TokenCounter, and Truncator

### Core Capabilities

- **[Observability](docs/observability-guide.md)** - TraceLogger tracing system
- **[Circuit Breaker](docs/circuit-breaker-guide.md)** - CircuitBreaker fault tolerance
- **[Session Persistence](docs/session-persistence-guide.md)** - SessionStore session management

### Enhanced Capabilities

- **[Sub-Agent Mechanism](docs/subagent-guide.md)** - TaskTool and ToolFilter
- **[Skills Externalization](docs/skills-usage-guide.md)** - Skills system usage
- **[Optimistic Locking](docs/file-tools.md)** - concurrent control for file editing tools
- **[TodoWrite Progress Management](docs/todowrite-usage-guide.md)** - task progress tracking

### Auxiliary Features

- **[DevLog Decision Logging](docs/devlog-guide.md)** - development decision recording
- **[Async Lifecycle](docs/async-agent-guide.md)** - asynchronous Agent implementation

### Core Architecture

- **[Streaming Output](docs/streaming-sse-guide.md)** - SSE streaming responses
- **[Function Calling Architecture](docs/function-calling-architecture.md)** - LLM/Agent base class architecture
- **[Logging System](docs/logging-system-guide.md)** - logging architecture

### Extension Capabilities

- **[Custom Tool Extension](docs/custom-tools.md)** - functional, standard-class, and expandable tools

---

<div align="center">

**HelloAgents TypeScript** - Making agent development simple and powerful
</div>
