import type { HelloAgentsLLM } from '../core/llm.js';
import { PlanSolveAgent } from './plan-solve-agent.js';
import { ReActAgent } from './react-agent.js';
import { ReflectionAgent } from './reflection-agent.js';
import { SimpleAgent } from './simple-agent.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolFilter } from '../tools/tool-filter.js';

export interface SubagentRunOptions {
  readonly toolFilter?: ToolFilter;
  readonly maxSteps?: number;
}

export interface SubagentMetadata {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms: number;
  readonly tools_used: readonly string[];
  readonly error?: string;
}

export interface SubagentResult {
  readonly success: boolean;
  readonly summary: string;
  readonly metadata: SubagentMetadata;
}

export interface SubagentRunner {
  runAsSubagent(task: string, options: SubagentRunOptions): Promise<SubagentResult>;
}

export type AgentType = 'react' | 'reflection' | 'plan' | 'simple';
export type AgentFactory = (agentType: string) => Promise<SubagentRunner> | SubagentRunner;

export interface AgentFactoryOptions {
  readonly llm: HelloAgentsLLM;
  readonly toolRegistry: ToolRegistry;
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
  public get agentType(): AgentType {
    return this.type;
  }
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
