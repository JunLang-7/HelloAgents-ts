import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'helloagents-package-'));
const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const packageName = packageJson.name;
const expectedVersion = packageJson.version;
const importCheck = `import { AgentEvent, FunctionTool, HelloAgentsLLM, Message, MockAdapter, ReActAgent, SimpleAgent, TokenCounter, ToolRegistry, WorkingMemory, createConfig, create_research_chain, metadata, run_batch_tool, run_parallel_tools, search_hybrid, search_serpapi, search_tavily, version } from '${packageName}';
import { SimpleAgent as AgentsSimpleAgent, ReActAgent as AgentsReActAgent } from '${packageName}/agents';
import { ContextBuilder, ContextConfig, ContextPacket, TokenCounter as ContextTokenCounter, countTokens } from '${packageName}/context';
import { HelloAgentsLLM as CoreLLM, createConfig as coreCreateConfig } from '${packageName}/core';
import { MemoryManager, WorkingMemory as MemoryWorkingMemory } from '${packageName}/memory';
import { CalculatorTool, ToolRegistry as ToolsToolRegistry } from '${packageName}/tools';
import { Logger as UtilsLogger } from '${packageName}/utils';
import { mkdtemp, rm } from 'node:fs/promises';
import { z } from 'zod';
const message = Message.fromJSON({ role: 'user', content: 'consumer', timestamp: '2026-08-12T12:34:56.123456', metadata: {} });
const llm = new HelloAgentsLLM({ model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test', adapter: new MockAdapter({ invoke: () => ({ content: 'consumer LLM', model: 'test-model', usage: {}, latency_ms: 0 }) }) });
const registry = new ToolRegistry();
registry.registerFunction(new FunctionTool({ name: 'echo', description: 'Echo consumer input.', inputSchema: z.object({ input: z.string() }).strict(), handler: ({ input }) => input }));
const counter = new TokenCounter({ tokenize: (text) => [...text].length });
const agent = new SimpleAgent({ name: 'consumer-agent', llm });
const react = new ReActAgent({ name: 'consumer-react', llm: new HelloAgentsLLM({ model: 'test-model', apiKey: 'test-key', baseUrl: 'https://provider.test', adapter: new MockAdapter({ invoke: () => ({ content: 'Action: Finish[consumer ReAct]', model: 'test-model', usage: {}, latency_ms: 0 }) }) }) });
async function* events() { yield AgentEvent.create('llm_chunk', 'consumer-agent', { chunk: 'consumer stream' }); }
const working = new WorkingMemory();
const memoryManager = new MemoryManager({ enablePerceptual: false });
memoryManager.addMemory('consumer memory');
if (version !== '${expectedVersion}' || metadata.name !== '${packageName}' || createConfig().contextWindow !== 128000 || create_research_chain().name !== 'research_and_calculate' || typeof run_parallel_tools !== 'function' || typeof run_batch_tool !== 'function' || typeof search_tavily !== 'function' || typeof search_serpapi !== 'function' || typeof search_hybrid !== 'function' || message.toJSON().timestamp !== '2026-08-12T12:34:56.123456' || (await llm.invoke([{ role: 'user', content: 'hello' }])) !== 'consumer LLM' || (await registry.execute('echo', { input: 'consumer tool' })).toJSON().data.output !== 'consumer tool' || counter.count('consumer 🌍') !== 10 || (await agent.run('consumer agent')) !== 'consumer LLM' || (await react.run('consumer ReAct')) !== 'consumer ReAct') process.exit(1);
if (typeof AgentsSimpleAgent !== 'function' || typeof AgentsReActAgent !== 'function') process.exit(2);
if (typeof ContextBuilder !== 'function' || typeof ContextConfig !== 'function' || typeof ContextPacket !== 'function' || typeof ContextTokenCounter !== 'function' || typeof countTokens !== 'function') process.exit(3);
if (typeof CoreLLM !== 'function' || typeof coreCreateConfig !== 'function') process.exit(4);
if (typeof MemoryManager !== 'function' || typeof MemoryWorkingMemory !== 'function' || typeof memoryManager.retrieveMemories !== 'function' || working.add.length !== 1) process.exit(5);
if (typeof CalculatorTool !== 'function' || typeof ToolsToolRegistry !== 'function') process.exit(6);
if (typeof UtilsLogger !== 'function') process.exit(7);
// #75: protocol subpaths must resolve from a clean tarball (MCP/A2A/ANP).
const protocols = await import('${packageName}/protocols');
const mcpSub = await import('${packageName}/protocols/mcp');
const a2aSub = await import('${packageName}/protocols/a2a');
const anpSub = await import('${packageName}/protocols/anp');
if (typeof protocols.MCPServer !== 'function' || typeof protocols.A2AServer !== 'function' || typeof protocols.ANPDiscovery !== 'function') process.exit(8);
if (typeof mcpSub.createContext !== 'function' || typeof mcpSub.MCPClient !== 'function') process.exit(9);
if (typeof a2aSub.A2AClient !== 'function' || typeof anpSub.registerService !== 'function') process.exit(10);
let optionalRejected = false;
try { await import('${packageName}/evaluation'); } catch { optionalRejected = true; }
if (!optionalRejected) process.exit(11);`;

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
    'dist/index.js.map',
    'dist/agents/index.js',
    'dist/agents/index.d.ts',
    'dist/context/index.js',
    'dist/context/index.d.ts',
    'dist/core/index.js',
    'dist/core/index.d.ts',
    'dist/memory/index.js',
    'dist/memory/index.d.ts',
    'dist/tools/index.js',
    'dist/tools/index.d.ts',
    'dist/utils/index.js',
    'dist/utils/index.d.ts'
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
