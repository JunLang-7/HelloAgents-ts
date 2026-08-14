import { ToolStatus } from './response.js';
import type { ToolResponse } from './response.js';

/** 单个工具的熔断状态；`half-open` 允许一次恢复探测。 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** 单个工具的失败次数和恢复时间快照。 */
export interface CircuitStatus {
  readonly state: CircuitState;
  readonly failure_count: number;
  readonly open_since?: number;
  readonly recover_in_seconds?: number;
}

export interface CircuitBreakerOptions {
  /** 触发熔断所需的连续失败次数。 */
  readonly failureThreshold?: number;
  /** 熔断后保持阻断、等待恢复探测的秒数。 */
  readonly recoveryTimeoutSeconds?: number;
  /** 是否启用熔断；禁用时仍保留记录 API。 */
  readonly enabled?: boolean;
  /** 单调毫秒时钟；可注入以支持确定性测试。 */
  readonly now?: () => number;
}

function validateNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

/**
 * 单工具熔断器。上游 Python/Go 实现恢复后直接转为 closed；TypeScript 将恢复探测
 * 显式表示为 `half-open`，确保同一时刻只有一次调用可以测试已恢复的工具。
 */
export class CircuitBreaker {
  public readonly failureThreshold: number;
  public readonly recoveryTimeoutSeconds: number;
  public readonly enabled: boolean;
  private readonly now: () => number;
  private readonly failureCounts = new Map<string, number>();
  private readonly openTimestamps = new Map<string, number>();
  private readonly halfOpenProbes = new Set<string>();

  public constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = validateNonNegativeInteger(
      options.failureThreshold ?? 3,
      'failureThreshold'
    );
    this.recoveryTimeoutSeconds = validateNonNegativeInteger(
      options.recoveryTimeoutSeconds ?? 300,
      'recoveryTimeoutSeconds'
    );
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? Date.now;
  }

  /** 返回工具当前是否被阻断，不会消耗恢复探测机会。 */
  public isOpen(toolName: string): boolean {
    if (!this.enabled) return false;
    const openAt = this.openTimestamps.get(toolName);
    if (openAt === undefined) return false;
    return this.now() - openAt <= this.recoveryTimeoutSeconds * 1000;
  }

  /**
   * 返回是否允许一次执行。超时后，恰好一次执行会消耗 half-open 探测机会；
   * 必须记录该执行结果。
   */
  public canExecute(toolName: string): boolean {
    if (!this.enabled) return true;
    const openAt = this.openTimestamps.get(toolName);
    if (openAt === undefined) return true;
    if (this.now() - openAt <= this.recoveryTimeoutSeconds * 1000) return false;
    if (this.halfOpenProbes.has(toolName)) return false;
    this.halfOpenProbes.add(toolName);
    return true;
  }

  /** 记录响应并更新失败和熔断状态。 */
  public recordResult(toolName: string, response: ToolResponse): void {
    if (!this.enabled) return;
    if (response.status === ToolStatus.ERROR) this.onFailure(toolName);
    else this.onSuccess(toolName);
  }

  /** 立即打开指定工具的熔断器。 */
  public open(toolName: string): void {
    if (!this.enabled) return;
    this.openTimestamps.set(toolName, this.now());
    this.halfOpenProbes.delete(toolName);
  }

  /** 关闭指定工具的熔断器并重置失败次数。 */
  public close(toolName: string): void {
    this.failureCounts.set(toolName, 0);
    this.openTimestamps.delete(toolName);
    this.halfOpenProbes.delete(toolName);
  }

  /** 返回指定工具的当前状态和剩余恢复时间。 */
  public getStatus(toolName: string): CircuitStatus {
    const failures = this.failureCounts.get(toolName) ?? 0;
    const openAt = this.openTimestamps.get(toolName);
    if (openAt === undefined) return { state: 'closed', failure_count: failures };

    const elapsed = this.now() - openAt;
    const remaining = Math.max(0, this.recoveryTimeoutSeconds - elapsed / 1000);
    if (elapsed > this.recoveryTimeoutSeconds * 1000) {
      return {
        state: 'half-open',
        failure_count: failures,
        open_since: openAt / 1000,
        recover_in_seconds: 0
      };
    }
    return {
      state: 'open',
      failure_count: failures,
      open_since: openAt / 1000,
      recover_in_seconds: Math.trunc(remaining)
    };
  }

  /** 返回所有有记录活动的工具状态快照。 */
  public getAllStatus(): Record<string, CircuitStatus> {
    const names = new Set([...this.failureCounts.keys(), ...this.openTimestamps.keys()]);
    return Object.fromEntries([...names].map((name) => [name, this.getStatus(name)]));
  }

  private onFailure(toolName: string): void {
    const failures = (this.failureCounts.get(toolName) ?? 0) + 1;
    this.failureCounts.set(toolName, failures);
    if (failures >= this.failureThreshold) {
      this.openTimestamps.set(toolName, this.now());
      this.halfOpenProbes.delete(toolName);
    }
  }

  private onSuccess(toolName: string): void {
    this.close(toolName);
  }
}
