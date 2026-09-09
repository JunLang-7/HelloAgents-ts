/**
 * #75 协议模块测试：ANP（服务发现 / 网络路由 / 便捷函数 / 工具封装）。
 */
import { describe, expect, test } from 'bun:test';

import {
  ANPDiscovery,
  ANPNetwork,
  ServiceInfo,
  discoverService,
  registerService
} from '../hello_agents/protocols/anp/index.js';
import { ANPTool } from '../hello_agents/tools/builtin/protocol-tools.js';

describe('ServiceInfo', () => {
  test('round-trips through toDict/fromDict', () => {
    const service = new ServiceInfo({
      service_id: 'calc-1',
      service_type: 'calculator',
      endpoint: 'http://localhost:8001',
      service_name: 'Calc Agent',
      capabilities: ['arithmetic'],
      metadata: { version: '1.0' }
    });
    const restored = ServiceInfo.fromDict(service.toDict() as Record<string, unknown>);
    expect(restored.service_id).toBe('calc-1');
    expect(restored.service_name).toBe('Calc Agent');
    expect(restored.capabilities).toEqual(['arithmetic']);
    expect(restored.metadata).toEqual({ version: '1.0' });
  });

  test('positional constructor defaults service_name to service_id', () => {
    const service = new ServiceInfo('s1', 'nlp', 'http://x');
    expect(service.service_name).toBe('s1');
    expect(service.capabilities).toEqual([]);
  });
});

describe('ANPDiscovery', () => {
  test('registers, discovers by type and metadata filters, and unregisters', () => {
    const discovery = new ANPDiscovery();
    const calc = new ServiceInfo('calc-1', 'calculator', 'http://a', 'Calc', ['arith'], {
      env: 'prod'
    });
    const nlp = new ServiceInfo('nlp-1', 'nlp', 'http://b', 'NLP', [], { env: 'dev' });
    discovery.registerService(calc);
    discovery.registerService(nlp);

    expect(discovery.discoverServices('calculator').map((s) => s.service_id)).toEqual(['calc-1']);
    expect(discovery.discoverServices(undefined, { env: 'dev' }).map((s) => s.service_id)).toEqual([
      'nlp-1'
    ]);
    expect(discovery.getService('calc-1')?.endpoint).toBe('http://a');
    expect(discovery.listAllServices()).toHaveLength(2);
    expect(discovery.unregisterService('calc-1')).toBe(true);
    expect(discovery.unregisterService('missing')).toBe(false);
    expect(discovery.listAllServices()).toHaveLength(1);
  });

  test('registerService convenience function supports both call styles', () => {
    const discovery = new ANPDiscovery();
    expect(registerService(discovery, new ServiceInfo('a', 't', 'http://a'))).toBe(true);
    expect(
      registerService(discovery, {
        service_id: 'b',
        service_type: 't2',
        endpoint: 'http://b',
        metadata: { k: 'v' }
      })
    ).toBe(true);
    expect(() => registerService(discovery, { service_id: 'x' } as never)).toThrow(
      /service_id, service_type 和 endpoint/
    );
    expect(() => registerService(discovery, undefined, 'x')).toThrow(/service_id/);
    expect(discovery.listAllServices()).toHaveLength(2);
  });

  test('discoverService convenience function', () => {
    const discovery = new ANPDiscovery();
    discovery.registerService(new ServiceInfo('a', 't', 'http://a'));
    expect(discoverService(discovery, 't')).toHaveLength(1);
    expect(discoverService(discovery, 'missing')).toHaveLength(0);
  });
});

describe('ANPNetwork', () => {
  test('routes directly and through one hop, and broadcasts', () => {
    const network = new ANPNetwork('test-net');
    network.addNode('n1', 'http://1', { role: 'coordinator' });
    network.addNode('n2', 'http://2');
    network.addNode('n3', 'http://3');
    network.connectNodes('n1', 'n2');
    network.connectNodes('n2', 'n3');

    expect(network.routeMessage('n1', 'n2', {})).toEqual(['n1', 'n2']);
    expect(network.routeMessage('n1', 'n3', {})).toEqual(['n1', 'n2', 'n3']);
    expect(network.routeMessage('n3', 'n1', {})).toBeUndefined();
    expect(network.routeMessage('n1', 'missing', {})).toBeUndefined();
    expect(network.broadcastMessage('n1', {})).toEqual(['n2']);
    expect(network.getNetworkStats()).toMatchObject({
      network_id: 'test-net',
      total_nodes: 3,
      active_nodes: 3
    });
    expect(network.getNodeInfo('n1')?.connections).toEqual(['n2']);
  });

  test('removes nodes and cleans up connections', () => {
    const network = new ANPNetwork();
    network.addNode('a', 'http://a');
    network.addNode('b', 'http://b');
    network.connectNodes('a', 'b');
    expect(network.removeNode('b')).toBe(true);
    expect(network.removeNode('missing')).toBe(false);
    expect(network.getNetworkStats().total_nodes).toBe(1);
    expect(network.getNodeInfo('b')).toBeUndefined();
  });
});

describe('ANPTool（协议→工具封装）', () => {
  test('register/discover services and manage nodes', async () => {
    const tool = new ANPTool('anp-test');
    const register = await tool.execute({
      action: 'register_service',
      service_id: 'calc-1',
      service_type: 'calculator',
      endpoint: 'http://localhost:8001'
    });
    expect(register.text).toContain('已注册服务');

    const discover = await tool.execute({
      action: 'discover_services',
      service_type: 'calculator'
    });
    expect(discover.text).toContain('calc-1');

    const addNode = await tool.execute({
      action: 'add_node',
      node_id: 'n1',
      endpoint: 'http://n1'
    });
    expect(addNode.text).toContain('已添加节点');

    const stats = await tool.execute({ action: 'get_stats' });
    expect(stats.text).toContain('total_nodes');

    const missing = await tool.execute({ action: 'register_service', service_id: 'x' });
    expect(missing.status).toBe('error');
  });

  test('routes messages through the network', async () => {
    const tool = new ANPTool();
    await tool.execute({ action: 'add_node', node_id: 'n1', endpoint: 'http://1' });
    await tool.execute({ action: 'add_node', node_id: 'n2', endpoint: 'http://2' });
    await tool.execute({ action: 'add_node', node_id: 'n3', endpoint: 'http://3' });
    await tool.execute({ action: 'route_message', from_node: 'n1', to_node: 'n3' });
    // 尚未建边，路由不存在
    const noRoute = await tool.execute({ action: 'route_message', from_node: 'n1', to_node: 'n3' });
    expect(noRoute.text).toContain('无法找到路由路径');
    // 注入边的场景在 ANPNetwork 单测中覆盖
  });
});
