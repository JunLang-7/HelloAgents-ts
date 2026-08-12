# HelloAgents TypeScript compatibility contract

**Status:** accepted
**Issue:** [#3](https://github.com/JunLang-7/HelloAgents-ts/issues/3)
**Last reviewed:** 2026-08-12

## 1. Purpose and source authority

HelloAgents-ts is a Bun-first, Node.js-compatible TypeScript reimplementation
of HelloAgents Python **V1.0.0**.  This document is the compatibility contract
used to decide what the TypeScript package must do, how a mismatch is resolved,
and what is deliberately outside the first release.

| Priority | Source | Role |
| --- | --- | --- |
| 1 | [`jjyaoao/HelloAgents` `main`](https://github.com/jjyaoao/HelloAgents) at `5432566d01ea1c2095c4a717fe2a010aa1c3b0bd` | Current behavioural authority, including post-1.0 bug fixes. |
| 2 | Python [`V1.0.0`](https://github.com/jjyaoao/HelloAgents/releases/tag/V1.0.0) at `9ff239a351a413133ffcfa96abbc782ff17e91dc` | Published release boundary and public product scope. |
| 3 | Python V1.0.0 tests and docs | Acceptance scenarios and observable edge cases. |
| 4 | [`chaojixinren/HelloAgents-go`](https://github.com/chaojixinren/HelloAgents-go) | Cross-language implementation reference only. |
| 5 | Python V0.x releases | Historical compatibility reference only. |

If sources conflict, the earlier row wins.  In particular, a Go difference is
never a reason to change Python behaviour.  The Go repository contains
explicit scaffold implementations in its base-agent/lifecycle code, so it must
not be treated as a complete semantic oracle.

## 2. Runtime and schema decisions

| Concern | Decision |
| --- | --- |
| Language | TypeScript with `strict: true`. |
| Primary development runtime | Bun. `bun install`, `bun test`, and `bun run` are the documented development path. |
| Published-runtime compatibility | The same npm package must run on Bun and Node.js 22/24 LTS. |
| Module format | ESM-first. CommonJS support is only added if the compatibility investigation in issue #4 shows a concrete consumer need. |
| Public async model | `Promise`, `AsyncIterable`, `AbortSignal`, and Web Streams; public types must not expose Bun-specific objects. |
| Runtime validation | Zod 4 is a production dependency. Untrusted input is parsed with `safeParse`; Zod errors are translated to HelloAgents errors or `ToolResponse.error`. |
| Tool input source of truth | A Zod schema. It derives TypeScript input types and Function Calling JSON Schema through `z.toJSONSchema()`. |
| Bun optimisation | `Bun.*` APIs are allowed only behind a replaceable I/O/runtime adapter. The core must continue to pass Node 22/24 smoke tests. |

Zod schemas used for Function Calling must be JSON-Schema representable.  A
tool that requires a non-representable construct (for example `Date`, `Map`,
`Set`, or a transform) must reject registration or supply a separate,
lossless JSON Schema at its boundary.

## 3. Public API contract

The TypeScript API is idiomatic camelCase.  Its *serialized* payloads preserve
the Python wire field names whenever they cross a provider, session, trace, or
SSE boundary.  Compatibility aliases are required only where the Python name
is a documented public entry point and changing it would prevent a direct
migration.

### 3.1 Top-level package exports

Python [`hello_agents/__init__.py`](https://github.com/jjyaoao/HelloAgents/blob/main/hello_agents/__init__.py)
exports the following.  The first TypeScript release must export equivalent
symbols from `@helloagents/core` (the final package name is decided in #4).

| Python symbol | TypeScript symbol | Required observable behaviour |
| --- | --- | --- |
| `HelloAgentsLLM` | `HelloAgentsLLM` | Unified ordinary, streaming, and Function Calling LLM client. |
| `Config` | `Config` plus `createConfig` / `configSchema` | Python defaults and environment precedence; typed immutable/validated configuration. |
| `Message` | `Message` plus `messageSchema` | Roles `user`, `assistant`, `system`, `tool`, `summary`; ISO timestamp serialization. |
| `HelloAgentsException` | `HelloAgentsError` | Base error. Subclasses mirror LLM, agent, config, and tool categories. |
| `SimpleAgent` | `SimpleAgent` | Conversation agent with optional Function Calling. |
| `ReActAgent` | `ReActAgent` | Thought/Action/Finish Function Calling loop. |
| `ReflectionAgent` | `ReflectionAgent` | Execute, critique, and refine loop. |
| `PlanSolveAgent` | `PlanSolveAgent` | Planner/executor agent. |
| `ToolRegistry`, `global_registry` | `ToolRegistry`, `globalRegistry` | Class/function tool registration and execution. |
| `CalculatorTool`, `calculate` | `CalculatorTool`, `calculate` | Safe mathematical calculation tool and convenience helper. |
| `__version__`, metadata | `version`, metadata constants | Package version and attribution metadata. |

Python's top-level package exports `PlanSolveAgent`.  Its internal
`agents` package also exposes a `PlanAndSolveAgent` import alias; TypeScript
may expose the same alias from the agents subpath for migration convenience,
but it is not a required top-level export.

### 3.2 Core data and invocation semantics

| Python API | TypeScript API | Compatibility rule |
| --- | --- | --- |
| `llm.invoke(messages, **kwargs) -> LLMResponse` | `await llm.invoke(messages, options?)` | Preserve `content`, `model`, `usage`, `latency_ms`, and optional `reasoning_content` on serialized output. |
| `llm.think()` / `stream_invoke()` | `llm.stream()` | Return `AsyncIterable<string>`; retain final `lastCallStats`. |
| `llm.invoke_with_tools(messages, tools, tool_choice)` | `await llm.invokeWithTools(messages, tools, toolChoice, options?)` | Preserve tool-call ID, name, JSON-string arguments, response content, model, usage, and latency. |
| `llm.ainvoke()` / `ainvoke_with_tools()` | Alias the native Promise methods | TypeScript is already asynchronous; do not duplicate a second execution path. |
| `Agent.run(input, **kwargs) -> str` | `await agent.run(input, options?) -> Promise<string>` | Resolve with the final answer and commit user/assistant history only at the same points as Python. |
| `Agent.arun(...)` | `agent.run(input, { hooks, signal, ... })` | Hook failures/timeouts follow the lifecycle contract; no Python event-loop wrapper is exposed. |
| `Agent.arun_stream()` | `agent.stream(input, options?) -> AsyncIterable<AgentEvent>` | Event data uses Python field names on the wire: `agent_name`, `input_text`, `tool_call_id`, etc. |
| `stream_to_sse()` / `stream_to_json()` | `streamToSse()` / `streamToJsonl()` | Produce valid SSE (`event:`/`data:`/blank line) and one JSON object per JSONL line. |

The Python API has both sync and async forms because Python can block.  The
TypeScript public API is Promise-first; a blocking API is explicitly out of
scope.  This is a language mapping, not a behavioural change.

### 3.3 Tool contract

| Python concept | TypeScript contract |
| --- | --- |
| `ToolParameter` | `inputSchema` is the authoritative Zod object schema; a `ToolParameter` compatibility projection may be generated for inspection. |
| `Tool.run(parameters) -> ToolResponse` | `tool.execute(input, context?) -> Promise<ToolResponse>`; input is parsed before implementation code runs. |
| `run_with_timing` / `arun_with_timing` | Registry wrapper measures `time_ms`, adds `params_input` and `tool_name`, and converts uncaught errors to `INTERNAL_ERROR`. |
| `ToolResponse.success/partial/error` | Equivalent factory functions/classes with status values `success`, `partial`, and `error`. |
| `Tool.to_openai_schema()` | Generate an OpenAI-shaped Function Calling schema from the Zod input schema. |
| `ToolRegistry.register_function()` | `registerFunction()` wraps a function into a tool response, preserving its return value in `data.output`. |
| `tool_action` and expandable tools | A typed action helper/decorator or explicit `expand()` implementation; resulting sub-tools are registered in place of the parent when auto-expansion is enabled. |

`ToolResponse` serialization uses this stable shape:

```ts
{
  status: "success" | "partial" | "error",
  text: string,
  data: Record<string, unknown>,
  error?: { code: string; message: string },
  stats?: Record<string, unknown>,
  context?: Record<string, unknown>,
}
```

The standard tool error codes are `NOT_FOUND`, `ACCESS_DENIED`,
`PERMISSION_DENIED`, `IS_DIRECTORY`, `BINARY_FILE`, `INVALID_PARAM`,
`INVALID_FORMAT`, `EXECUTION_ERROR`, `TIMEOUT`, `INTERNAL_ERROR`, `CONFLICT`,
`CIRCUIT_OPEN`, `NETWORK_ERROR`, `API_ERROR`, and `RATE_LIMIT`.

### 3.4 Constructor/options mapping

Python constructor arguments become named TypeScript option objects.  The
option field name is camelCase, except for explicitly serialized provider
payloads.

| Python class | Python arguments that must remain represented | TypeScript options |
| --- | --- | --- |
| `HelloAgentsLLM` | `model`, `api_key`, `base_url`, `temperature`, `max_tokens`, `timeout`, provider kwargs | `model`, `apiKey`, `baseUrl`, `temperature`, `maxTokens`, `timeoutMs`, `providerOptions` |
| `SimpleAgent` | `name`, `llm`, `system_prompt`, `config`, `tool_registry`, `enable_tool_calling`, `max_tool_iterations` | `name`, `llm`, `systemPrompt`, `config`, `toolRegistry`, `enableToolCalling`, `maxToolIterations` |
| `ReActAgent` | `name`, `llm`, `system_prompt`, `config`, `tool_registry`, `max_steps` | `name`, `llm`, `systemPrompt`, `config`, `toolRegistry`, `maxSteps` |
| `ReflectionAgent` | base agent options, `max_iterations`, `custom_prompts` | base options, `maxIterations`, `prompts` |
| `PlanSolveAgent` | base agent options, `custom_prompts`, planner/executor tool options | base options, `prompts`, `enableToolCalling`, `maxToolIterations` |
| `SessionStore` | `session_dir` | `sessionDir` |
| `TraceLogger` | `output_dir`, `sanitize`, `html_include_raw_response` | `outputDir`, `sanitize`, `htmlIncludeRawResponse` |

Every options schema must apply Python's documented default value where a
corresponding value exists.  Config values that are not valid in TypeScript
must fail at construction with a `ConfigError`, not be silently coerced.

## 4. Module map

The target TypeScript layout follows Python's conceptual boundaries, while
using lower-case kebab-case file names.

| Python source | Target TypeScript module(s) | Status / owning issue |
| --- | --- | --- |
| `core/config.py`, `message.py`, `exceptions.py`, `llm_response.py`, `lifecycle.py`, `streaming.py` | `src/core/config.ts`, `message.ts`, `errors.ts`, `responses.ts`, `lifecycle.ts`, `streaming.ts` | #1 |
| `core/llm.py`, `llm_adapters.py` | `src/core/llm.ts`, `src/adapters/{base,openai,anthropic,gemini}.ts` | #2, #16 |
| `tools/response.py`, `errors.py`, `base.py`, `registry.py` | `src/tools/{response,errors,tool,registry}.ts` | #6 |
| `tools/circuit_breaker.py` | `src/tools/circuit-breaker.ts` | #5 |
| `context/{history,token_counter,truncator,builder}.py` | `src/context/{history,token-counter,truncator,builder}.ts` | #7 |
| `core/agent.py`, `session_store.py` | `src/core/{agent,session-store}.ts` | #11 |
| `agents/{simple_agent,react_agent,reflection_agent,plan_solve_agent,factory}.py` | `src/agents/{simple-agent,react-agent,reflection-agent,plan-solve-agent,factory}.ts` | #8, #10, #13 |
| `observability/trace_logger.py` | `src/observability/trace-logger.ts` | #14 |
| `tools/builtin/{calculator,file_tools}.py` | `src/tools/builtin/{calculator,file-tools}.ts` | #12 |
| `skills/loader.py`, `tools/builtin/skill_tool.py` | `src/skills/loader.ts`, `src/tools/builtin/skill-tool.ts` | #17 |
| `tools/tool_filter.py`, `tools/builtin/task_tool.py` | `src/tools/{tool-filter.ts,builtin/task-tool.ts}` | #15 |
| `tools/builtin/{todowrite_tool,devlog_tool}.py` | `src/tools/builtin/{todo-write-tool,dev-log-tool}.ts` | #18 |
| Python tests | `test/**/*.test.ts` plus shared fixture data | #19 |
| package `__init__.py` modules | `src/index.ts` and explicit subpath exports | #4, #19 |

## 5. Capability parity matrix

The matrix is deliberately tied to Python's V1.0.0 release documentation.
`Target` means the TypeScript behaviour is specified here; it does not claim
that the implementation already exists.

| # | Python V1.0.0 capability | Authoritative Python evidence | TS target | Verification |
| --- | --- | --- | --- | --- |
| 1 | Structured `ToolResponse` protocol | `tools/response.py`, `tests/test_tool_response_protocol.py` | #6 | Serialization and error-code contract tests. |
| 2 | Context engineering | `context/*`, `tests/test_context_engineering.py` | #7 | Token, round-boundary, compression and truncation tests. |
| 3 | Trace observability | `observability/trace_logger.py`, `tests/test_observability.py` | #14 | JSONL/HTML snapshot and sanitization tests. |
| 4 | Circuit breaker | `tools/circuit_breaker.py`, `tests/test_circuit_breaker.py` | #5 | Deterministic state-machine tests with an injected clock. |
| 5 | Session persistence | `core/session_store.py`, `tests/test_session_persistence.py` | #11 | Save/load/list/delete and consistency round trips. |
| 6 | Sub-agent execution | `core/agent.py`, `tools/builtin/task_tool.py`, `tests/test_subagent_mechanism.py` | #15 | Isolation, tool filtering, restoration and cancellation tests. |
| 7 | Optimistic file locking | `tools/builtin/file_tools.py`, `tests/test_file_tools.py` | #12 | Read/edit conflict and atomic write tests. |
| 8 | Skills externalisation | `skills/loader.py`, `tools/builtin/skill_tool.py`, `tests/test_skills.py` | #17 | Scan, load, reload and invalid-frontmatter tests. |
| 9 | Todo progress tracking | `tools/builtin/todowrite_tool.py`, `tests/test_todowrite.py` | #18 | State transition and persistence tests. |
| 10 | Development log | `tools/builtin/devlog_tool.py`, `tests/test_devlog_tool.py` | #18 | Category/filter/persistence tests. |
| 11 | Async lifecycle and parallel tools | `core/lifecycle.py`, `tests/test_async_lifecycle.py` | #9 | Hook, ordering, cancellation and bounded-concurrency tests. |
| 12 | Streaming/SSE | `core/streaming.py`, `tests/test_llm_streaming.py` | #9 | AsyncIterable, SSE and JSONL conformance tests. |
| 13 | Function Calling architecture | `core/llm.py`, `llm_adapters.py`, `tests/test_llm_function_calling.py` | #2, #16 | Provider adapter and tool-history fixtures. |
| 14 | Layered logging | Trace docs and `TraceLogger`; Python standard logging is internal | #14 | Trace-output tests; do not expose an unnecessary logger abstraction. |
| 15 | Custom/expandable tools | `tools/base.py`, `tests/test_custom_tools.py` | #6 | Zod/schema/action expansion tests. |
| 16 | Four Agent paradigms | `agents/*`, `tests/test_all_agents.py` | #8, #10, #13 | Mock-adapter scenarios for Simple, ReAct, Reflection and Plan/Solve. |

## 6. Provider and wire compatibility

Python V1.0.0 selects an adapter from `base_url` and normalizes OpenAI,
Anthropic, and Gemini responses.  TypeScript must preserve that architecture:

1. OpenAI-compatible is the default adapter, including compatible providers.
2. Anthropic conversion separates system prompt from user/assistant messages,
   converts tools/tool choices, and turns provider tool uses into `ToolCall`.
3. Gemini conversion maps system instructions, content history, function
   declarations, tool results, and function calls into the same normalized
   response.
4. Provider SDK/raw JSON is untrusted.  Parse it at the adapter boundary with
   a Zod schema and report a normalized `LLMError` with provider context.
5. The normalized tool-call `arguments` field remains a JSON string because
   that is the Python contract.  Tool execution is responsible for parsing it
   and reporting an `INVALID_FORMAT`/tool error back to the model when needed.

## 7. Python/Go differences and decisions

The following known differences are resolved now, rather than by whichever
implementation happens to be read first during a later Issue.

| Topic | Python V1 authority | Go reference difference | TypeScript decision |
| --- | --- | --- | --- |
| Base agent execution | `Agent` is abstract; concrete agents implement `run`, and `arun` provides lifecycle-aware async execution. | `BaseAgent.Run` explicitly returns “not implemented”; its own comment identifies it as a scaffold counterpart. | Implement the Python abstract/concrete-agent model; do not model the Go base-agent stub as public behaviour. |
| Lifecycle hooks | Async hooks, timeouts, cancellation, multiple event types, and async streams are part of Python V1 tests. | `LifecycleHook` is explicitly “simple for scaffold stage” and returns only `error`. | Use the Python lifecycle contract from #9, with Promise-based hooks and `AsyncIterable` streaming. |
| Tool representation | `Tool` defines structured parameters and `ToolResponse`; the registry accepts JSON strings or objects and wraps functions. | Go can use static Go types and interfaces directly. | Zod object schema is the TypeScript boundary and projects to provider JSON Schema; preserve Python `ToolResponse` and JSON-string tool-call semantics. |
| Concurrency/cancellation | Python exposes synchronous APIs alongside executor-backed async APIs. | Go uses channels and `context.Context`. | Promise/`AsyncIterable` plus `AbortSignal` replace both language-specific mechanisms; no blocking TypeScript API is added. |

Any new conflict must be added to this table in the same PR that introduces
the affected behaviour.  A Go implementation detail cannot expand or narrow
the Python V1 contract without an explicit TypeScript design decision.

## 8. Behavioural invariants

These invariants are review gates for all later implementation PRs:

- A tool error is model-readable `ToolResponse` data, not an uncaught process
  error. Only invalid framework configuration/provider failures throw a typed
  framework error.
- A tool invocation appends `time_ms`, `params_input`, and `tool_name` to the
  response metadata, including the converted unhandled-error case.
- User tools may run in bounded parallelism; ReAct's built-in `Thought` and
  `Finish` tools remain ordered and `Finish` ends the loop.
- Tool results are written back using the original provider `tool_call_id` and
  retain provider call order even when execution is parallel.
- History/session/trace payloads are validated before use; session writes are
  atomic and recovery warns on configuration or tool-schema mismatch.
- `AbortSignal` cancellation reaches LLM calls, user tools, streams, and child
  agents without leaving unhandled promises.
- Stream events carry a timestamp, agent name, type and data.  Their wire
  representation retains Python snake_case fields.
- File operations are restricted to their configured workspace and reject an
  optimistic-lock conflict rather than overwriting an externally changed file.
- A child agent cannot observe or retain its parent's temporary history; all
  temporarily filtered tools and overridden step limits are restored on every
  exit path.

## 9. Explicit first-release exclusions

The following V0.x modules were removed from Python V1.0.0 and are **not**
part of TypeScript 1.0 parity:

- legacy Memory and RAG implementations;
- reinforcement-learning trainers/datasets/rewards;
- evaluation benchmarks (GAIA, BFCL, LLM judge and win-rate tooling);
- MCP, A2A and ANP protocol packages;
- the pre-1.0 regex/text tool-call agents (`FunctionCallAgent` and
  `ToolAwareSimpleAgent`); and
- legacy search, terminal, note, protocol and evaluation built-ins that are not
  present in Python V1.0.0 `main`.

These can be proposed later as separately versioned extensions.  They must not
expand a parity Issue by implication.

## 10. Review and acceptance checklist

Issue #3 is complete only when all of the following are true:

- [x] Python `main`, V1.0.0 release and Go reference have an explicit priority
  order and pinned source revisions.
- [x] Public exports, constructor inputs, output fields, error categories and
  async mapping are documented.
- [x] Every Python V1.0.0 module maps to an owning TypeScript module/Issue.
- [x] All 16 release capabilities have a target and a concrete verification
  approach.
- [x] The Bun/Node compatibility matrix, isolated Bun API rule and
  Zod/type/JSON-Schema/serialized-field mapping are explicit.
- [x] Known Python/Go behavioural differences have a recorded decision.
- [x] Naming, serialization, JSON Schema, Zod validation, Bun/Node runtime and
  cancellation rules are explicit.
- [x] Known Python/Go divergence is documented and Python remains the semantic
  authority.
- [x] Removed V0.x functionality is excluded from the first-release scope.

Future PRs must link the applicable matrix row(s) and state whether their test
coverage satisfies the listed verification method.
