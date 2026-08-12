# HelloAgents TypeScript

HelloAgents TypeScript is a **Bun-first**, Node.js-compatible reimplementation
of [HelloAgents Python](https://github.com/jjyaoao/HelloAgents). Python V1.0.0
and Python `main` are the behavioural authority. The
[Go implementation](https://github.com/chaojixinren/HelloAgents-go) is used
only as a cross-language reference.

It includes four agent paradigms, OpenAI-compatible/Anthropic/Gemini adapters,
Zod-derived Function Calling tools, sessions, streaming, skills, subagents,
trace logging, durable todo lists, and development logs.

## Install

Use Bun for development:

```sh
bun add @junlang-7/helloagents zod
```

The published ESM package also works on Node.js 22 and 24:

```sh
npm install @junlang-7/helloagents zod
```

## Quick start

Set these variables in your shell (or load a `.env` file with your application
runtime):

```sh
export LLM_MODEL_ID="your-model"
export LLM_API_KEY="your-api-key"
export LLM_BASE_URL="https://your-openai-compatible-endpoint/v1"
```

```ts
import { HelloAgentsLLM, ReActAgent, ToolRegistry, CalculatorTool } from '@junlang-7/helloagents';

const llm = new HelloAgentsLLM();
const tools = new ToolRegistry().register(new CalculatorTool());
const agent = new ReActAgent({ name: 'assistant', llm, toolRegistry: tools });

console.log(await agent.run('What is sqrt(144)?'));
```

See [configuration](docs/configuration.md), [architecture](docs/architecture.md),
[migration notes](docs/migration-from-python.md), and
[custom tools](docs/custom-tools.md). Runnable minimal programs are in
[`examples/`](examples/).

## Development and release checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run format:check
bun test
bun run build
bun run test:node
bun run test:package
```

`bun run test:integration` is intentionally opt-in. It only contacts a live
provider when `HELLOAGENTS_INTEGRATION=1` plus `LLM_MODEL_ID`, `LLM_API_KEY`,
and `LLM_BASE_URL` are supplied.

## Compatibility and license

The [compatibility contract](docs/compatibility-contract.md) defines the
Python V1 boundary, the Bun/Node support matrix, and intentional language
mappings. This adaptation is licensed under [CC BY-NC-SA 4.0](LICENSE); see
[NOTICE](NOTICE) for upstream attribution.
