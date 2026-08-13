# Logging system guide

HelloAgents keeps model-facing tool responses separate from runtime tracing.
Use `TraceLogger` for structured JSONL and an HTML report:

```ts
import { TraceLogger } from '@junlang-7/helloagents';

const trace = await TraceLogger.create({ outputDir: './memory/traces', sanitize: true });
await trace.logEvent('decision', { message: 'Using the cached session.' });
await trace.finalize();
```

Tracing sanitizes API keys, bearer tokens, home paths, and raw provider payloads
by default. `ToolResponse` remains the protocol returned to the model; do not
use console logging as a substitute for either contract.
