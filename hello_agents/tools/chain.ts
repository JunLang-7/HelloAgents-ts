import type { ToolRegistry } from './registry.js';

export interface ToolChainStep {
  readonly tool_name: string;
  readonly input_template: string;
  readonly output_key: string;
}

/** 顺序执行工具并将每一步结果写回模板上下文。 */
export class ToolChain {
  public readonly steps: ToolChainStep[] = [];

  public constructor(
    public readonly name: string,
    public readonly description: string
  ) {}

  public addStep(toolName: string, inputTemplate: string, outputKey?: string): this {
    this.steps.push({
      tool_name: toolName,
      input_template: inputTemplate,
      output_key: outputKey ?? `step_${this.steps.length}_result`
    });
    return this;
  }

  public async execute(
    registry: ToolRegistry,
    inputData: string,
    context: Record<string, unknown> = {}
  ): Promise<string> {
    if (this.steps.length === 0) return '❌ 工具链为空，无法执行';
    context.input = inputData;
    let finalResult = inputData;
    for (const step of this.steps) {
      let actualInput: string;
      try {
        actualInput = step.input_template.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
          if (!(key in context)) throw new Error(key);
          return String(context[key]);
        });
      } catch (error) {
        return `❌ 模板变量替换失败: ${error instanceof Error ? error.message : String(error)}`;
      }
      try {
        const response = await registry.executeTool(step.tool_name, actualInput);
        const result = response.text;
        context[step.output_key] = result;
        finalResult = result;
      } catch (error) {
        return `❌ 工具 '${step.tool_name}' 执行失败: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return finalResult;
  }
}

/** 工具链注册与执行管理器。 */
export class ToolChainManager {
  public readonly chains = new Map<string, ToolChain>();

  public constructor(public readonly registry: ToolRegistry) {}

  public registerChain(chain: ToolChain): this {
    this.chains.set(chain.name, chain);
    return this;
  }

  public executeChain(
    chainName: string,
    inputData: string,
    context?: Record<string, unknown>
  ): Promise<string> {
    const chain = this.chains.get(chainName);
    return chain
      ? chain.execute(this.registry, inputData, context)
      : Promise.resolve(`❌ 工具链 '${chainName}' 不存在`);
  }

  public listChains(): string[] {
    return [...this.chains.keys()];
  }

  public getChainInfo(chainName: string):
    | {
        name: string;
        description: string;
        steps: number;
        step_details: ToolChainStep[];
      }
    | undefined {
    const chain = this.chains.get(chainName);
    if (!chain) return undefined;
    return {
      name: chain.name,
      description: chain.description,
      steps: chain.steps.length,
      step_details: chain.steps.map((step) => ({ ...step }))
    };
  }
}

export function createResearchChain(): ToolChain {
  const chain = new ToolChain('research_and_calculate', '搜索信息并进行相关计算');
  chain.addStep('search', '{input}', 'search_result');
  chain.addStep('my_calculator', '2 + 2', 'calc_result');
  return chain;
}

export function createSimpleChain(): ToolChain {
  const chain = new ToolChain('simple_demo', '简单的工具链演示');
  chain.addStep('my_calculator', '{input}', 'result');
  return chain;
}

export const create_research_chain = createResearchChain;
export const create_simple_chain = createSimpleChain;
