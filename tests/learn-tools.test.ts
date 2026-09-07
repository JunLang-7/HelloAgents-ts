import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { z } from 'zod';

import toolsFixture from './fixtures/learn-v0.2.0-tools.json' with { type: 'json' };

import {
  AsyncToolExecutor,
  CalculatorTool,
  demo_parallel_execution,
  SearchTool,
  TerminalTool,
  Tool,
  ToolErrorCode,
  ToolRegistry,
  ToolResponse,
  calculate,
  toolAction
} from '../hello_agents/index.js';

class DecoratedTool extends Tool<typeof DecoratedTool.inputSchema> {
  public static readonly inputSchema = z.object({ input: z.string() }).strict();
  public constructor() {
    super({
      name: 'decorated',
      description: 'Decorated group.',
      inputSchema: DecoratedTool.inputSchema,
      expandable: true
    });
  }
  protected run(): ToolResponse {
    return ToolResponse.success('unused');
  }
  public readonly prefix = 'bound:';
  public action(input: { value: string }): string {
    return `${this.prefix}${input.value}`;
  }
}
toolAction('decorated_action', 'Uses the parent receiver.')(DecoratedTool.prototype.action);

function response(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

describe('learn-version tools', () => {
  test('discovers decorated subclass actions, reads metadata, and binds the parent receiver', async () => {
    const registry = new ToolRegistry().register(new DecoratedTool());
    expect(registry.list()).toEqual(['decorated_action']);
    expect(registry.get('decorated_action')?.description).toBe('Uses the parent receiver.');
    expect((await registry.execute('decorated_action', { value: 'ok' })).text).toBe('bound:ok');
  });

  test('keeps calculator direct helper string-oriented and serializes explicit null parameter defaults', async () => {
    expect(await calculate(toolsFixture.calculator.expression)).toBe(
      toolsFixture.calculator.result
    );
    expect((await new CalculatorTool().execute({ input: '2 + 2' })).text).toBe('4');
    expect((await new CalculatorTool().execute({ input: 'bad()' })).errorInfo?.code).toBe(
      ToolErrorCode.EXECUTION_ERROR
    );
    const tool = new (class extends Tool<ReturnType<typeof z.object>> {
      // type is only used to exercise toDict.
      public constructor() {
        super({
          name: 'metadata',
          description: 'Metadata.',
          inputSchema: z.object({}).strict(),
          parameters: [
            { name: 'optional', type: 'string', description: 'Optional.', required: false }
          ]
        });
      }
      protected run(): ToolResponse {
        return ToolResponse.success('ok');
      }
    })();
    expect(tool.toDict()).toEqual(toolsFixture.tool);
  });

  test('uses injectable opt-in transports for every upstream search backend and surfaces errors', async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.includes('tavily'))
        return response({ results: [{ title: 'T', url: 'https://t.test', content: 't' }] });
      if (url.includes('serpapi'))
        return response({
          organic_results: [{ title: 'S', link: 'https://s.test', snippet: 's' }]
        });
      if (url.includes('duckduckgo'))
        return response({ RelatedTopics: [{ Text: 'D - d', FirstURL: 'https://d.test' }] });
      if (url.includes('searx'))
        return response({ results: [{ title: 'X', url: 'https://x.test', content: 'x' }] });
      return response({ choices: [{ message: { content: 'P' } }], citations: ['https://p.test'] });
    };
    const options = {
      allowNetwork: true,
      fetch,
      tavilyKey: 't',
      serpapiKey: 's',
      perplexityKey: 'p',
      searxngUrl: 'https://searx.test'
    } as const;
    for (const backend of ['tavily', 'serpapi', 'duckduckgo', 'searxng', 'perplexity'] as const) {
      const result = await new SearchTool({ ...options, backend }).execute({
        input: 'query',
        mode: 'structured'
      });
      expect(result.status).toBe('success');
      expect(result.data.backend).toBe(backend);
    }
    expect(calls).toHaveLength(5);
    expect((await new SearchTool().execute({ input: 'offline' })).text).toContain('网络搜索未启用');
    const failed = await new SearchTool({
      backend: 'tavily',
      allowNetwork: true,
      tavilyKey: 'key',
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) })
    }).execute({ input: 'bad' });
    expect(failed.errorInfo?.code).toBe(ToolErrorCode.API_ERROR);
  });

  test('terminal permits only echo and captured-label pwd without process or filesystem access', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'helloagents-learn-tools-'));
    const originalWorkspace = `${workspace}-original`;
    const outside = await mkdtemp(join(tmpdir(), 'helloagents-outside-'));
    const originalPath = process.env.PATH;
    const pathMarker = join(outside, 'path-was-executed');
    try {
      await writeFile(join(outside, 'secret.txt'), 'root-swap-secret', 'utf8');
      await writeFile(
        join(workspace, 'echo'),
        `#!/bin/sh\nprintf exploited > "${pathMarker}"\n`,
        'utf8'
      );
      await chmod(join(workspace, 'echo'), 0o755);
      process.env.PATH = `${workspace}${delimiter}${originalPath ?? ''}`;

      const terminal = new TerminalTool({ workspace });
      expect(TerminalTool.ALLOWED_COMMANDS).toEqual(['echo', 'pwd']);
      expect((await terminal.execute({ command: 'echo safe text' })).text).toBe('safe text\n');
      expect((await terminal.execute({ command: 'pwd' })).text).toBe(`${terminal.workspace}\n`);
      expect(existsSync(pathMarker)).toBe(false);
      for (const command of ['cat secret.txt', 'ls', 'ls .', 'cd .']) {
        expect((await terminal.execute({ command })).errorInfo?.code).toBe(
          ToolErrorCode.ACCESS_DENIED
        );
      }
      expect((await terminal.execute({ command: 'pwd workspace' })).errorInfo?.code).toBe(
        ToolErrorCode.INVALID_PARAM
      );

      await rename(workspace, originalWorkspace);
      await symlink(outside, workspace);
      expect((await terminal.execute({ command: 'pwd' })).text).toBe(`${terminal.workspace}\n`);
      const rootSwapAttempt = await terminal.execute({ command: 'cat secret.txt' });
      expect(rootSwapAttempt.errorInfo?.code).toBe(ToolErrorCode.ACCESS_DENIED);
      expect(rootSwapAttempt.text).not.toContain('root-swap-secret');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(workspace, { recursive: true, force: true });
      await rm(originalWorkspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('demo_parallel_execution is a deterministic Promise-based teaching helper', async () => {
    await expect(demo_parallel_execution()).resolves.toEqual([
      {
        task_id: 0,
        tool_name: 'my_calculator',
        input_data: '2 + 2',
        result: '4',
        status: 'success'
      },
      {
        task_id: 1,
        tool_name: 'my_calculator',
        input_data: '3 * 4',
        result: '12',
        status: 'success'
      },
      {
        task_id: 2,
        tool_name: 'my_calculator',
        input_data: 'sqrt(16)',
        result: '4',
        status: 'success'
      },
      {
        task_id: 3,
        tool_name: 'my_calculator',
        input_data: '10 / 2',
        result: '5',
        status: 'success'
      }
    ]);
  });

  test('parallel and batch records retain failed response status', async () => {
    const executor = new AsyncToolExecutor(new ToolRegistry(), 2);
    expect(
      (await executor.executeToolsParallel([{ tool_name: 'missing', input_data: 'x' }]))[0]
    ).toMatchObject({ status: 'error', result: expect.stringContaining('未找到') });
    expect((await executor.executeToolsBatch('missing', ['x']))[0]?.status).toBe('error');
  });
});
