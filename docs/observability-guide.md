# Observability guide

Attach trace hooks to an agent so lifecycle events and tool calls are recorded:

```ts
import { SimpleAgent, TraceLogger } from '@junlang-7/helloagents';

const trace = await TraceLogger.create({ outputDir: './traces' });
try {
  const agent = new SimpleAgent({ name: 'observed', llm, traceLogger: trace });
  await agent.run('Inspect the current state.');
} finally {
  await trace.finalize();
}
```

`TraceLogger.computeStats()` reports steps, model calls, tool calls, errors, and
duration. Always finalize in a `finally` block for long-running processes;
finalization is idempotent.
