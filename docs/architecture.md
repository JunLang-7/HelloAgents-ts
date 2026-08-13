# Architecture

The package maps Python V1 concepts into a portable TypeScript ESM design.
All public asynchronous work uses `Promise`, `AsyncIterable`, and
`AbortSignal`, so the built package runs unchanged on Bun and Node.js 22/24.

The repository keeps `src/` as its TypeScript source root. Python and Go place
their modules under `hello_agents/`, but the compatibility contract maps those
conceptual modules to `src/` and the published package exposes the same `dist`
entry point either way. Keeping `src/` avoids a mechanical path migration with
no observable API or runtime benefit.

```mermaid
flowchart LR
  APP["Application"] --> AGENT["Simple / ReAct / Reflection / PlanSolve"]
  AGENT --> LLM["HelloAgentsLLM"]
  LLM --> PROVIDER["OpenAI-compatible / Anthropic / Gemini"]
  AGENT --> REGISTRY["ToolRegistry"]
  REGISTRY --> TOOLS["Zod tools + ToolResponse"]
  AGENT --> CONTEXT["History / WorkingMemory / Sessions"]
  AGENT --> OBS["Lifecycle streams / TraceLogger"]
  TOOLS --> DURABLE["TodoWrite / DevLog JSON snapshots"]
```

- Zod is the input authority for every public tool. Its JSON Schema becomes
  the Function Calling declaration exposed to providers.
- Providers are normalized at the adapter boundary. Tool-call arguments remain
  JSON strings to preserve the Python wire contract.
- `ToolResponse` turns model-facing failures into structured data rather than
  process errors.
- Session, todo, and development-log writes use temporary files plus rename;
  the durable tools additionally serialize local mutations to prevent corrupt
  JSON during concurrent calls.
- `TraceLogger` is runtime observability. `DevLogTool` is deliberately a
  separate journal for decisions and handoff context.
