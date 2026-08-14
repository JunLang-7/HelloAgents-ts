import { z } from 'zod';

import { ToolError } from '../core/errors.js';
import { ToolErrorCode } from './errors.js';
import { ToolResponse } from './response.js';

export const toolParameterSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    description: z.string(),
    required: z.boolean().default(true),
    default: z.unknown().optional()
  })
  .strict();
export type ToolParameter = z.output<typeof toolParameterSchema>;

export interface OpenAIToolSchema {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ToolOptions<TSchema extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TSchema;
  /** Compatibility metadata only. Zod remains the execution-schema authority. */
  readonly parameters?: readonly ToolParameter[];
  /** Explicit compatibility escape hatch for schemas Zod cannot represent in JSON Schema. */
  readonly jsonSchema?: Record<string, unknown>;
}

export interface ExpandableTool {
  readonly name: string;
  readonly description: string;
  readonly expandable: true;
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
 * Zod-validated tool base class. `execute` is the TypeScript equivalent of
 * Python's `run_with_timing`, including exception wrapping and protocol context.
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

  public async arun(
    input: unknown,
    invocationContext?: Record<string, unknown>
  ): Promise<ToolResponse> {
    return this.execute(input, invocationContext);
  }

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
  readonly handler: (input: z.output<TSchema>) => unknown | Promise<unknown>;
}

/** Wraps a regular function with the Tool protocol. */
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

/** Create a named tool action for composition in an expandable tool group. */
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
