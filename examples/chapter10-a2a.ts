/**
 * Chapter 10 — A2A 协议示例（#75）。
 *
 * 运行：bun run examples/chapter10-a2a.ts
 *
 * 演示：
 * 1. 本地起 A2A 服务器（真实 HTTP，随机端口）
 * 2. A2A 客户端互通：/info /skills /ask /execute
 * 3. AgentNetwork 发现 + AgentRegistry 注册
 * 4. A2ATool 协议→工具封装
 */
import { createExampleAgent } from '../hello_agents/protocols/a2a/implementation.js';
import {
  A2AClient,
  AgentNetwork,
  AgentRegistry
} from '../hello_agents/protocols/a2a/implementation.js';
import { A2ATool } from '../hello_agents/tools/builtin/protocol-tools.js';

async function main(): Promise<void> {
  const agent = createExampleAgent();
  const server = await agent.run('127.0.0.1', 0);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('unexpected address');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    console.log(`A2A 服务器启动: ${baseUrl}（技能: ${Object.keys(agent.skills).join(', ')}）`);

    console.log('\n== A2A 客户端互通 ==');
    const client = new A2AClient(baseUrl);
    console.log('info:', JSON.stringify(await client.getInfo(), null, 2));
    console.log('skills:', await client.listSkills());
    console.log('ask(hello):', await client.ask('hello'));
    console.log('ask(calculate 2+2):', await client.ask('calculate 2+2'));
    console.log('execute(greet):', JSON.stringify(await client.executeSkill('greet', 'hi')));

    console.log('\n== AgentNetwork 发现 + AgentRegistry ==');
    const network = new AgentNetwork('demo-network');
    network.addAgent('example', baseUrl);
    console.log('agents:', network.listAgents());
    const registry = new AgentRegistry('demo-registry');
    registry.registerAgent('example', baseUrl, { source: 'chapter10' });
    console.log('registry:', registry.getInfo());

    console.log('\n== A2ATool 工具封装 ==');
    const tool = new A2ATool(baseUrl, 'a2a-demo');
    console.log((await tool.execute({ action: 'ask', question: 'calculate 5*3' })).text);
  } finally {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  }
}

void main();
