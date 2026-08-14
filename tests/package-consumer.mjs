import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'helloagents-package-'));
const packageName = '@junlang-7/helloagents';
const expectedVersion = '0.0.0-development';
const importCheck = `import { AgentEvent, DevLogTool, FunctionTool, HelloAgentsLLM, Message, MockAdapter, ReActAgent, SessionStore, SimpleAgent, TodoWriteTool, TokenCounter, ToolRegistry, createConfig, metadata, streamToJsonLines, version } from '${packageName}';
import { mkdtemp, rm } from 'node:fs/promises';
import { z } from 'zod';
const message = Message.fromJSON({ role: 'user', content: 'consumer', timestamp: '2026-08-12T12:34:56.123456', metadata: {} });
const llm = new HelloAgentsLLM({ model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test', adapter: new MockAdapter({ invoke: () => ({ content: 'consumer LLM', model: 'test-model', usage: {}, latency_ms: 0 }) }) });
const registry = new ToolRegistry();
registry.registerFunction(new FunctionTool({ name: 'echo', description: 'Echo consumer input.', inputSchema: z.object({ input: z.string() }).strict(), handler: ({ input }) => input }));
const counter = new TokenCounter({ tokenize: (text) => [...text].length });
const agent = new SimpleAgent({ name: 'consumer-agent', llm });
const react = new ReActAgent({ name: 'consumer-react', llm: new HelloAgentsLLM({ model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test', adapter: new MockAdapter({ invokeWithTools: () => ({ content: 'consumer ReAct', tool_calls: [], model: 'test-model', usage: {}, latency_ms: 0 }) }) }) });
async function* events() { yield AgentEvent.create('llm_chunk', 'consumer-agent', { chunk: 'consumer stream' }); }
const jsonLines = []; for await (const line of streamToJsonLines(events())) jsonLines.push(line);
const sessionDirectory = await mkdtemp('/tmp/helloagents-consumer-'); const store = new SessionStore({ sessionDir: sessionDirectory }); const session = await store.save({ agentConfig: {}, history: [], toolSchemaHash: 'consumer', readCache: {}, metadata: {} }); const sessionOk = (await store.load(session)).sessionId.length > 0; await rm(sessionDirectory, { recursive: true, force: true });
const durableDirectory = await mkdtemp('/tmp/helloagents-consumer-durable-'); const todo = await TodoWriteTool.create({ projectRoot: durableDirectory }); const todoOk = (await todo.execute({ todos: [{ content: 'consumer durable todo', status: 'in_progress' }] })).status === 'success' && (await TodoWriteTool.create({ projectRoot: durableDirectory })).todos.length === 1; const log = await DevLogTool.create({ sessionId: 'consumer', agentName: 'consumer', projectRoot: durableDirectory }); const logOk = (await log.execute({ action: 'append', category: 'test', content: 'consumer durable log' })).status === 'success' && (await DevLogTool.create({ sessionId: 'consumer', agentName: 'consumer', projectRoot: durableDirectory })).logEntries.length === 1; await rm(durableDirectory, { recursive: true, force: true });
if (version !== '${expectedVersion}' || metadata.name !== '${packageName}' || createConfig().contextWindow !== 128000 || message.toJSON().timestamp !== '2026-08-12T12:34:56.123456' || (await llm.invoke([{ role: 'user', content: 'hello' }])).content !== 'consumer LLM' || (await registry.execute('echo', { input: 'consumer tool' })).toJSON().data.output !== 'consumer tool' || counter.count('consumer 🌍') !== 10 || (await agent.run('consumer agent')) !== 'consumer LLM' || (await react.run('consumer ReAct')) !== 'consumer ReAct' || jsonLines.length !== 1 || !sessionOk || !todoOk || !logOk) process.exit(1);`;

function run(command, arguments_, cwd) {
  return execFileSync(command, arguments_, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

try {
  const packResult = run(
    'npm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    repositoryRoot
  );
  const packed = JSON.parse(packResult)[0];
  const packedFile = packed?.filename;
  assert.equal(typeof packedFile, 'string', 'npm pack must produce one archive');
  const packedPaths = new Set(packed?.files?.map((file) => file.path) ?? []);
  for (const requiredPath of [
    'README.md',
    'LICENSE',
    'NOTICE',
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/index.js.map'
  ]) {
    assert.equal(packedPaths.has(requiredPath), true, `package must include ${requiredPath}`);
  }
  assert.equal(
    [...packedPaths].some((path) => path.startsWith('hello_agents/') || path.startsWith('tests/')),
    false,
    'package must not include development source or tests'
  );

  const archivePath = join(temporaryDirectory, basename(packedFile));
  const bunConsumer = join(temporaryDirectory, 'bun-consumer');
  const npmConsumer = join(temporaryDirectory, 'npm-consumer');

  mkdirSync(bunConsumer, { recursive: true });
  mkdirSync(npmConsumer, { recursive: true });
  writeFileSync(join(bunConsumer, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(npmConsumer, 'package.json'), JSON.stringify({ type: 'module' }));

  run('bun', ['add', '--no-save', archivePath], bunConsumer);
  run('bun', ['-e', importCheck], bunConsumer);

  run('npm', ['install', '--ignore-scripts', archivePath], npmConsumer);
  run(process.execPath, ['--input-type=module', '--eval', importCheck], npmConsumer);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
