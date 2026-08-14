import { ToolStatus } from './response.js';
import type { ToolResponse } from './response.js';

/** Per-tool circuit state. `half-open` permits one recovery probe. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Snapshot of failures and recovery timing for one tool. */
export interface CircuitStatus {
  readonly state: CircuitState;
  readonly failure_count: number;
  readonly open_since?: number;
  readonly recover_in_seconds?: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. */
  readonly failureThreshold?: number;
  /** Seconds an open circuit remains blocked before a probe. */
  readonly recoveryTimeoutSeconds?: number;
  /** Disables blocking while retaining the same recording API. */
  readonly enabled?: boolean;
  /** Monotonic millisecond clock; injectable for deterministic tests. */
  readonly now?: () => number;
}

function validateNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

/**
 * Per-tool circuit breaker. The upstream Python/Go implementations recover
 * directly to closed; TypeScript makes the recovery probe explicit as
 * `half-open` so only one call may test the recovered tool at a time.
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

  /** Returns whether a tool is currently blocked, without consuming a recovery probe. */
  public isOpen(toolName: string): boolean {
    if (!this.enabled) return false;
    const openAt = this.openTimestamps.get(toolName);
    if (openAt === undefined) return false;
    return this.now() - openAt <= this.recoveryTimeoutSeconds * 1000;
  }

  /**
   * Returns whether one execution is allowed. After timeout, precisely one
   * execution consumes the half-open probe; its result must be recorded.
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

  /** Records a response and updates failure/open state. */
  public recordResult(toolName: string, response: ToolResponse): void {
    if (!this.enabled) return;
    if (response.status === ToolStatus.ERROR) this.onFailure(toolName);
    else this.onSuccess(toolName);
  }

  /** Opens a tool circuit immediately. */
  public open(toolName: string): void {
    if (!this.enabled) return;
    this.openTimestamps.set(toolName, this.now());
    this.halfOpenProbes.delete(toolName);
  }

  /** Closes a tool circuit and resets its failure count. */
  public close(toolName: string): void {
    this.failureCounts.set(toolName, 0);
    this.openTimestamps.delete(toolName);
    this.halfOpenProbes.delete(toolName);
  }

  /** Returns current state and remaining recovery time for one tool. */
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

  /** Returns status snapshots for every tool with recorded activity. */
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
