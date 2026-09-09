# 协议模块指南（MCP / A2A / ANP）

教学版复刻了上游 `hello_agents/protocols/` 三套智能体通信协议（#75），
入口子路径：`@junlang-7/helloagents/protocols`（以及
`/protocols/mcp`、`/protocols/a2a`、`/protocols/anp`）。

与上游 Python 版（`docs/api/protocols/`）对应，TS 端差异详见
`docs/upstream-differences.md` 的 DIFF-036 ~ DIFF-039。

## MCP（Model Context Protocol）

```ts
import {
  MCPClient,
  MCPServer,
  createContext,
  parseContext
} from '@junlang-7/helloagents/protocols';
```

- **上下文工具**：`createContext(messages?, tools?, resources?, metadata?)` 与
  `parseContext(str | dict)` 为纯函数，零依赖。
- **服务器**：`new MCPServer(name, description?)` 用 `addTool(func, name?, desc?)`、
  `addResource`、`addPrompt` 注册；`run('stdio')` 以 JSON-RPC 2.0 行协议运行，
  `run('memory')` 直接暴露自身。
- **客户端**：`new MCPClient(source)` 自动分类——
  - 内存服务器实例 → `MemoryTransport`
  - 命令列表或脚本路径 → `StdioJsonRpcTransport`（真实子进程）
  - HTTP/SSE URL 或配置 → 未配置传输，`connect()` 明确报错（可注入实现）
- **工具封装**：`MCPTool`（内置演示服务器或外部服务器）+ `MCPWrappedTool`
  （`await tool.getExpandedToolsAsync()` 展开为独立工具）。

示例：`bun run examples/chapter10-mcp.ts`

## A2A（Agent-to-Agent Protocol）

```ts
import {
  A2AServer,
  A2AClient,
  AgentNetwork,
  AgentRegistry,
  createExampleAgent
} from '@junlang-7/helloagents/protocols';
```

- **服务器**：`new A2AServer({ name, description, ... })` + `addSkill(name, fn)`
  或 `server.skill(name)(fn)`；`await server.run(host, port)` 返回可关闭的
  `http.Server`（非阻塞），端点 `/info`、`/skills`、`/execute/:skill`、`/ask`、`/health`。
- **客户端**：`new A2AClient(baseUrl)`，方法 `ask` / `executeSkill` / `getInfo` / `listSkills`。
- **网络与注册**：`AgentNetwork.addAgent/getAgent/discoverAgents`（真实 HTTP 发现）、
  `AgentRegistry.registerAgent/unregisterAgent/findAgent`。
- **别名与占位**：`A2AAgent === A2AServer`；`A2AMessage`/`MessageType` 为类型；
  `createMessage`/`parseMessage` 保持上游占位行为（抛错，DIFF-038）。

示例：`bun run examples/chapter10-a2a.ts`

## ANP（Agent Network Protocol）

```ts
import {
  ANPDiscovery,
  ANPNetwork,
  ServiceInfo,
  registerService,
  discoverService
} from '@junlang-7/helloagents/protocols';
```

- **发现**：`ANPDiscovery.registerService / unregisterService / discoverServices(type?, filters?) / getService / listAllServices`。
- **网络**：`ANPNetwork.addNode / removeNode / connectNodes / routeMessage / broadcastMessage / getNetworkStats / getNodeInfo`。
- **便捷函数**：`registerService(discovery, service | {service_id, service_type, endpoint, ...})`、
  `discoverService(discovery, type?)`。
- **工具封装**：`ANPTool` 提供 register/unregister/discover/add_node/route_message/get_stats。

示例：`bun run examples/chapter10-anp.ts`

## 测试与验证

- 单元测试：`tests/protocols-mcp.test.ts`、`tests/protocols-a2a.test.ts`、`tests/protocols-anp.test.ts`
- MCP stdio 边界：`tests/fixtures/mcp-stdio-server.ts`（真实子进程 + JSON-RPC 2.0）
- A2A 互通：本地随机端口真实 HTTP，客户端/服务端端到端断言
- 发布面：`tests/package-consumer.mjs` 覆盖 4 个 protocols 子路径的干净 tarball 导入
