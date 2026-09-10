# HelloAgents TypeScript — 教学版

[English](README.md) | [简体中文](README_CN.md)

> 🚧 **`learn-version` 开发分支（`0.2.0`）**——忠实移植 Python [`learn_version`](https://github.com/jjyaoao/HelloAgents/tree/learn_version) 分支的 TypeScript 教学版本。本版本线与生产向 `1.x` 独立维护，并通过 npm `learn` tag 发布。
>
> 教学版移植已完成：以下模块清单均移植自上游 `learn_version` 分支（基线 `3927c6d`），逐模块可追溯性见 [`docs/learn-v0.2.0-compatibility-matrix.md`](docs/learn-v0.2.0-compatibility-matrix.md)，获批差异见 [`docs/upstream-differences.md`](docs/upstream-differences.md)。

> 🤖 教学友好的多智能体框架——使用轻量、直观的抽象配套 Datawhale Hello-Agents 教程。

[![Bun 1.3+](https://img.shields.io/badge/bun-1.3%2B-f9f1e1.svg)](https://bun.sh/)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org/)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)

HelloAgents TypeScript（教学版）是对 Python
[HelloAgents `learn_version`](https://github.com/jjyaoao/HelloAgents) 分支的
忠实教学优先移植，[HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go)
用作跨语言参考，以 Bun 为优先运行时，同时支持 Node.js 22+。移植的教学模块包括：
agents（SimpleAgent/ReActAgent/ReflectionAgent/PlanAndSolveAgent/FunctionCallAgent）、
tools（ToolRegistry/ToolChain）、memory（四种记忆 + RAG）、上下文工程、评测基准、
协议（MCP/A2A/ANP）与 RL 训练（SFT/GRPO）。逐模块可追溯性见
[兼容矩阵](docs/learn-v0.2.0-compatibility-matrix.md)，获批差异见
[DIFF 登记表](docs/upstream-differences.md)。1.x 专属能力（SessionStore、
TaskTool、Skills、CircuitBreaker、TodoWrite、DevLog、file tools、SSE 辅助、
真实 provider adapters）不属于 Learn 0.2.0 范围，**不导出**。

## 📌 版本说明

- 🐍 **Python 原版**：[HelloAgents](https://github.com/jjyaoao/HelloAgents)，与 [Datawhale Hello-Agents 教程](https://github.com/datawhalechina/hello-agents) 配套。
- 🚀 **TypeScript 实现**：当前仓库，提供适用于 Bun 和 Node.js 的 ESM 公共包。
- 🐹 **Go 实现**：[HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go)，用于跨语言结构参考。
- 📦 **Python 历史版本**：[Releases](https://github.com/jjyaoao/HelloAgents/releases)提供 Python 版本从 v0.1.1 到 v0.2.9 的所有版本。

## 🚀 快速开始

### 安装

```bash
bun add @junlang-7/helloagents@learn
```

发布的 ESM 包也支持 Node.js：

```bash
npm install @junlang-7/helloagents@learn
```

### 基本使用

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

### 环境配置

创建 `.env` 文件，或在 shell 中导出变量。完整模板见
[`.env.example`](.env.example)。

```bash
LLM_MODEL_ID=your-model-name
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_TIMEOUT=60
```

```ts
// 自动检测provider
llm = HelloAgentsLLM(); // 框架自动检测为modelscope
console.log(`检测到的provider: ${llm.provider}`);
```

> 💡 **智能检测**: 框架会根据API密钥格式和Base URL自动选择合适的provider

### 支持的LLM提供商

框架基于 **3 种适配器** 支持所有主流 LLM 服务：

#### 1. OpenAI 兼容适配器（默认）

支持所有提供 OpenAI 兼容接口的服务：

| 提供商类型   | 示例服务                               | 配置示例                             |
| ------------ | -------------------------------------- | ------------------------------------ |
| **云端 API** | OpenAI、DeepSeek、Qwen、Kimi、智谱 GLM | `LLM_BASE_URL=api.deepseek.com`      |
| **本地推理** | vLLM、Ollama、SGLang                   | `LLM_BASE_URL=http://localhost:8000` |
| **其他兼容** | 任何 OpenAI 格式接口                   | `LLM_BASE_URL=your-endpoint`         |

#### 2. Anthropic 适配器

| 提供商     | 检测条件                        | 配置示例                                 |
| ---------- | ------------------------------- | ---------------------------------------- |
| **Claude** | `base_url` 包含 `anthropic.com` | `LLM_BASE_URL=https://api.anthropic.com` |

#### 3. Gemini 适配器

| 提供商            | 检测条件                                                 | 配置示例                                                 |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| **Google Gemini** | `base_url` 包含 `googleapis.com` 或 `generativelanguage` | `LLM_BASE_URL=https://generativelanguage.googleapis.com` |

> 💡 **自动适配**：框架根据 `base_url` 自动选择适配器，无需手动指定。

## 📚 教学示例（第 07–11 章 + Function Calling）

每个上游示例都有可追踪的 TypeScript 对应文件（权威清单：[`examples/upstream-example-manifest.json`](examples/upstream-example-manifest.json)）：

| 上游（Python，基线 `3927c6d`）               | TypeScript 示例                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `examples/agent/function_call_agent_demo.py` | [`examples/function-call-agent-demo.ts`](examples/function-call-agent-demo.ts)                                                                               |
| `examples/chapter07_basic_setup.py`          | [`examples/chapter07-basic-setup.ts`](examples/chapter07-basic-setup.ts)                                                                                     |
| `examples/chapter08_memory_rag.py`           | [`examples/chapter08-memory.ts`](examples/chapter08-memory.ts)                                                                                               |
| `examples/chapter09_context_engineering.py`  | [`examples/chapter09_context_engineering.ts`](examples/chapter09_context_engineering.ts)                                                                     |
| `examples/chapter10_protocols.py`            | [`examples/chapter10-mcp.ts`](examples/chapter10-mcp.ts) + [`chapter10-a2a.ts`](examples/chapter10-a2a.ts) + [`chapter10-anp.ts`](examples/chapter10-anp.ts) |
| `examples/chapter11_RL.py`                   | [`examples/chapter11-rl.ts`](examples/chapter11-rl.ts)                                                                                                       |

示例默认以 **mock / dry-run** 模式运行（无需 API Key）；真实 API 调用需要显式 opt-in（`OPENAI_API_KEY` / `HELLOAGENTS_REAL_API=1`）。

## 🏗️ 项目结构

```text
hello_agents/
├── agents/        # SimpleAgent、ReActAgent、ReflectionAgent、PlanAndSolveAgent、
│                  #   FunctionCallAgent、ToolAwareSimpleAgent
├── context/       # ContextBuilder、HistoryManager、TokenCounter、truncator
├── core/          # HelloAgentsLLM、Agent 基类、Config、Message
├── evaluation/    # BFCL / GAIA / data-generation 基准
├── memory/        # 工作/情景/语义/感知记忆、RAG、embedding
├── protocols/     # MCP、A2A、ANP（导入安全；adapter 用时加载）
├── rl/            # GSM8K 数据集、数学奖励、训练后端（SFT/GRPO）
├── tools/         # Tool/ToolResponse、ToolRegistry、ToolChain、内置工具
├── utils/         # logging、serialization、helpers
└── index.ts       # 根教学桶
```

## 🤝 贡献

欢迎贡献代码！请遵循以下步骤：

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

本项目采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情。

**许可证要点**：

- ✅ **署名** (Attribution): 使用时需要注明原作者
- ✅ **相同方式共享** (ShareAlike): 修改后的作品需使用相同许可证
- ⚠️ **非商业性使用** (NonCommercial): 不得用于商业目的

如需商业使用，请联系项目维护者获取授权。

## 🙏 致谢

- 感谢 [HelloAgents Python 项目](https://github.com/jjyaoao/HelloAgents) 提供的原始实现
- 感谢 [Datawhale Hello-Agents 教程](https://github.com/datawhalechina/hello-agents) 提供的优秀开源教程
- 感谢 [HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go) 提供的 Go 实现

## 📚 文档资源

教学版专项：

- **[教学版范围](docs/learn-version-scope.md)** — 0.2.0 教学线范围
- **[兼容矩阵](docs/learn-v0.2.0-compatibility-matrix.md)** — 逐模块上游可追溯性
- **[上游差异（DIFF 登记表）](docs/upstream-differences.md)** — 获批差异
- **[从 Python 迁移](docs/migration-from-python.md)** — 教学 API 与 Python 原版对应关系
- **[发布说明](docs/releasing.md)** — `learn` tag 发布

教学模块指南：

- **[配置说明](docs/configuration.md)** — LLM 环境变量与 provider adapter
- **[上下文工程](docs/context-engineering-guide.md)** — ContextBuilder、HistoryManager、TokenCounter
- **[自定义工具](docs/custom-tools.md)** — 函数式/标准类/可展开工具
- **[函数调用架构](docs/function-calling-architecture.md)** — LLM/Agent 基类设计
- **[协议](docs/protocols-guide.md)** — MCP、A2A、ANP 使用
- **[可观测性](docs/observability-guide.md)** — TraceLogger（作为 Agent 依赖保留）
- **[异步 Agent](docs/async-agent-guide.md)** — 异步实现
- **[日志系统](docs/logging-system-guide.md)** — 日志架构
- **[架构](docs/architecture.md)** — 整体设计
- **[CI 协作](docs/ci-integration.md)** — 质量门禁
- **[兼容契约](docs/compatibility-contract.md)** — 本线承诺

---

<div align="center">

**HelloAgents-ts** - 让智能体开发变得简单而强大 🚀
</div>
