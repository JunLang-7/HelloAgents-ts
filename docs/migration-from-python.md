# Migrating from HelloAgents Python

Python V1.0.0 and its `main` branch remain the source of behavioural truth.
This package preserves wire names and visible outcomes while using idiomatic
TypeScript naming and async APIs.

| Python                                      | TypeScript                                                |
| ------------------------------------------- | --------------------------------------------------------- |
| `agent.run(prompt)`                         | `await agent.run(prompt)`                                 |
| `agent.arun(...)`                           | `await agent.run(..., { signal, hooks })` where supported |
| `agent.arun_stream(...)`                    | `agent.stream(...)` yielding an `AsyncIterable`           |
| `HelloAgentsLLM(api_key=..., base_url=...)` | `new HelloAgentsLLM({ apiKey, baseUrl })`                 |
| `tool.run_with_timing(...)`                 | `await tool.execute(...)`                                 |
| `ToolParameter` declarations                | one Zod `inputSchema`                                     |
| snake_case constructor fields               | camelCase options; snake_case serialized payloads         |

```ts
import { HelloAgentsLLM, ReActAgent } from '@junlang-7/helloagents';

const llm = new HelloAgentsLLM({
  model: 'your-model',
  apiKey: '…',
  baseUrl: 'https://provider.example/v1'
});
const agent = new ReActAgent({ name: 'assistant', llm, maxSteps: 5 });
const answer = await agent.run('Summarize this project.');
```

The first release intentionally excludes Python V0.x memory/RAG, RL/evaluation
packages, MCP/A2A/ANP protocols, and legacy regex-style agents. See the
[explicit exclusions](compatibility-contract.md#9-explicit-first-release-exclusions)
before porting an older Python application.
