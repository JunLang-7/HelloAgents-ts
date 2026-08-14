import { z } from 'zod';

import { ToolError } from '../core/errors.js';
import { ToolErrorCode } from './errors.js';
import { ToolResponse } from './response.js';

/** 校验为 Python 协议兼容而保留的旧版参数元数据。 */
export const toolParameterSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    description: z.string(),
    required: z.boolean().default(true),
    default: z.unknown().optional()
  })
  .strict();
/** 旧版参数元数据；实际执行校验由 `inputSchema` 定义。 */
export type ToolParameter = z.output<typeof toolParameterSchema>;

/** 注册工具输出的 OpenAI Function Calling 模式。 */
export interface OpenAIToolSchema {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ToolOptions<TSchema extends z.ZodType> {
  /** 暴露给模型的唯一函数调用名称。 */
  readonly name: string;
  /** 面向模型说明何时调用此工具。 */
  readonly description: string;
  /** 用于校验执行输入并生成 JSON Schema 的 Zod 模式。 */
  readonly inputSchema: TSchema;
  /** 仅用于兼容的元数据；Zod 仍是执行模式的权威来源。 */
  readonly parameters?: readonly ToolParameter[];
  /** Zod 无法表示为 JSON Schema 时使用的显式兼容出口。 */
  readonly jsonSchema?: Record<string, unknown>;
}

/** 注册时可展开为多个具体工具的命名工具组。 */
export interface ExpandableTool {
  readonly name: string;
  readonly description: string;
  readonly expandable: true;
  /** 返回此工具组暴露的具体工具。 */
  getExpandedTools(): readonly Tool[];
}

function schemaHasUnsupportedNode(schema: z.ZodType): boolean {
  const seen = new WeakSet<object>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if ('type' in value && typeof value.type === 'string') {
      if (['date', 'map', 'set', 'transform'].includes(value.type)) return true;
    }
    return Object.values(value).some(visit);
  };
  return visit(schema._zod.def);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 工具基类 - 新协议版本。
 *
 * 支持两种使用模式：
 * 1. 普通模式：工具作为单一实体使用
 * 2. 可展开模式：工具可以展开为多个独立的子工具
 *
 * 新协议特性：
 * - `run()` 返回 ToolResponse 对象，而不是字符串
 * - `execute()` 自动添加时间统计
 * - 支持结构化的状态、数据和错误信息
 *
 * `execute` 是 Python `run_with_timing` 的 TypeScript 对应实现，包含异常包装和协议上下文。
 */
export abstract class Tool<TSchema extends z.ZodType = z.ZodType> {
  public readonly name: string;
  public readonly description: string;
  public readonly inputSchema: TSchema;
  public readonly parameters: readonly ToolParameter[];
  public readonly expandable = false;
  private readonly jsonSchema: Record<string, unknown> | undefined;

  protected constructor(options: ToolOptions<TSchema>) {
    this.name = options.name;
    this.description = options.description;
    this.inputSchema = options.inputSchema;
    this.parameters = (options.parameters ?? []).map((parameter) =>
      toolParameterSchema.parse(parameter)
    );
    this.jsonSchema = options.jsonSchema;
  }

  protected abstract run(input: z.output<TSchema>): ToolResponse | Promise<ToolResponse>;

  protected unhandledErrorCode(): string {
    return ToolErrorCode.INTERNAL_ERROR;
  }

  protected unhandledErrorMessage(error: unknown): string {
    return `工具执行时发生未处理的异常: ${error instanceof Error ? error.message : String(error)}`;
  }

  /**
   * 校验输入、执行工具，并将异常标准化为协议响应。
   *
   * @param input 工具参数。
   * @param invocationContext 调用上下文，会写入响应 context。
   * @returns 标准化的工具响应对象。
   */
  public async execute(
    input: unknown,
    invocationContext: Record<string, unknown> = {}
  ): Promise<ToolResponse> {
    const parsed = this.inputSchema.safeParse(input);
    if (!parsed.success) {
      return ToolResponse.error(
        ToolErrorCode.INVALID_PARAM,
        `工具 '${this.name}' 参数无效: ${parsed.error.issues.map((issue) => issue.path.join('.') || '<root>').join(', ')}`,
        undefined,
        { ...invocationContext, params_input: input, tool_name: this.name }
      );
    }

    const start = performance.now();
    try {
      const response = await this.run(parsed.data);
      return this.withTiming(response, input, start, invocationContext);
    } catch (error) {
      return ToolResponse.error(
        this.unhandledErrorCode(),
        this.unhandledErrorMessage(error),
        { time_ms: Math.trunc(performance.now() - start) },
        { ...invocationContext, params_input: input, tool_name: this.name }
      );
    }
  }

