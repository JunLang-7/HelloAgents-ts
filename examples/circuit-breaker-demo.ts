import { CircuitBreaker, ToolRegistry } from '@junlang-7/helloagents';
import { z } from 'zod';
import { heading } from './_shared.js';

heading('circuit breaker');
const breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutSeconds: 1 });
const tools = new ToolRegistry({ circuitBreaker: breaker });
tools.registerFunction({
  name: 'unstable',
  description: 'Always fails for the demo',
  inputSchema: z.object({}).strict(),
  handler: () => {
    throw new Error('simulated failure');
  }
});
await tools.execute('unstable', {});
await tools.execute('unstable', {});
console.log(breaker.getStatus('unstable'));
