import type { HelloAgentsLLM } from '../core/llm.js';
import type { ResolvedConfig } from '../core/config.js';
import { PlanSolveAgent } from './plan-solve-agent.js';
import { ReActAgent } from './react-agent.js';
import { ReflectionAgent } from './reflection-agent.js';
import { SimpleAgent } from './simple-agent.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolFilter } from '../tools/tool-filter.js';

export interface CreateAgentOptions {
  /** Agent 类型，支持 react、reflection、plan、simple，不区分大小写。 */
  readonly agentType: string;
  /** 创建的 Agent 名称。 */
  readonly name: string;
  /** 创建的 Agent 使用的 LLM 客户端。 */
  readonly llm: HelloAgentsLLM;
  /** 传递给创建的 Agent 的可选工具注册表。 */
  readonly toolRegistry?: ToolRegistry;
  /** Agent 使用的技能发现配置。 */
  readonly config?: Pick<ResolvedConfig, 'skillsEnabled' | 'skillsDir' | 'skillsAutoRegister'>;
  /** 传递给创建的 Agent 的可选系统提示词。 */
  readonly systemPrompt?: string;
}

/** 四种公共 Agent 实现的联合类型。 */
export type CreatedAgent = SimpleAgent | ReActAgent | ReflectionAgent | PlanSolveAgent;

/** 根据类型名称创建四种公共 Agent 范式之一。 */
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
  /** 克隆父注册表时应用的可选允许/拒绝过滤器。 */
  readonly toolFilter?: ToolFilter;
  /** 当前运行覆盖的子代理最大工具迭代次数。 */
  readonly maxSteps?: number;
}

/** 委托任务返回的使用情况和失败详情。 */
export interface SubagentMetadata {
  readonly steps: number;
  readonly tokens: number;
  readonly duration_ms: number;
  readonly tools_used: readonly string[];
  readonly error?: string;
}

/** 子代理运行器返回的标准化结果。 */
export interface SubagentResult {
  readonly success: boolean;
  readonly summary: string;
  readonly metadata: SubagentMetadata;
}

/** `TaskTool` 执行委托任务时使用的协议。 */
export interface SubagentRunner {
  /** 在隔离的子 Agent 中运行任务。 */
  runAsSubagent(task: string, options: SubagentRunOptions): Promise<SubagentResult>;
}

/** 支持的子 Agent 类型名称。 */
export type AgentType = 'react' | 'reflection' | 'plan' | 'simple';
/** 根据请求的类型创建隔离运行器。 */
export type AgentFactory = (agentType: string) => Promise<SubagentRunner> | SubagentRunner;

export interface AgentFactoryOptions {
  /** 所有生成的子 Agent 使用的 LLM 客户端。 */
  readonly llm: HelloAgentsLLM;
  /** 复制到隔离子注册表的父注册表。 */
  readonly toolRegistry: ToolRegistry;
  /** 生成的子 Agent 默认最大工具迭代次数。 */
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
  /** 当前子代理运行器使用的 Agent 类型。 */
  public get agentType(): AgentType {
    return this.type;
  }
  /** 使用过滤后的注册表运行子 Agent，不修改父 Agent 状态。 */
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

/** 创建隔离的子 Agent；不会修改父注册表。 */
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

/** TaskTool 默认使用的隔离子 Agent 工厂。 */
export function defaultSubagentFactory(options: AgentFactoryOptions): AgentFactory {
  return createAgentFactory(options);
}