  /** `execute` 的异步兼容别名。 */
  public async arun(
    input: unknown,
    invocationContext?: Record<string, unknown>
  ): Promise<ToolResponse> {
    return this.execute(input, invocationContext);
  }

  /**
   * 将 Zod 输入契约转换为 OpenAI Function Calling 模式。
   *
   * @returns OpenAI 函数调用模式。
   * @throws ToolError 当输入模式无法表示为 JSON Schema 时抛出。
   */
  public toOpenAISchema(): OpenAIToolSchema {
    const parameters = this.jsonSchema ?? this.jsonSchemaFromZod();
    if (parameters.type !== 'object') {
      throw new ToolError(`Tool '${this.name}' input schema must produce a JSON Schema object`);
    }
    return {
      type: 'function',
      function: { name: this.name, description: this.description, parameters }
    };
  }

  private jsonSchemaFromZod(): Record<string, unknown> {
    if (schemaHasUnsupportedNode(this.inputSchema)) {
      throw new ToolError(
        `Tool '${this.name}' contains a Zod type that cannot be losslessly represented as JSON Schema; provide jsonSchema explicitly`
      );
    }
    try {
      const result = z.toJSONSchema(this.inputSchema);
      if (!isRecord(result))
        throw new ToolError(`Tool '${this.name}' produced an invalid JSON Schema`);
      return result;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`Tool '${this.name}' schema cannot be converted to JSON Schema`, error);
    }
  }

  private withTiming(
    response: ToolResponse,
    input: unknown,
    start: number,
    invocationContext: Record<string, unknown>
  ): ToolResponse {
    return ToolResponse.fromObject({
      ...response.toJSON(),
      stats: { ...(response.stats ?? {}), time_ms: Math.trunc(performance.now() - start) },
      context: {
        ...invocationContext,
        ...(response.context ?? {}),
        params_input: input,
        tool_name: this.name
      }
    });
  }
}

export interface FunctionToolOptions<TSchema extends z.ZodType> extends ToolOptions<TSchema> {
  /** 输入校验后调用的函数；其返回值会成为响应文本。 */
  readonly handler: (input: z.output<TSchema>) => unknown | Promise<unknown>;
}

/** 使用标准 Tool 协议包装普通函数。 */
export class FunctionTool<TSchema extends z.ZodType = z.ZodType> extends Tool<TSchema> {
  private readonly handler: (input: z.output<TSchema>) => unknown | Promise<unknown>;

  public constructor(options: FunctionToolOptions<TSchema>) {
    super(options);
    this.handler = options.handler;
  }

  protected override async run(input: z.output<TSchema>): Promise<ToolResponse> {
    const output = await this.handler(input);
    return ToolResponse.success(String(output), { output });
  }

  protected override unhandledErrorCode(): string {
    return ToolErrorCode.EXECUTION_ERROR;
  }

  protected override unhandledErrorMessage(error: unknown): string {
    return `函数执行失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** 创建可在可展开工具组中组合的命名工具 action。 */
export function toolAction<TSchema extends z.ZodType>(
  options: FunctionToolOptions<TSchema>
): FunctionTool<TSchema> {
  return new FunctionTool(options);
}

class ToolGroup implements ExpandableTool {
  public readonly expandable = true as const;

  public constructor(
    public readonly name: string,
    public readonly description: string,
    private readonly tools: readonly Tool[]
  ) {}

  public getExpandedTools(): readonly Tool[] {
    return this.tools;
  }
}

export function expandableTool(options: {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly Tool[];
}): ExpandableTool {
  return new ToolGroup(options.name, options.description, options.tools);
}
