import { z } from 'zod';

import type { AgentFactory, SubagentRunner } from '../../agents/factory.js';
import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { FullAccessFilter, ReadOnlyFilter } from '../tool-filter.js';
import type { ToolFilter } from '../tool-filter.js';
import { Tool } from '../tool.js';

export interface TaskToolOptions {
  /** 创建隔离子 Agent 运行器的工厂函数。 */
  readonly agentFactory: AgentFactory;
}

function filterFrom(value: string): ToolFilter | undefined {
  if (value === 'readonly') return new ReadOnlyFilter();
  if (value === 'full') return new FullAccessFilter();
  return undefined;
}

/** 使用隔离工具注册表和有界执行启动子 Agent。 */
export class TaskTool extends Tool<typeof TaskTool.inputSchema> {
  static readonly inputSchema = z
    .object({
      task: z.string().min(1),
      agent_type: z.string().optional(),
      tool_filter: z.enum(['readonly', 'full', 'none']).optional(),
      max_steps: z.number().int().nonnegative().optional()
    })
    .strict();
  private readonly agentFactory: AgentFactory;
  public constructor(options: TaskToolOptions) {
    super({
      name: 'Task',
      description: '启动子代理处理特定的子任务，使用隔离的上下文和最小权限工具访问。',
      inputSchema: TaskTool.inputSchema
    });
    this.agentFactory = options.agentFactory;
  }
  protected override async run(
    input: z.output<typeof TaskTool.inputSchema>
  ): Promise<ToolResponse> {
    const started = performance.now();
    const agentType = input.agent_type ?? 'react';
    const filterType = input.tool_filter ?? 'none';
    let runner: SubagentRunner;
    try {
      runner = await this.agentFactory(agentType);
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.INVALID_PARAM,
        `不支持的 agent_type: ${agentType}。${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      const filter = filterFrom(filterType);
      const result = await runner.runAsSubagent(input.task, {
        ...(input.max_steps === undefined ? {} : { maxSteps: input.max_steps }),
        ...(filter === undefined ? {} : { toolFilter: filter })
      });
      const data = { agent_type: agentType, task: input.task, ...result.metadata };
      const text = `[SubAgent-${agentType}] ${result.success ? '任务完成' : '任务未完全完成'}\n\n${result.summary}`;
      return result.success
        ? ToolResponse.success(text, data, { time_ms: Math.trunc(performance.now() - started) })
        : ToolResponse.partial(text, data, { time_ms: Math.trunc(performance.now() - started) });
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCode.EXECUTION_ERROR,
        `子代理执行失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
