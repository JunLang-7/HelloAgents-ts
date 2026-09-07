# HelloAgents TypeScript 教学版对齐基线

## 目标

`learn-version` 是与 `main`/`1.x` 独立维护的教学版本线。它将 Python
HelloAgents 的 `learn_version` 分支忠实移植为 TypeScript，优先保证教程中的概念、执行流程、公开能力和示例一致，而不是继承 `1.x` 的生产级扩展。

首个 npm 版本为 `0.2.0`，使用 `learn` dist-tag 发布：

```bash
npm publish --tag learn
npm install @junlang-7/helloagents@learn
```

`package.json` 的 `publishConfig.tag` 也固定为 `learn`，避免教学版覆盖 npm 的
`latest`（当前由 `1.x` 维护）。

## 上游基线

- 仓库：<https://github.com/jjyaoao/HelloAgents>
- 分支：[`learn_version`](https://github.com/jjyaoao/HelloAgents/tree/learn_version)
- 固定提交：[`3927c6d1decb37737c4c1344fde00ccef55ab1f3`](https://github.com/jjyaoao/HelloAgents/commit/3927c6d1decb37737c4c1344fde00ccef55ab1f3)
- 上游源码版本：`0.2.9`
- TypeScript 首发版本：`0.2.0`

固定提交用于防止开发过程中因上游分支继续变化而产生隐式范围漂移。后续上游变更应通过独立 Issue 评估和引入。

## 对齐范围

1. 核心模型与配置：`Agent`、`HelloAgentsLLM`、`Message`、`Config`、数据库配置与异常。
2. Agent 范式：`SimpleAgent`、`FunctionCallAgent`、`ToolAwareSimpleAgent`、`ReActAgent`、`ReflectionAgent`、`PlanAndSolveAgent`。
3. 工具体系：工具基类、参数与装饰器语义、注册表、工具链、异步执行器及上游内置工具。
4. Memory/RAG：基础记忆模型、工作/情景/语义/感知记忆、嵌入、存储适配和 RAG 流程。
5. Context Engineering：上下文收集、选择、组织、压缩和 token 预算。
6. 协议：MCP、A2A、ANP 及其工具封装。
7. 评测：BFCL、GAIA、数据生成、LLM Judge 和胜率评估。
8. RL：数据集、奖励函数、训练器包装与训练工具。
9. 教程示例：上游 Chapter 07–11 和 Function Calling Agent 示例。
10. 工具函数、日志、序列化、双语文档、测试和 npm 发布验证。

## 忠实移植准则

- 保持上游教学顺序、核心抽象、默认值、提示词意图和主要控制流。
- 公共符号原则上保持同名；仅进行必要的 TypeScript 命名与异步模型适配，并在兼容矩阵中记录。
- Python 的同步/迭代器接口映射为适合 Bun/Node.js 的 Promise/AsyncIterable 时，应保持可观察行为一致。
- 可选重依赖应保持按需启用；导入基础包不得强制加载数据库、协议、评测或 RL 依赖。
- 不将 `1.x` 专属的 Session、Sub-Agent、Skills、CircuitBreaker、TraceLogger 等能力偷偷混入教学 API；确需复用实现时不得改变教学版对外语义。
- 每个模块必须提供对照测试或固定 fixture，明确其上游来源文件。

## `0.2.0` 完成定义

- Milestone 内所有阻塞 Issue 关闭。
- 公开 API 兼容矩阵完成，所有计划内符号有实现或有明确、经批准的差异说明。
- Chapter 07–11 示例可在 Bun 和 Node.js 22+ 下运行。
- typecheck、lint、单元测试、构建、Node.js smoke test 和 package consumer test 全部通过。
- `npm pack --dry-run` 内容经检查，不包含开发产物或敏感信息。
- 发布 `@junlang-7/helloagents@0.2.0` 时使用 `learn` tag，且 npm `latest` 仍指向 `1.x`。
