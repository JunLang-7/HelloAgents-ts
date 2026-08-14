# HelloAgents TypeScript

[English](README.md) | [简体中文](README_CN.md)

> 🤖 生产级多智能体框架 - 工具响应协议、上下文工程、会话持久化、子代理机制等 16 项核心能力。

[![Bun 1.3+](https://img.shields.io/badge/bun-1.3%2B-f9f1e1.svg)](https://bun.sh/)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org/)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)

HelloAgents TypeScript 是
[HelloAgents Python](https://github.com/jjyaoao/HelloAgents) 的 TypeScript
忠实重实现，[HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go) 用作跨语言参考，本项目以 Bun 为优先运行时，同时支持 Node.js 22+。基于 OpenAI 原生 API 构建的生产级多智能体框架，集成了工具响应协议（ToolResponse）、上下文工程（HistoryManager/TokenCounter）、会话持久化（SessionStore）、子代理机制（TaskTool）、乐观锁（文件编辑）、熔断器（CircuitBreaker）、Skills 知识外化、TodoWrite 进度管理、DevLog 决策记录、流式输出（SSE）、异步生命周期、可观测性（TraceLogger）、日志系统（四种范式）、LLM/Agent 基类重构等 16 项核心能力，为构建复杂智能体应用提供完整的工程化支持。

## 📌 版本说明

- 🐍 **Python 原版**：[HelloAgents](https://github.com/jjyaoao/HelloAgents)，与 [Datawhale Hello-Agents 教程](https://github.com/datawhalechina/hello-agents) 配套。
- 🚀 **TypeScript 实现**：当前仓库，提供适用于 Bun 和 Node.js 的 ESM 公共包。
- 🐹 **Go 实现**：[HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go)，用于跨语言结构参考。
- 📦 **Python 历史版本**：[Releases](https://github.com/jjyaoao/HelloAgents/releases)提供 Python 版本从 v0.1.1 到 v0.2.9 的所有版本。

## 🚀 快速开始

### 安装

```bash
bun add @junlang-7/helloagents
```

发布的 ESM 包也支持 Node.js：

```bash
npm install @junlang-7/helloagents
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

## 🏗️ 项目结构

```text
hello-agents/
├── hello_agents/                  # 主包
│   ├── adapters/                  # LLM 提供商适配器
│   │   ├── openai.ts              # OpenAI 兼容适配器
│   │   ├── anthropic.ts           # Anthropic 适配器
│   │   ├── gemini.ts              # Gemini 适配器
│   │   ├── providers.ts           # 适配器自动检测
│   │   └── mock.ts                # 测试适配器
│   ├── core/                      # 核心组件
│   │   ├── llm.ts                 # LLM 客户端与配置
│   │   ├── agent.ts               # Agent 基类和函数调用辅助方法
│   │   ├── config.ts              # 配置管理
│   │   ├── session-store.ts       # 会话持久化
│   │   ├── lifecycle.ts           # 异步生命周期
│   │   ├── streaming.ts           # SSE 流式输出
│   │   └── message.ts             # 消息定义
│   ├── agents/                    # Agent 实现
│   │   ├── simple-agent.ts        # SimpleAgent
│   │   ├── react-agent.ts         # ReActAgent
│   │   ├── reflection-agent.ts    # ReflectionAgent
│   │   ├── plan-solve-agent.ts    # PlanSolveAgent
│   │   └── factory.ts             # Agent 工厂
│   ├── tools/                     # 工具系统
│   │   ├── registry.ts            # 工具注册表
│   │   ├── response.ts            # ToolResponse 协议
│   │   ├── circuit-breaker.ts     # 熔断器
│   │   ├── tool-filter.ts         # 子代理工具过滤器
│   │   └── builtin/               # 内置工具
│   │       ├── file-tools.ts      # 文件工具和乐观锁
│   │       ├── task-tool.ts       # 子代理工具
│   │       ├── todo-write-tool.ts # 进度管理
│   │       ├── dev-log-tool.ts    # 决策日志
│   │       └── skill-tool.ts      # 技能知识外化
│   ├── context/                   # 上下文工程
│   │   ├── history.ts             # HistoryManager
│   │   ├── token-counter.ts       # TokenCounter
│   │   ├── truncator.ts           # ObservationTruncator
│   │   └── builder.ts             # ContextBuilder
│   ├── observability/             # 可观测性
│   │   └── trace-logger.ts        # TraceLogger
│   └── skills/                    # 技能系统
│       └── loader.ts              # SkillLoader
├── docs/                          # 文档
├── examples/                      # 可运行示例
└── tests/                         # 测试用例
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

详细了解 HelloAgents v1.0.0 的 16 项核心能力：

### 基础设施

- **[工具响应协议](./docs/tool-response-protocol.md)** - ToolResponse 统一返回格式
- **[上下文工程](./docs/context-engineering-guide.md)** - HistoryManager/TokenCounter/Truncator

### 核心能力

- **[可观测性](./docs/observability-guide.md)** - TraceLogger 追踪系统
- **[熔断器](./docs/circuit-breaker-guide.md)** - CircuitBreaker 容错机制
- **[会话持久化](./docs/session-persistence-guide.md)** - SessionStore 会话管理

### 增强能力

- **[子代理机制](./docs/subagent-guide.md)** - TaskTool 与 ToolFilter
- **[Skills 知识外化](./docs/skills-usage-guide.md)** - 技能系统使用指南
- **[乐观锁](./docs/file-tools.md)** - 文件编辑工具的并发控制
- **[TodoWrite 进度管理](./docs/todowrite-usage-guide.md)** - 任务进度追踪

### 辅助功能

- **[DevLog 决策日志](./docs/devlog-guide.md)** - 开发决策记录
- **[异步生命周期](./docs/async-agent-guide.md)** - 异步 Agent 实现

### 核心架构

- **[流式输出](./docs/streaming-sse-guide.md)** - SSE 流式响应
- **[Function Calling 架构](./docs/function-calling-architecture.md)** - LLM/Agent 基类重构
- **[日志系统](./docs/logging-system-guide.md)** - 四种日志范式

### 扩展能力

- **[自定义工具扩展](./docs/custom-tools.md)** - 三种工具实现方式（函数式/标准类/可展开）

---

<div align="center">

**HelloAgents-ts** - 让智能体开发变得简单而强大 🚀
</div>
