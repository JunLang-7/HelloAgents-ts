# HelloAgents TypeScript — 教学版（Learn Version）

[English](README.md) | [简体中文](README_CN.md)

> 📚 **`learn-version`（0.2.0）** — 面向教学的 Python
> [`learn_version`](https://github.com/jjyaoao/HelloAgents/tree/learn_version)
> 分支 TypeScript 忠实复刻，配套
> [Datawhale Hello-Agents 教程](https://github.com/datawhalechina/hello-agents)。
> 本分支与面向生产的 `1.x` 分支独立维护，npm 上以 **`learn`** tag 发布。

[![Bun 1.4+](https://img.shields.io/badge/bun-1.4%2B-f9f1e1.svg)](https://bun.sh/)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org/)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](LICENSE)

HelloAgents TypeScript（教学版）是对 Python 教程分支的教学优先复刻。每个模块
均可在 `docs/learn-v0.2.0-compatibility-matrix.md` 中追溯到上游文件，并在
`docs/upstream-differences.md`（DIFF 登记表）中记录有意的差异。**Bun 优先**，
同时兼容 Node.js 22+。

- 🐍 **Python 原版（教程）**：[HelloAgents](https://github.com/jjyaoao/HelloAgents) `learn_version`
- 🐹 **Go 参考实现**：[HelloAgents-Go](https://github.com/chaojixinren/HelloAgents-go)

## 快速开始

### 安装

```bash
bun add @junlang-7/helloagents@learn
```

或使用 npm：

```bash
npm install @junlang-7/helloagents@learn
```

> `@learn` dist-tag 始终指向最新教学版构建（`0.2.x`）；默认 `latest` tag 属于
> 独立的 `1.x` 生产线。

### 最小 Agent（默认 mock）

所有示例默认以 **mock / dry-run** 模式运行，无需 API Key。dry-run 需显式
构造 `MockAdapter`；真实 API 调用需要显式 opt-in（设置 `LLM_MODEL_ID` /
`LLM_API_KEY` / `LLM_BASE_URL`，或构造 `HelloAgentsLLM` 时显式传参——不传
adapter 即走真实 provider）。

```ts
import { HelloAgentsLLM, MockAdapter, SimpleAgent } from '@junlang-7/helloagents';

const llm = new HelloAgentsLLM({
  model: 'example-model',
  apiKey: 'example-key',
  baseUrl: 'https://example.invalid/v1',
  adapter: new MockAdapter({
    invoke: () => ({
      content: '你好！我是示例助手。',
      model: 'example-model',
      usage: {},
      latency_ms: 0
    })
  })
});
const agent = new SimpleAgent({ name: 'assistant', llm });

console.log(await agent.run('你好，请介绍一下自己'));
```

使用真实 provider：导出 `LLM_*` 变量即可。

```ts
const llm = new HelloAgentsLLM(); // 读取 LLM_* 环境变量
```

### 环境变量

创建 `.env` 文件（模板见 [`.env.example`](.env.example)）或在 shell 中导出。
框架根据 `LLM_BASE_URL` 自动选择 provider adapter（OpenAI 兼容 / Anthropic /
Gemini）。

```bash
LLM_MODEL_ID=your-model-name
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://your-openai-compatible-endpoint/v1
LLM_TIMEOUT=60
```

### 可选依赖（用到才加载）

导入包本身不需要 Bun/Node.js 之外的任何依赖。重量级后端均为**用时探测**，
缺失不会导致导入失败：

| 能力                | 依赖                                 | 说明                                         |
| ------------------- | ------------------------------------ | -------------------------------------------- |
| 语义记忆 / RAG      | Qdrant + Neo4j 服务                  | 仅在配置了 `QDRANT_URL` / `NEO4J_URI` 时使用 |
| BFCL 评测           | `bfcl` CLI                           | 校验 `bfcl --version >= 0.4.0`               |
| RL 训练（SFT/GRPO） | Python：`trl`/`torch`/`transformers` | 经 Python 解释器桥接；缺后端返回安装指导     |
| HF 模型下载         | `HF_TOKEN`（可选）                   | 仅真实训练需要                               |

## 教学示例（第 07–11 章 + Function Calling）

每个上游示例都有可追踪的 TypeScript 对应文件：

| 上游（Python，基线 `3927c6d`）               | TypeScript 示例                                                                                                                                              | 默认运行方式                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `examples/agent/function_call_agent_demo.py` | [`examples/function-call-agent-demo.ts`](examples/function-call-agent-demo.ts)                                                                               | mock LLM，真实 API opt-in             |
| `examples/chapter07_basic_setup.py`          | [`examples/chapter07-basic-setup.ts`](examples/chapter07-basic-setup.ts)                                                                                     | mock LLM，真实 API opt-in             |
| `examples/chapter08_memory_rag.py`           | [`examples/chapter08-memory.ts`](examples/chapter08-memory.ts)                                                                                               | 内存路径；Qdrant/Neo4j 段 opt-in      |
| `examples/chapter09_context_engineering.py`  | [`examples/chapter09_context_engineering.ts`](examples/chapter09_context_engineering.ts)                                                                     | SQLite 记忆；RAG 段 opt-in            |
| `examples/chapter10_protocols.py`            | [`examples/chapter10-mcp.ts`](examples/chapter10-mcp.ts) + [`chapter10-a2a.ts`](examples/chapter10-a2a.ts) + [`chapter10-anp.ts`](examples/chapter10-anp.ts) | 本地 transport，无需外部服务          |
| `examples/chapter11_RL.py`                   | [`examples/chapter11-rl.ts`](examples/chapter11-rl.ts)                                                                                                       | 数据集/奖励纯逻辑；训练需 Python 后端 |

运行任意示例：

```bash
bun run examples/chapter07-basic-setup.ts
```

## 模块结构

```text
hello_agents/
├── agents/        # SimpleAgent、ReActAgent、ReflectionAgent、PlanAndSolveAgent、
│                  #   FunctionCallAgent、ToolAwareSimpleAgent
├── context/       # ContextBuilder、HistoryManager、TokenCounter、truncator
├── core/          # HelloAgentsLLM、Agent 基类、Config、SessionStore、流式
├── evaluation/    # BFCL / GAIA / data-generation 基准
├── memory/        # 工作/情景/语义/感知记忆、RAG、embedding
├── protocols/     # MCP、A2A、ANP（导入安全；adapter 用时加载）
├── rl/            # GSM8K 数据集、数学奖励、训练后端（SFT/GRPO）
├── tools/         # Tool/ToolResponse、ToolRegistry、ToolChain、内置工具
├── utils/         # logging、serialization、helpers
└── index.ts       # 根教学桶
```

## 版本策略

- **`learn-version` / npm `learn` tag（0.2.0）**：教学线。PR 合入
  `learn-version`；`main` 不是本线的合并目标。
- **`main` / npm `latest`（1.x）**：独立的生产线。
- 兼容性由 `tests/learn-fixture-gate.test.ts` 与 `scripts/release-gate.ts`
  强制：每个 "Implemented" 矩阵行必须有真实测试证据，每个保留差异必须登记
  到 DIFF 表。

## 文档

- [教学版范围](docs/learn-version-scope.md)
- [兼容矩阵](docs/learn-v0.2.0-compatibility-matrix.md)
- [上游差异（DIFF 登记表）](docs/upstream-differences.md)
- [配置说明](docs/configuration.md)
- [从 Python 迁移](docs/migration-from-python.md)
- [上下文工程指南](docs/context-engineering-guide.md)
- [自定义工具](docs/custom-tools.md)
- [函数调用架构](docs/function-calling-architecture.md)

## 参与贡献与许可证

参与说明见 [CI 协作](docs/ci-integration.md)；仓库以 CC BY-NC-SA 4.0 许可
（见 [LICENSE](LICENSE)）。
