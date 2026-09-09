# Session persistence guide

Configure a `SessionStore` and pass it to the base `Agent` implementation:

```ts
// 1.x-only capability — not exported from the teaching entrypoint (#81).
import { Message } from '../hello_agents/index.js';
import { SessionStore } from '../hello_agents/core/session-store.js';

const sessions = new SessionStore({ sessionDir: './memory/sessions' });
const path = await sessions.save({
  sessionName: 'demo',
  agentConfig: { name: 'assistant', llm_model: 'test-model' },
  history: [new Message('Remember this answer.', 'user')],
  toolSchemaHash: 'ts-demo',
  readCache: {},
  metadata: {}
});
const restored = await sessions.load(path);
console.log(restored.history.map((message) => message.toText()));
```

Writes are atomic and persisted payloads are schema-validated. Configuration and
tool-schema mismatches are reported as warnings so callers can decide whether
to continue or start a fresh session.
