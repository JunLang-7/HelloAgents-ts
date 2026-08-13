# Session persistence guide

Configure a `SessionStore` and pass it to the base `Agent` implementation:

```ts
import { Message, SessionStore } from '@junlang-7/helloagents';

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
