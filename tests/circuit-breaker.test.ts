import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  FunctionTool,
  ToolErrorCode,
  ToolRegistry,
  ToolResponse,
  CircuitBreaker
} from '../hello_agents/index.js';

function mutableClock(initialMs = 0): {
  now: () => number;
  advance: (milliseconds: number) => void;
} {
  let current = initialMs;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    }
  };
}

describe('CircuitBreaker', () => {
  test('opens after consecutive errors and treats success and partial results as recovery', () => {
    const clock = mutableClock();
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      recoveryTimeoutSeconds: 300,
      now: clock.now
    });

    breaker.recordResult('tool', ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, 'failed'));
    breaker.recordResult('tool', ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, 'failed'));
    expect(breaker.getStatus('tool')).toEqual({ state: 'closed', failure_count: 2 });
    breaker.recordResult('tool', ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, 'failed'));
    expect(breaker.isOpen('tool')).toBe(true);
    expect(breaker.getStatus('tool')).toEqual({
      state: 'open',
      failure_count: 3,
      open_since: 0,
      recover_in_seconds: 300
    });

    breaker.close('tool');
    breaker.recordResult('tool', ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, 'failed'));
    breaker.recordResult('tool', ToolResponse.partial('usable result'));
    expect(breaker.getStatus('tool')).toEqual({ state: 'closed', failure_count: 0 });
  });

  test('uses a single half-open probe after recovery and closes or reopens deterministically', () => {
    const clock = mutableClock(1_000);
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeoutSeconds: 5,
      now: clock.now
    });
    breaker.recordResult('tool', ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, 'failed'));
    breaker.recordResult('tool', ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, 'failed'));

    clock.advance(5_001);
    expect(breaker.canExecute('tool')).toBe(true);
    expect(breaker.getStatus('tool').state).toBe('half-open');
    expect(breaker.canExecute('tool')).toBe(false);
    breaker.recordResult('tool', ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, 'probe failed'));
    expect(breaker.getStatus('tool')).toMatchObject({ state: 'open', failure_count: 3 });

    clock.advance(5_001);
    expect(breaker.canExecute('tool')).toBe(true);
    breaker.recordResult('tool', ToolResponse.success('probe succeeded'));
    expect(breaker.getStatus('tool')).toEqual({ state: 'closed', failure_count: 0 });
  });

  test('preserves disabled behavior and supports manual status/reset APIs', () => {
    const breaker = new CircuitBreaker({ enabled: false });
    breaker.open('tool');
    breaker.recordResult('tool', ToolResponse.error(ToolErrorCode.EXECUTION_ERROR, 'failed'));
    expect(breaker.isOpen('tool')).toBe(false);
    expect(breaker.getAllStatus()).toEqual({});

    const enabled = new CircuitBreaker({ now: () => 42 });
    enabled.open('tool');
    expect(enabled.getAllStatus().tool).toMatchObject({ state: 'open', open_since: 0.042 });
    enabled.close('tool');
    expect(enabled.getAllStatus().tool).toEqual({ state: 'closed', failure_count: 0 });
  });
});

describe('ToolRegistry circuit-breaker integration', () => {
  test('blocks an open tool with the standard response, then records a half-open probe result', async () => {
    const clock = mutableClock();
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeoutSeconds: 1,
      now: clock.now
    });
    const registry = new ToolRegistry({ circuitBreaker: breaker });
    let attempts = 0;
    registry.registerFunction(
      new FunctionTool({
        name: 'flaky',
        description: 'Fails until asked to recover.',
        inputSchema: z.object({ input: z.string() }).strict(),
        handler: () => {
          attempts += 1;
          throw new Error('failed');
        }
      })
    );

    expect((await registry.execute('flaky', { input: 'x' })).errorInfo?.code).toBe(
      ToolErrorCode.EXECUTION_ERROR
    );
    expect((await registry.execute('flaky', { input: 'x' })).errorInfo?.code).toBe(
      ToolErrorCode.EXECUTION_ERROR
    );
    const blocked = await registry.execute('flaky', { input: 'x' });
    expect(blocked.errorInfo?.code).toBe(ToolErrorCode.CIRCUIT_OPEN);
    expect(blocked.context).toMatchObject({
      tool_name: 'flaky',
      circuit_status: { state: 'open' }
    });
    expect(attempts).toBe(2);

    clock.advance(1_001);
    expect((await registry.execute('flaky', { input: 'x' })).errorInfo?.code).toBe(
      ToolErrorCode.EXECUTION_ERROR
    );
    expect(attempts).toBe(3);
  });
});
