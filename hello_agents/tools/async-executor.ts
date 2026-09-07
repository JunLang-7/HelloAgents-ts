import type { ToolRegistry } from './registry.js';

export interface ToolTask {
  readonly tool_name: string;
  readonly input_data?: string;
  readonly [key: string]: unknown;
}

export interface ToolTaskResult {
  readonly task_id: number;
  readonly tool_name: string;
  readonly input_data: string;
  readonly result: string;
  readonly status: 'success' | 'error';
}

/** 使用受限并发执行注册表中的工具。 */
export class AsyncToolExecutor {
  private closed = false;
  private readonly maxWorkers: number;

  public constructor(
    public readonly registry: ToolRegistry,
    maxWorkers = 4
  ) {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
      throw new RangeError('maxWorkers must be a positive integer');
    }
    this.maxWorkers = maxWorkers;
  }

  public async executeToolAsync(toolName: string, inputData: string): Promise<string> {
    if (this.closed) return `❌ 工具 '${toolName}' 异步执行失败: 执行器已关闭`;
    try {
      return (await this.registry.executeTool(toolName, inputData)).text;
    } catch (error) {
      return `❌ 工具 '${toolName}' 异步执行失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  public async executeToolsParallel(tasks: readonly ToolTask[]): Promise<ToolTaskResult[]> {
    const results: ToolTaskResult[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < tasks.length) {
        const index = cursor++;
        const task = tasks[index];
        if (!task?.tool_name) continue;
        const inputData = task.input_data ?? '';
        try {
          const result = await this.executeToolAsync(task.tool_name, inputData);
          results.push({
            task_id: index,
            tool_name: task.tool_name,
            input_data: inputData,
            result,
            status: 'success'
          });
        } catch (error) {
          results.push({
            task_id: index,
            tool_name: task.tool_name,
            input_data: inputData,
            result: error instanceof Error ? error.message : String(error),
            status: 'error'
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.maxWorkers, Math.max(tasks.length, 1)) }, () => worker())
    );
    return results.sort((left, right) => left.task_id - right.task_id);
  }

  public executeToolsBatch(
    toolName: string,
    inputList: readonly string[]
  ): Promise<ToolTaskResult[]> {
    return this.executeToolsParallel(
      inputList.map((inputData) => ({ tool_name: toolName, input_data: inputData }))
    );
  }

  public close(): void {
    this.closed = true;
  }

  public [Symbol.dispose](): void {
    this.close();
  }
}

export function runParallelTools(
  registry: ToolRegistry,
  tasks: readonly ToolTask[],
  maxWorkers = 4
): Promise<ToolTaskResult[]> {
  const executor = new AsyncToolExecutor(registry, maxWorkers);
  return executor.executeToolsParallel(tasks).finally(() => executor.close());
}

export function runBatchTool(
  registry: ToolRegistry,
  toolName: string,
  inputList: readonly string[],
  maxWorkers = 4
): Promise<ToolTaskResult[]> {
  const executor = new AsyncToolExecutor(registry, maxWorkers);
  return executor.executeToolsBatch(toolName, inputList).finally(() => executor.close());
}

/** Python `_sync` 名称的 Promise 适配；TypeScript 不阻塞事件循环。 */
export const runParallelToolsSync = runParallelTools;
export const runBatchToolSync = runBatchTool;
