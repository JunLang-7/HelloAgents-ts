/**
 * Chapter 07：HelloAgents 框架完整演示（对应上游 examples/chapter07_basic_setup.py）。
 *
 * 展示：
 * 1. 四种 Agent 范式（SimpleAgent / ReActAgent / ReflectionAgent / PlanAndSolveAgent）
 * 2. 工具系统集成（ToolRegistry + calculate + 自定义函数）
 * 3. 高级特性（ToolChain / ToolChainManager / AsyncToolExecutor）
 *
 * 默认全部使用 mock LLM（dry-run，无需 API Key）；设置 HELLOAGENTS_REAL_API=1
 * 或 OPENAI_API_KEY 后使用真实 OpenAI 兼容接口。
 *
 * 运行：bun run examples/chapter07-basic-setup.ts
 */
import {
  PlanAndSolveAgent,
  ReActAgent,
  ReflectionAgent,
  SimpleAgent
} from '../hello_agents/agents/index.js';
import { HelloAgentsLLM } from '../hello_agents/core/index.js';
import {
  AsyncToolExecutor,
  CalculatorTool,
  ToolChain,
  ToolChainManager,
  ToolRegistry,
  calculate
} from '../hello_agents/tools/index.js';
import { heading, mockLlm } from './_shared.js';

const USE_REAL_API =
  process.env.HELLOAGENTS_REAL_API === '1' || Boolean(process.env.OPENAI_API_KEY);

function buildLlm(): HelloAgentsLLM {
  if (USE_REAL_API) {
    return new HelloAgentsLLM({ model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' });
  }
  return mockLlm();
}

function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new CalculatorTool());
  registry.registerFunction(
    'get_weather',
    'Get today weather for a city.',
    (input: string) => `${input.trim()}：晴，24°C`
  );
  return registry;
}

async function demoSimpleAgent(llm: HelloAgentsLLM): Promise<void> {
  heading('1. SimpleAgent 演示 - 基础对话Agent');
  const agent = new SimpleAgent({
    name: '助手',
    llm,
    systemPrompt: '你是一个有用的AI助手，请用中文回答问题。'
  });
  for (const question of ['你好，请介绍一下自己', '什么是人工智能？']) {
    const response = await agent.run(question);
    console.log(`用户: ${question}\n助手: ${response}\n`);
  }
}

async function demoReActAgent(llm: HelloAgentsLLM): Promise<void> {
  heading('2. ReActAgent 演示 - 推理与行动结合的Agent');
  const reactLlm = USE_REAL_API
    ? llm
    : mockLlm([
        'Thought: 我需要计算 15 * 23 + 45\nAction: calculate["15 * 23 + 45"]',
        'Thought: 结果已得到\nAction: Finish[结果是 390]'
      ]);
  const agent = new ReActAgent({
    name: '通用助手',
    llm: reactLlm,
    toolRegistry: buildToolRegistry(),
    maxSteps: 3
  });
  const response = await agent.run('计算 15 * 23 + 45 的结果');
  console.log(`任务: 计算 15 * 23 + 45 的结果\n结果: ${response}\n`);
}

async function demoReflectionAgent(llm: HelloAgentsLLM): Promise<void> {
  heading('3. ReflectionAgent 演示 - 自我反思与迭代优化');
  const reflectionLlm = USE_REAL_API
    ? llm
    : mockLlm(['第一版草稿', '语言可以更简洁', '更简洁的草稿', '无需改进']);
  const agent = new ReflectionAgent({
    name: '写作助手',
    llm: reflectionLlm,
    systemPrompt: '你是一位严谨的中文写作者。',
    maxIterations: 2
  });
  const response = await agent.run('写一句关于春天的文案');
  console.log(`结果: ${response}\n`);
}

async function demoPlanAndSolveAgent(llm: HelloAgentsLLM): Promise<void> {
  heading('4. PlanAndSolveAgent 演示 - 分解规划与逐步执行');
  const planLlm = USE_REAL_API
    ? llm
    : mockLlm(['```python\n["计算 3 的 4 次方", "报告结果"]\n```', '81', '3 的 4 次方是 81。']);
  const agent = new PlanAndSolveAgent({
    name: '解题专家',
    llm: planLlm
  });
  const response = await agent.run('计算 3 的 4 次方是多少？');
  console.log(`任务: 计算 3 的 4 次方\n结果: ${response}\n`);
}

async function demoAdvancedFeatures(): Promise<void> {
  heading('5. 高级特性 - ToolChain / ToolChainManager / AsyncToolExecutor');
  const registry = buildToolRegistry();

  // ToolChain：把多个工具按顺序串成一条流水线
  const chain = new ToolChain('math-pipeline', '计算流水线');
  chain.addStep('python_calculator', '{input}');
  const chainResult = await chain.execute(registry, '2+3');
  console.log('ToolChain 执行结果:', chainResult);

  // ToolChainManager：注册并管理多条链
  const manager = new ToolChainManager(registry);
  manager.registerChain(chain);
  console.log('ToolChainManager 已注册链:', manager.listChains());
  const managed = await manager.executeChain('math-pipeline', '10*10');
  console.log('ToolChainManager 执行:', managed);

  // AsyncToolExecutor：并行执行多个工具调用
  const executor = new AsyncToolExecutor(registry);
  const tasks = [
    { task_id: 1, tool_name: 'python_calculator', input_data: '10*10' },
    { task_id: 2, tool_name: 'python_calculator', input_data: '20/4' },
    { task_id: 3, tool_name: 'python_calculator', input_data: '7+3' }
  ];
  const results = await executor.executeToolsParallel(tasks);
  for (const r of results) {
    console.log(`并行计算 #${r.task_id} [${r.status}]: ${r.result}`);
  }

  // 直接使用 calculate 便捷函数（纯本地计算，dry-run 安全）
  const direct = await calculate('sqrt(16) + 2');
  console.log('calculate("sqrt(16) + 2") =', direct.trim());
}

async function main(): Promise<void> {
  heading('Chapter 07 — HelloAgents 框架完整演示');
  console.log(`模式: ${USE_REAL_API ? '真实 API' : 'mock / dry-run'}`);

  const llm = buildLlm();
  await demoSimpleAgent(llm);
  await demoReActAgent(llm);
  await demoReflectionAgent(llm);
  await demoPlanAndSolveAgent(llm);
  await demoAdvancedFeatures();
}

void main();
