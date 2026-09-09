/**
 * ANP（Agent Network Protocol）实现（对齐上游 `protocols/anp/implementation.py`）。
 *
 * 概念性实现，基于 agent-connect 理念的简化包装：服务发现 + 网络管理 +
 * 简单路由。纯内存、零依赖，用于教学理解 ANP。
 */
export interface ServiceInfoData {
  service_id: string;
  service_type: string;
  endpoint: string;
  service_name?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

/** 服务信息。 */
export class ServiceInfo {
  public readonly service_id: string;
  public readonly service_type: string;
  public readonly endpoint: string;
  public readonly service_name: string;
  public readonly capabilities: string[];
  public readonly metadata: Record<string, unknown>;

  public constructor(
    serviceId: string,
    serviceType: string,
    endpoint: string,
    serviceName?: string,
    capabilities?: string[],
    metadata?: Record<string, unknown>
  );
  public constructor(data: ServiceInfoData);
  public constructor(
    serviceIdOrData: string | ServiceInfoData,
    serviceType = '',
    endpoint = '',
    serviceName?: string,
    capabilities?: string[],
    metadata?: Record<string, unknown>
  ) {
    if (typeof serviceIdOrData === 'object') {
      const data = serviceIdOrData;
      this.service_id = data.service_id;
      this.service_type = data.service_type;
      this.endpoint = data.endpoint;
      this.service_name = data.service_name ?? data.service_id;
      this.capabilities = data.capabilities ?? [];
      this.metadata = data.metadata ?? {};
    } else {
      this.service_id = serviceIdOrData;
      this.service_type = serviceType ?? '';
      this.endpoint = endpoint ?? '';
      this.service_name = serviceName ?? serviceIdOrData;
      this.capabilities = capabilities ?? [];
      this.metadata = metadata ?? {};
    }
  }

  /** 转换为字典。 */
  public toDict(): Record<string, unknown> {
    return {
      service_id: this.service_id,
      service_type: this.service_type,
      endpoint: this.endpoint,
      service_name: this.service_name,
      capabilities: this.capabilities,
      metadata: this.metadata
    };
  }

  /** 从字典创建。 */
  public static fromDict(data: Record<string, unknown>): ServiceInfo {
    return new ServiceInfo({
      service_id: String(data.service_id),
      service_type: String(data.service_type),
      endpoint: String(data.endpoint),
      ...(data.service_name === undefined ? {} : { service_name: String(data.service_name) }),
      ...(Array.isArray(data.capabilities) ? { capabilities: data.capabilities.map(String) } : {}),
      ...(typeof data.metadata === 'object' && data.metadata !== null
        ? { metadata: data.metadata as Record<string, unknown> }
        : {})
    });
  }
}

/** 基于 agent-connect 理念的服务发现实现。 */
export class ANPDiscovery {
  private readonly services = new Map<string, ServiceInfo>();

  /** 注册服务。 */
  public registerService(service: ServiceInfo): boolean {
    this.services.set(service.service_id, service);
    return true;
  }

  /** 注销服务。 */
  public unregisterService(serviceId: string): boolean {
    return this.services.delete(serviceId);
  }

  /** 发现服务（按类型与元数据过滤）。 */
  public discoverServices(
    serviceType: string | undefined = undefined,
    filters: Record<string, unknown> | undefined = undefined
  ): ServiceInfo[] {
    let result = [...this.services.values()];
    if (serviceType) {
      result = result.filter((service) => service.service_type === serviceType);
    }
    if (filters) {
      result = result.filter((service) =>
        Object.entries(filters).every(([key, value]) => service.metadata[key] === value)
      );
    }
    return result;
  }

  /** 获取服务信息。 */
  public getService(serviceId: string): ServiceInfo | undefined {
    return this.services.get(serviceId);
  }

  /** 列出所有服务。 */
  public listAllServices(): ServiceInfo[] {
    return [...this.services.values()];
  }
}

export interface NetworkNodeInfo {
  node_id: string;
  endpoint: string;
  metadata: Record<string, unknown>;
  status: string;
  connections?: string[];
}

/** 基于 agent-connect 理念的网络管理实现。 */
export class ANPNetwork {
  public readonly network_id: string;
  private readonly nodes = new Map<string, NetworkNodeInfo>();
  private readonly connections = new Map<string, string[]>();

  public constructor(networkId = 'default') {
    this.network_id = networkId;
  }

  /** 添加节点到网络。 */
  public addNode(
    nodeId: string,
    endpoint: string,
    metadata: Record<string, unknown> | undefined = undefined
  ): void {
    this.nodes.set(nodeId, {
      node_id: nodeId,
      endpoint,
      metadata: metadata ?? {},
      status: 'active'
    });
    this.connections.set(nodeId, []);
  }

  /** 从网络移除节点。 */
  public removeNode(nodeId: string): boolean {
    if (!this.nodes.has(nodeId)) return false;
    this.nodes.delete(nodeId);
    this.connections.delete(nodeId);
    for (const connected of this.connections.values()) {
      const index = connected.indexOf(nodeId);
      if (index !== -1) connected.splice(index, 1);
    }
    return true;
  }

  /** 连接两个节点。 */
  public connectNodes(fromNode: string, toNode: string): void {
    const targets = this.connections.get(fromNode);
    if (targets && this.nodes.has(toNode) && !targets.includes(toNode)) {
      targets.push(toNode);
    }
  }

  /** 路由消息（直接路由或一跳中转）。 */
  public routeMessage(
    fromNode: string,
    toNode: string,
    message: Record<string, unknown>
  ): string[] | undefined {
    void message;
    if (!this.nodes.has(fromNode) || !this.nodes.has(toNode)) return undefined;
    const direct = this.connections.get(fromNode);
    if (direct?.includes(toNode)) return [fromNode, toNode];
    for (const intermediate of direct ?? []) {
      if (this.connections.get(intermediate)?.includes(toNode)) {
        return [fromNode, intermediate, toNode];
      }
    }
    return undefined;
  }

  /** 广播消息到所有连接的节点。 */
  public broadcastMessage(fromNode: string, message: Record<string, unknown>): string[] {
    void message;
    return [...(this.connections.get(fromNode) ?? [])];
  }

  /** 获取网络统计信息。 */
  public getNetworkStats(): Record<string, unknown> {
    const totalConnections = [...this.connections.values()].reduce(
      (sum, list) => sum + list.length,
      0
    );
    const activeNodes = [...this.nodes.values()].filter((node) => node.status === 'active').length;
    return {
      network_id: this.network_id,
      total_nodes: this.nodes.size,
      active_nodes: activeNodes,
      total_connections: totalConnections,
      nodes: [...this.nodes.keys()]
    };
  }

  /** 获取节点信息（含连接）。 */
  public getNodeInfo(nodeId: string): NetworkNodeInfo | undefined {
    const node = this.nodes.get(nodeId);
    if (!node) return undefined;
    return { ...node, connections: [...(this.connections.get(nodeId) ?? [])] };
  }
}

/** 创建示例 ANP 网络（对齐上游 `create_example_network`）。 */
export function createExampleNetwork(): ANPNetwork {
  const network = new ANPNetwork('example_network');
  network.addNode('node1', 'http://localhost:8001', { type: 'agent', role: 'coordinator' });
  network.addNode('node2', 'http://localhost:8002', { type: 'agent', role: 'worker' });
  network.addNode('node3', 'http://localhost:8003', { type: 'agent', role: 'worker' });
  network.connectNodes('node1', 'node2');
  network.connectNodes('node1', 'node3');
  network.connectNodes('node2', 'node3');
  return network;
}
