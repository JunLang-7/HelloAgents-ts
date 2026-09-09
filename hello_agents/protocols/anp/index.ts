/**
 * ANP 模块桶（对齐上游 `protocols/anp/__init__.py`）。
 *
 * 概念性实现，提供简洁 API：服务发现 + 网络管理 + 便捷注册/发现函数。
 */
import { ANPDiscovery, ANPNetwork, ServiceInfo, type ServiceInfoData } from './implementation.js';

/** 注册服务的便捷函数（支持传入 ServiceInfo 或参数构造，对齐上游）。 */
export function registerService(
  discovery: ANPDiscovery,
  service?: ServiceInfo,
  serviceId?: string,
  serviceType?: string,
  endpoint?: string,
  serviceName?: string,
  capabilities?: string[],
  metadata?: Record<string, unknown>
): boolean;
export function registerService(discovery: ANPDiscovery, options: ServiceInfoData): boolean;
export function registerService(
  discovery: ANPDiscovery,
  serviceOrOptions: ServiceInfo | ServiceInfoData | undefined = undefined,
  serviceId?: string,
  serviceType?: string,
  endpoint?: string,
  serviceName?: string,
  capabilities?: string[],
  metadata?: Record<string, unknown>
): boolean {
  if (serviceOrOptions instanceof ServiceInfo) {
    return discovery.registerService(serviceOrOptions);
  }
  if (serviceOrOptions && typeof serviceOrOptions === 'object') {
    const data = serviceOrOptions as ServiceInfoData;
    if (!data.service_id || !data.service_type || !data.endpoint) {
      throw new Error('必须提供 service_id, service_type 和 endpoint 参数');
    }
    return discovery.registerService(new ServiceInfo(data));
  }
  if (!serviceId || !serviceType || !endpoint) {
    throw new Error('必须提供 service_id, service_type 和 endpoint 参数');
  }
  return discovery.registerService(
    new ServiceInfo(serviceId, serviceType, endpoint, serviceName, capabilities, metadata)
  );
}

/** 发现服务的便捷函数（对齐上游 `discover_service`）。 */
export function discoverService(
  discovery: ANPDiscovery,
  serviceType: string | undefined = undefined
): ServiceInfo[] {
  return discovery.discoverServices(serviceType);
}

export { ANPDiscovery, ANPNetwork, ServiceInfo };
export type { ServiceInfoData };
