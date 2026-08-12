import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FunctionTool,
  Tool,
  ToolErrorCode,
  ToolRegistry,
  ToolResponse,
  ToolStatus,
  expandableTool,
  toolAction,
  toolParameterSchema
} from '../src/index.js';

class AddTool extends Tool<typeof AddTool.inputSchema> {
  public static readonly inputSchema = z.object({ left: z.number(), right: z.number() }).strict();

  public constructor() {
    super({
      name: 'add',
      description: 'Add two numbers.',
      inputSchema: AddTool.inputSchema
    });
  }

  protected run(input: z.output<typeof AddTool.inputSchema>): ToolResponse {
    const result = input.left + input.right;
    return ToolResponse.success(`Result: ${result}`, { result });
  }
}

class ThrowingTool extends Tool<typeof ThrowingTool.inputSchema> {
  public static readonly inputSchema = z.object({ input: z.string() }).strict();

  public constructor() {
    super({
      name: 'throwing',
      description: 'Always throws.',
      inputSchema: ThrowingTool.inputSchema
    });
  }

  protected run(): ToolResponse {
    throw new Error('boom');
  }
}

describe('ToolResponse', () => {
  test('round-trips the Python V1 protocol without emitting absent optional fields', () => {
    const response = ToolResponse.partial('truncated', { items: [1, 2] });

    expect(response.toJSON()).toEqual({
      status: 'partial',
      text: 'truncated',
      data: { items: [1, 2] }
    });
    expect(ToolResponse.fromJSON(JSON.stringify(response))).toEqual(response);
    expect(ToolResponse.error(ToolErrorCode.NOT_FOUND, 'missing').toJSON()).toEqual({
      status: 'error',
      text: 'missing',
      data: {},
      error: { code: 'NOT_FOUND', message: 'missing' }
    });
    expect(ToolResponse.fromObject({ text: 'legacy default', data: {} }).status).toBe('success');
    expect(ToolStatus.SUCCESS).toBe('success');
  });
});

describe('Tool and ToolRegistry', () => {
  test('validates Zod input, preserves timing/context, and emits OpenAI function schemas', async () => {
    const tool = new AddTool();
    const response = await tool.execute({ left: 2, right: 3 }, { request_id: 'request_1' });

    expect(response.toJSON()).toMatchObject({
      status: 'success',
      text: 'Result: 5',
      data: { result: 5 },
      context: { params_input: { left: 2, right: 3 }, tool_name: 'add', request_id: 'request_1' }
    });
    expect(response.stats?.time_ms).toBeGreaterThanOrEqual(0);
    expect(tool.toOpenAISchema()).toEqual({
      type: 'function',
      function: {
        name: 'add',
        description: 'Add two numbers.',
        parameters: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { left: { type: 'number' }, right: { type: 'number' } },
          required: ['left', 'right'],
          additionalProperties: false
        }
      }
    });

    expect((await tool.execute({ left: 2 })).errorInfo).toMatchObject({
      code: ToolErrorCode.INVALID_PARAM
    });
  });

  test('wraps unhandled tool errors and function errors with Python-compatible error codes', async () => {
    const registry = new ToolRegistry();
    registry.register(new ThrowingTool());
    registry.registerFunction(
      new FunctionTool({
        name: 'bad_function',
        description: 'Throws from a function.',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: () => {
          throw new Error('nope');
        }
      })
    );

    expect((await registry.execute('throwing', { input: 'x' })).errorInfo).toMatchObject({
      code: ToolErrorCode.INTERNAL_ERROR
    });
    expect((await registry.execute('bad_function', { input: 'x' })).errorInfo).toMatchObject({
      code: ToolErrorCode.EXECUTION_ERROR
    });
  });

  test('registers expandable tools, parses JSON input, and retains read metadata cache behavior', async () => {
    const registry = new ToolRegistry();
    const group = expandableTool({
      name: 'memory',
      description: 'Memory operations.',
      tools: [
        toolAction({
          name: 'memory_add',
          description: 'Add memory.',
          inputSchema: z.object({ content: z.string() }).strict(),
          handler: ({ content }) => `stored ${content}`
        })
      ]
    });
    registry.register(group);
    registry.cacheReadMetadata('notes.txt', { file_size_bytes: 10 });

    expect(registry.list()).toEqual(['memory_add']);
    expect(registry.get('memory_add')).toBeInstanceOf(FunctionTool);
    expect(await registry.execute('memory_add', '{"content":"hello"}')).toMatchObject({
      text: 'stored hello',
      data: { output: 'stored hello' }
    });
    expect(registry.getReadMetadata('notes.txt')).toEqual({ file_size_bytes: 10 });
    registry.clearReadCache('notes.txt');
    expect(registry.getReadMetadata('notes.txt')).toBeUndefined();
    expect(
      toolParameterSchema.parse({ name: 'content', type: 'string', description: 'Content.' })
    ).toEqual({
      name: 'content',
      type: 'string',
      description: 'Content.',
      required: true
    });
    expect((await registry.execute('none', {})).errorInfo).toEqual({
      code: ToolErrorCode.NOT_FOUND,
      message: "未找到名为 'none' 的工具"
    });
  });

  test('rejects non-representable Zod schemas at registration unless a JSON Schema override is supplied', () => {
    const nonRepresentable = new FunctionTool({
      name: 'date',
      description: 'Date input.',
      inputSchema: z.object({ when: z.date() }),
      handler: () => 'ok'
    });
    const registry = new ToolRegistry();

    expect(() => registry.registerFunction(nonRepresentable)).toThrow('cannot be losslessly');
    expect(() =>
      registry.registerFunction({
        name: 'date_json',
        description: 'Date represented as a string.',
        inputSchema: z.object({ when: z.date() }),
        jsonSchema: {
          type: 'object',
          properties: { when: { type: 'string', format: 'date-time' } },
          required: ['when']
        },
        handler: () => 'ok'
      })
    ).not.toThrow();
  });
});
