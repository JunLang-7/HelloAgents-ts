# Circuit breaker guide

`CircuitBreaker` tracks failures per tool. The registry uses it automatically:

```ts
import { CircuitBreaker, ToolRegistry } from '@junlang-7/helloagents';

const breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutSeconds: 30 });
const tools = new ToolRegistry({ circuitBreaker: breaker });
// register tools, then execute them through tools.execute(name, input)
console.log(breaker.getStatus('Search'));
```

An error response increments the failure count. Once the threshold is reached,
calls return `CIRCUIT_OPEN`. After the recovery timeout, `getStatus` reports
`half-open`; exactly one probe is allowed. Record a success to close it or an
error to reopen it. Use `enabled: false` for deterministic local development.
