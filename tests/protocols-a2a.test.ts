/**
 * #75 协议模块测试：A2A（真实 HTTP 互通 / 网络 / 注册中心 / 工具 / 别名政策）。
 */
import { describe, expect, test } from 'bun:test';
import {
  A2A_AVAILABLE,
  A2AAgent,
  A2AClient,
  A2AServer,
  AgentNetwork,
  AgentRegistry,
  createExampleAgent,
  createMessage,
  parseMessage
} from '../hello_agents/protocols/a2a/index.js';
import { A2ATool } from '../hello_agents/tools/builtin/protocol-tools.js';

describe('A2AServer + A2AClient（真实 HTTP 互通）', () => {
  test('example agent serves /info /skills /ask /execute /health', async () => {
    const server = new A2AServer({
      name: 'test-agent',
      description: 'A2A test agent',
      capabilities: { chat: true, calculation: true }
    });
    server.addSkill('echo', (text: string) => `echo:${text}`);
    server.addSkill('calculate', (text: string) => {
      const match = text.match(/calculate\s+(.+)/i);
      if (!match || !match[1]) return 'Please provide an expression';
      const expr = match[1].trim();
      return `The result is: ${String(new Function(`return (${expr})`)())}`;
    });

    const httpServer = await server.run('127.0.0.1', 0);
    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('unexpected server address');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const client = new A2AClient(baseUrl);
      const info = await client.getInfo();
      expect(info).toMatchObject({ name: 'test-agent', protocol: 'A2A' });
      expect(info.skills).toEqual(expect.arrayContaining(['echo', 'calculate']));

      expect(await client.listSkills()).toEqual(expect.arrayContaining(['echo']));

      const echoed = await client.executeSkill('echo', 'hello a2a');
      expect(echoed).toMatchObject({ skill: 'echo', status: 'success' });
      expect(echoed.result).toBe('echo:hello a2a');

      const calc = await client.executeSkill('calculate', 'calculate 2+2');
      expect(calc).toMatchObject({ status: 'success' });

      const missing = await client.executeSkill('nope', 'x');
      expect(missing).toMatchObject({ status: 'error' });

      const answer = await client.ask('echo:ping');
      expect(answer).toContain('echo:ping');
    } finally {
      await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
    }
  });

  test('health endpoint reports healthy agent', async () => {
    const agent = createExampleAgent();
    const httpServer = await agent.run('127.0.0.1', 0);
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('bad address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'healthy' });
    } finally {
      await new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
      });
    }
  });
});

describe('AgentNetwork + AgentRegistry', () => {
  test('network discovers real agents over HTTP', async () => {
    const agent = createExampleAgent();
    const httpServer = await agent.run('127.0.0.1', 0);
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('bad address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const network = new AgentNetwork('test-network');
      network.addAgent('example', baseUrl);
      expect(network.listAgents()).toEqual([{ name: 'example', url: baseUrl }]);

      const discovered = await network.discoverAgents([baseUrl, 'http://127.0.0.1:1']);
      expect(discovered).toBe(1);
      expect(network.listAgents()).toEqual(
        expect.arrayContaining([{ name: 'Example A2A Agent', url: baseUrl }])
      );

      const client = network.getAgent('Example A2A Agent');
      expect((await client.getInfo()).name).toBe('Example A2A Agent');
      expect(() => network.getAgent('missing')).toThrow(/not found/);
    } finally {
      await new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
      });
    }
  });

  test('registry registers, finds, lists and unregisters agents', () => {
    const registry = new AgentRegistry('central', 'Central registry');
    registry.registerAgent('a1', 'http://agent-1', { team: 'alpha' });
    registry.registerAgent('a2', 'http://agent-2');
    expect(registry.listAgents()).toHaveLength(2);
    expect(registry.findAgent('a1')).toMatchObject({ url: 'http://agent-1' });
    registry.unregisterAgent('a1');
    expect(registry.findAgent('a1')).toBeUndefined();
    expect(registry.getInfo()).toMatchObject({ registered_agents: 1, type: 'registry' });
  });
});

describe('A2A 别名与占位政策（对齐上游 a2a/__init__.py）', () => {
  test('A2AAgent is the A2AServer class; A2A_AVAILABLE is true', () => {
    expect(A2AAgent).toBe(A2AServer);
    expect(A2A_AVAILABLE).toBe(true);
  });

  test('createMessage / parseMessage remain placeholders that throw', () => {
    expect(() => createMessage('hello')).toThrow(/a2a-sdk/);
    expect(() => parseMessage({})).toThrow(/a2a-sdk/);
  });
});

describe('A2ATool（协议→工具封装）', () => {
  test('ask and get_info against a live server', async () => {
    const agent = createExampleAgent();
    const httpServer = await agent.run('127.0.0.1', 0);
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('bad address');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const tool = new A2ATool(baseUrl, 'a2a-tool');
      const ask = await tool.execute({ action: 'ask', question: 'hello' });
      expect(ask.status).toBe('success');
      expect(ask.text).toContain('Hello!');
      const info = await tool.execute({ action: 'get_info' });
      expect(info.text).toContain('Example A2A Agent');
      const execute = await tool.execute({
        action: 'execute_skill',
        skill_name: 'calculate',
        text: 'calculate 1+1'
      });
      expect(execute.text).toContain('2');
    } finally {
      await new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
      });
    }
  });

  test('invalid action and missing question surface errors', async () => {
    const tool = new A2ATool('http://127.0.0.1:1', 'a2a');
    const bad = await tool.execute({ action: 'nope' });
    expect(bad.status).toBe('error');
    const missing = await tool.execute({ action: 'ask' });
    expect(missing.status).toBe('error');
  });
});
