/**
 * Chapter 10 — ANP 协议示例（#75）。
 *
 * 运行：bun run examples/chapter10-anp.ts
 *
 * 演示：
 * 1. ServiceInfo + ANPDiscovery 服务注册/发现
 * 2. ANPNetwork 节点管理、消息路由与广播
 * 3. register_service / discover_service 便捷函数
 * 4. ANPTool 协议→工具封装
 */
import {
  ANPDiscovery,
  ANPNetwork,
  ServiceInfo
} from '../hello_agents/protocols/anp/implementation.js';
import { discoverService, registerService } from '../hello_agents/protocols/anp/index.js';
import { ANPTool } from '../hello_agents/tools/builtin/protocol-tools.js';

async function main(): Promise<void> {
  console.log('== ANP 服务发现 ==');
  const discovery = new ANPDiscovery();
  discovery.registerService(
    new ServiceInfo('calc-1', 'calculator', 'http://localhost:8001', 'Calc Agent', ['arithmetic'], {
      env: 'prod'
    })
  );
  registerService(discovery, {
    service_id: 'nlp-1',
    service_type: 'nlp',
    endpoint: 'http://localhost:8002',
    metadata: { env: 'dev' }
  });
  console.log(
    'calculator 服务:',
    discoverService(discovery, 'calculator').map((s) => s.service_id)
  );
  console.log(
    'env=prod 服务:',
    discovery.discoverServices(undefined, { env: 'prod' }).map((s) => s.service_id)
  );

  console.log('\n== ANP 网络与路由 ==');
  const network = new ANPNetwork('demo-net');
  network.addNode('n1', 'http://localhost:8001', { role: 'coordinator' });
  network.addNode('n2', 'http://localhost:8002');
  network.addNode('n3', 'http://localhost:8003');
  network.connectNodes('n1', 'n2');
  network.connectNodes('n2', 'n3');
  console.log('路由 n1→n3:', network.routeMessage('n1', 'n3', {})?.join(' -> '));
  console.log('广播 n1:', network.broadcastMessage('n1', {}));
  console.log('统计:', JSON.stringify(network.getNetworkStats()));

  console.log('\n== ANPTool 工具封装 ==');
  const tool = new ANPTool('anp-demo');
  tool.execute({
    action: 'register_service',
    service_id: 'calc-1',
    service_type: 'calculator',
    endpoint: 'http://localhost:8001'
  });
  const discover = await tool.execute({ action: 'discover_services', service_type: 'calculator' });
  console.log(discover.text);
}

main();
