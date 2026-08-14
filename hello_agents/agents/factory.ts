import type { HelloAgentsLLM } from '../core/llm.js';
import type { ResolvedConfig } from '../core/config.js';
import { PlanSolveAgent } from './plan-solve-agent.js';
import { ReActAgent } from './react-agent.js';
import { ReflectionAgent } from './reflection-agent.js';
import { SimpleAgent } from './simple-agent.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolFilter } from '../tools/tool-filter.js';

export interface CreateAgentOptions {
  /** Case-insensitive agent strategy: react, reflection, plan, or simple. */
  readonly agentType: string;
  /** Stable name assigned to the created agent. */
  readonly name: string;
  /** LLM client shared with the created agent. */
  readonly llm: HelloAgentsLLM;
  /** Optional tool registry passed to the created agent. */
  readonly toolRegistry?: ToolRegistry;
  /** Skill-discovery settings supported by agent types that extend `Agent`. */
  readonly config?: Pick<ResolvedConfig, 'skillsEnabled' | 'skillsDir' | 'skillsAutoRegister'>;
  /** Optional system instruction passed to the created agent. */
  readonly systemPrompt?: string;
}

/** Union of the four concrete public agent classes. */
export type CreatedAgent = SimpleAgent | ReActAgent | ReflectionAgent | PlanSolveAgent;

/** Creates one of the four public agent paradigms by its contract name. */
export function createAgent(
  agentType: string,
  name: string,
  llm: HelloAgentsLLM,
  toolRegistry?: ToolRegistry,
  config?: CreateAgentOptions['config'],
  systemPrompt?: string
): CreatedAgent;
export function createAgent(options: CreateAgentOptions): CreatedAgent;
export function createAgent(
  input: string | CreateAgentOptions,
  name?: string,
  llm?: HelloAgentsLLM,
  toolRegistry?: ToolRegistry,
  config?: CreateAgentOptions['config'],
  systemPrompt?: string
): CreatedAgent {
  const options: CreateAgentOptions =
    typeof input === 'string'
      ? {
          agentType: input,
          name: name ?? `${input}-agent`,
          llm: llm as HelloAgentsLLM,
          ...(toolRegistry === undefined ? {} : { toolRegistry }),
          ...(config === undefined ? {} : { config }),
          ...(systemPrompt === undefined ? {} : { systemPrompt })
        }
      : input;
  const type = options.agentType.toLowerCase();
  const shared = {
    name: options.name,
    llm: options.llm,
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry })
  };
  switch (type) {
    case 'react':
      return new ReActAgent(shared);
    case 'reflection':
      return new ReflectionAgent(shared);
    case 'plan':
      return new PlanSolveAgent(shared);
    case 'simple':
      return new SimpleAgent(shared);
    default:
      throw new Error(
        `不支持的 agent_type: ${options.agentType}。支持的类型: react, reflection, plan, simple`
      );
  }
}

export interface SubagentRunOptions {
  /** Optional allow/deny filter applied while cloning the parent registry. */
  readonly toolFilter?: ToolFilter;
  /** Per-run override for the child's maximum tool iterations. */
  readonly maxSteps?: number;
}

/** Usage and failure details returned from a delegated task. */
export interface SubagentMetadata {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms: number;
  readonly tools_used: readonly string[];
  readonly error?: string;
}

/** Normalized result returned by a subagent runner. */
export interface SubagentResult {
  readonly success: boolean;
  readonly summary: string;
  readonly metadata: SubagentMetadata;
}

/** Contract used by `TaskTool` to execute delegated work. */
export interface SubagentRunner {
  /** Runs a task in an isolated child agent. */
  runAsSubagent(task: string, options: SubagentRunOptions): Promise<SubagentResult>;
}

/** Supported child-agent strategy names. */
export type AgentType = 'react' | 'reflection' | 'plan' | 'simple';
/** Produces an isolated runner for a requested strategy. */
export type AgentFactory = (agentType: string) => Promise<SubagentRunner> | SubagentRunner;

export interface AgentFactoryOptions {
  /** LLM client used by all generated child agents. */
  readonly llm: HelloAgentsLLM;
  /** Parent registry copied into isolated child registries. */
  readonly toolRegistry: ToolRegistry;
  /** Default maximum tool iterations for generated child agents. */
  readonly maxToolIterations?: number;
}

class TrackingRegistry extends ToolRegistry {
  public readonly toolsUsed = new Set<string>();
  public override async execute(name: string, input: unknown) {
    this.toolsUsed.add(name);
    return super.execute(name, input);
  }
}

function cloneFilteredRegistry(
  source: ToolRegistry,
  filter: ToolFilter | undefined
): TrackingRegistry {
  const registry = new TrackingRegistry();
  const names = filter?.filter(source.list()) ?? source.list();
  for (const name of names) {
    const tool = source.get(name);
    if (tool) registry.register(tool);
  }
  return registry;
}

type RunnableAgent = { run(task: string): Promise<string> };

export class IsolatedSubagent implements SubagentRunner {
  public constructor(
    private readonly options: AgentFactoryOptions,
    private readonly type: AgentType
  ) {}
  /** Strategy used by this child runner. */
  public get agentType(): AgentType {
    return this.type;
  }
  /** Runs a child with a filtered registry without mutating parent agent state. */
  public async runAsSubagent(task: string, options: SubagentRunOptions): Promise<SubagentResult> {
    const started = performance.now();
    const registry = cloneFilteredRegistry(this.options.toolRegistry, options.toolFilter);
    const maxToolIterations = options.maxSteps ?? this.options.maxToolIterations ?? 3;
    try {
      const agent = this.createAgent(registry, maxToolIterations);
      const summary = await agent.run(task);
      return {
        success: true,
        summary,
        metadata: {
          steps: 0,
          tokens: 0,
          duration_ms: Math.trunc(performance.now() - started),
          tools_used: [...registry.toolsUsed]
        }
      };
    } catch (error) {
      return {
        success: false,
        summary: error instanceof Error ? error.message : String(error),
        metadata: {
          steps: 0,
          tokens: 0,
          duration_ms: Math.trunc(performance.now() - started),
          tools_used: [...registry.toolsUsed],
          error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private createAgent(registry: TrackingRegistry, maxSteps: number): RunnableAgent {
    const shared = { name: `subagent-${this.type}`, llm: this.options.llm, toolRegistry: registry };
    switch (this.type) {
      case 'react':
        return new ReActAgent({ ...shared, maxSteps });
      case 'reflection':
        return new ReflectionAgent({ ...shared, maxToolIterations: maxSteps });
      case 'plan':
        return new PlanSolveAgent({ ...shared, maxToolIterations: maxSteps });
      case 'simple':
        return new SimpleAgent({ ...shared, maxToolIterations: maxSteps });
    }
  }
}

/** Creates isolated child agents; the parent registry is never mutated. */
export function createAgentFactory(options: AgentFactoryOptions): AgentFactory {
  return (requestedType: string) => {
    const type = requestedType.toLowerCase();
    if (!['react', 'reflection', 'plan', 'simple'].includes(type)) {
      throw new Error(
        `不支持的 agent_type: ${requestedType}。支持的类型: react, reflection, plan, simple`
      );
    }
    // The shared subagent protocol is intentionally independent of parent history.
    return new IsolatedSubagent(options, type as AgentType);
  };
}

/** Default factory used by TaskTool when a caller wants isolated child agents. */
export function defaultSubagentFactory(options: AgentFactoryOptions): AgentFactory {
  return createAgentFactory(options);
}
