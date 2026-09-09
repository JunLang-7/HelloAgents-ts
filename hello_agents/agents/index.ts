/**
 * `@junlang-7/helloagents/agents` — 教学版智能体子包入口。
 *
 * 对齐上游 `hello_agents/agents/__init__.py`：SimpleAgent / FunctionCallAgent /
 * ReActAgent / ReflectionAgent / PlanAndSolveAgent / ToolAwareSimpleAgent。
 * 1.x 的 subagent factory（IsolatedSubagent 等）不属于教学面（#81 入口分离），
 * 不在此导出。
 */
export { SimpleAgent } from './simple-agent.js';
export type {
  AgentInvocationOptions,
  AgentLifecycleOptions,
  ParsedToolCall,
  SimpleAgentOptions
} from './simple-agent.js';
export { FunctionCallAgent } from './function-call-agent.js';
export type { FunctionCallAgentOptions, FunctionCallRunOptions } from './function-call-agent.js';
export { ToolAwareSimpleAgent } from './tool-aware-agent.js';
export type { ToolAwareSimpleAgentOptions, ToolCallInfo } from './tool-aware-agent.js';
export {
  DEFAULT_REACT_PROMPT,
  ReActAgent,
  parseReActAction,
  parseReActActionInput,
  parseReActOutput
} from './react-agent.js';
export type { ReActAgentOptions } from './react-agent.js';
export { DEFAULT_PROMPTS, Memory, ReflectionAgent } from './reflection-agent.js';
export type {
  ReflectionAgentOptions,
  ReflectionPrompts,
  ReflectionRecord
} from './reflection-agent.js';
export {
  DEFAULT_EXECUTOR_PROMPT,
  DEFAULT_PLANNER_PROMPT,
  Executor,
  INVALID_PLAN_ANSWER,
  PlanAndSolveAgent,
  Planner,
  parsePlan
} from './plan-solve-agent.js';
export type {
  ExecutorOptions,
  PlanAndSolveAgentOptions,
  PlannerOptions
} from './plan-solve-agent.js';
